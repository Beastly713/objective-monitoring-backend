import type { Pool } from "pg";

import type { SchemaV1Packet } from "../packetValidator.js";

export const DEFAULT_REPLAY_DURATION_MS = 30_000;
export const MAX_REPLAY_DURATION_MS = 60_000;
export const MAX_REPLAY_PACKETS = 1_000;

export type ReplayBoundaryType = "session_start" | "device_reboot" | "time_epoch";

export interface ReplayGap {
  type: "ingestion" | "history";
  replay_ms: number;
  missing_packets: number;
  boot_id: string;
  seq: number;
}

export interface ReplaySegment {
  boot_id: string;
  epoch_id: string;
  boundary_type: ReplayBoundaryType;
  start_replay_ms: number;
  end_replay_ms: number;
  packet_count: number;
  first_seq: number;
  last_seq: number;
}

export interface ReplayTimelineManifest {
  origin_wall_ms: number | null;
  duration_ms: number;
  packet_count: number;
  ingestion_gap_events: number;
  ingestion_missing_packets: number;
  history_gap_events: number;
  history_missing_packets: number;
  truncated_packets: number;
  boot_count: number;
  epoch_count: number;
  first_received_at_ms: number | null;
  last_received_at_ms: number | null;
  gaps: ReplayGap[];
  segments: ReplaySegment[];
}

export interface HistoricalPacketEnvelope {
  session_id: string;
  boot_id: string;
  seq: number;
  received_at_ms: number;
  sequence_status: "first" | "normal" | "gap";
  gap_before: number;
  history_gap_before: number;
  epoch_id: string;
  esp_anchor_us: number;
  backend_anchor_ms: number;
  plot_t0_ms: number;
  replay_t0_ms: number;
  raw_packet: SchemaV1Packet;
}

export interface ReplayPacketWindow {
  window: {
    from_ms: number;
    duration_ms: number;
    to_ms: number;
    packet_count: number;
    available_packet_count: number;
    packet_cap: number;
    capped: boolean;
  };
  packets: HistoricalPacketEnvelope[];
}

interface AnnotatedPacketRow {
  session_id: string;
  boot_id: string;
  seq: string | number;
  received_at_ms: string | number;
  sequence_status: "first" | "normal" | "gap";
  gap_before: string | number;
  history_gap_before: string | number;
  epoch_id: string;
  esp_anchor_us: string | number;
  backend_anchor_ms: string | number;
  plot_t0_ms: string | number;
  packet_effective_wall_ms: string | number;
  timeline_origin_wall_ms: string | number;
  replay_t0_ms: string | number;
  packet_end_replay_ms: string | number;
  truncated: string | number;
}

interface HistoricalPacketRow extends AnnotatedPacketRow {
  raw_packet: SchemaV1Packet;
  available_packet_count: string | number;
}

const ANNOTATED_PACKETS_CTE = `
WITH session_packets AS (
  SELECT
    session_id,
    boot_id,
    seq,
    received_at_ms,
    sequence_status,
    gap_before,
    epoch_id,
    esp_anchor_us,
    backend_anchor_ms,
    plot_t0_ms,
    raw_packet,
    backend_anchor_ms::double precision + plot_t0_ms AS packet_effective_wall_ms,
    ((raw_packet->>'t1_us')::double precision - (raw_packet->>'t0_us')::double precision) / 1000
      AS packet_span_ms,
    lag(seq) OVER (
      PARTITION BY session_id, boot_id
      ORDER BY seq
    ) AS previous_persisted_seq
  FROM objective_packets
  WHERE session_id = $1
),
gap_annotated AS (
  SELECT
    *,
    CASE
      WHEN previous_persisted_seq IS NULL THEN 0
      ELSE greatest(0, seq - previous_persisted_seq - 1 - gap_before)
    END AS history_gap_before,
    min(packet_effective_wall_ms) OVER () AS timeline_origin_wall_ms
  FROM session_packets
),
replay_positioned AS (
  SELECT
    *,
    packet_effective_wall_ms - timeline_origin_wall_ms AS replay_t0_ms,
    packet_effective_wall_ms - timeline_origin_wall_ms + packet_span_ms AS packet_end_replay_ms
  FROM gap_annotated
)`;

function numberValue(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export class ObjectiveHistoryRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async getManifest(sessionId: string): Promise<ReplayTimelineManifest> {
    const result = await this.pool.query<AnnotatedPacketRow>(
      `${ANNOTATED_PACKETS_CTE}
       SELECT
         session_id,
         boot_id,
         seq,
         received_at_ms,
         sequence_status,
         gap_before,
         history_gap_before,
         epoch_id,
         esp_anchor_us,
         backend_anchor_ms,
         plot_t0_ms,
         packet_effective_wall_ms,
         timeline_origin_wall_ms,
         replay_t0_ms,
         packet_end_replay_ms,
         (raw_packet->>'truncated')::integer AS truncated
       FROM replay_positioned
       ORDER BY packet_effective_wall_ms, received_at_ms, boot_id, seq`,
      [sessionId],
    );

    if (result.rows.length === 0) {
      return {
        origin_wall_ms: null,
        duration_ms: 0,
        packet_count: 0,
        ingestion_gap_events: 0,
        ingestion_missing_packets: 0,
        history_gap_events: 0,
        history_missing_packets: 0,
        truncated_packets: 0,
        boot_count: 0,
        epoch_count: 0,
        first_received_at_ms: null,
        last_received_at_ms: null,
        gaps: [],
        segments: [],
      };
    }

    const gaps: ReplayGap[] = [];
    const segments: ReplaySegment[] = [];
    const bootIds = new Set<string>();
    const epochIds = new Set<string>();
    let ingestionMissingPackets = 0;
    let historyMissingPackets = 0;
    let truncatedPackets = 0;
    let firstReceivedAtMs = Number.POSITIVE_INFINITY;
    let lastReceivedAtMs = Number.NEGATIVE_INFINITY;
    let durationMs = 0;

    for (const row of result.rows) {
      const seq = numberValue(row.seq);
      const replayMs = numberValue(row.replay_t0_ms);
      const packetEndReplayMs = numberValue(row.packet_end_replay_ms);
      const gapBefore = numberValue(row.gap_before);
      const historyGapBefore = numberValue(row.history_gap_before);
      const receivedAtMs = numberValue(row.received_at_ms);

      bootIds.add(row.boot_id);
      epochIds.add(row.epoch_id);
      firstReceivedAtMs = Math.min(firstReceivedAtMs, receivedAtMs);
      lastReceivedAtMs = Math.max(lastReceivedAtMs, receivedAtMs);
      durationMs = Math.max(durationMs, packetEndReplayMs);
      truncatedPackets += numberValue(row.truncated) === 1 ? 1 : 0;

      if (gapBefore > 0 || row.sequence_status === "gap") {
        ingestionMissingPackets += gapBefore;
        gaps.push({
          type: "ingestion",
          replay_ms: replayMs,
          missing_packets: gapBefore,
          boot_id: row.boot_id,
          seq,
        });
      }
      if (historyGapBefore > 0) {
        historyMissingPackets += historyGapBefore;
        gaps.push({
          type: "history",
          replay_ms: replayMs,
          missing_packets: historyGapBefore,
          boot_id: row.boot_id,
          seq,
        });
      }

      const previousSegment = segments.at(-1);
      if (
        previousSegment === undefined ||
        previousSegment.boot_id !== row.boot_id ||
        previousSegment.epoch_id !== row.epoch_id
      ) {
        const boundaryType: ReplayBoundaryType = previousSegment === undefined
          ? "session_start"
          : previousSegment.boot_id !== row.boot_id
            ? "device_reboot"
            : "time_epoch";
        segments.push({
          boot_id: row.boot_id,
          epoch_id: row.epoch_id,
          boundary_type: boundaryType,
          start_replay_ms: replayMs,
          end_replay_ms: packetEndReplayMs,
          packet_count: 1,
          first_seq: seq,
          last_seq: seq,
        });
      } else {
        previousSegment.end_replay_ms = Math.max(previousSegment.end_replay_ms, packetEndReplayMs);
        previousSegment.packet_count += 1;
        previousSegment.last_seq = seq;
      }
    }

    return {
      origin_wall_ms: numberValue(result.rows[0].timeline_origin_wall_ms),
      duration_ms: durationMs,
      packet_count: result.rows.length,
      ingestion_gap_events: gaps.filter((gap) => gap.type === "ingestion").length,
      ingestion_missing_packets: ingestionMissingPackets,
      history_gap_events: gaps.filter((gap) => gap.type === "history").length,
      history_missing_packets: historyMissingPackets,
      truncated_packets: truncatedPackets,
      boot_count: bootIds.size,
      epoch_count: epochIds.size,
      first_received_at_ms: firstReceivedAtMs,
      last_received_at_ms: lastReceivedAtMs,
      gaps,
      segments,
    };
  }

  async getPacketWindow(
    sessionId: string,
    fromMs: number,
    durationMs: number,
  ): Promise<ReplayPacketWindow> {
    const result = await this.pool.query<HistoricalPacketRow>(
      `${ANNOTATED_PACKETS_CTE},
       windowed AS (
         SELECT *, count(*) OVER () AS available_packet_count
         FROM replay_positioned
         WHERE packet_end_replay_ms >= $2
           AND replay_t0_ms < $2 + $3
       )
       SELECT
         session_id,
         boot_id,
         seq,
         received_at_ms,
         sequence_status,
         gap_before,
         history_gap_before,
         epoch_id,
         esp_anchor_us,
         backend_anchor_ms,
         plot_t0_ms,
         packet_effective_wall_ms,
         timeline_origin_wall_ms,
         replay_t0_ms,
         packet_end_replay_ms,
         (raw_packet->>'truncated')::integer AS truncated,
         raw_packet,
         available_packet_count
       FROM windowed
       ORDER BY packet_effective_wall_ms, received_at_ms, boot_id, seq
       LIMIT $4`,
      [sessionId, fromMs, durationMs, MAX_REPLAY_PACKETS],
    );

    const boundedRows = result.rows.slice(0, MAX_REPLAY_PACKETS);
    const packets = boundedRows.map<HistoricalPacketEnvelope>((row) => ({
      session_id: row.session_id,
      boot_id: row.boot_id,
      seq: numberValue(row.seq),
      received_at_ms: numberValue(row.received_at_ms),
      sequence_status: row.sequence_status,
      gap_before: numberValue(row.gap_before),
      history_gap_before: numberValue(row.history_gap_before),
      epoch_id: row.epoch_id,
      esp_anchor_us: numberValue(row.esp_anchor_us),
      backend_anchor_ms: numberValue(row.backend_anchor_ms),
      plot_t0_ms: numberValue(row.plot_t0_ms),
      replay_t0_ms: numberValue(row.replay_t0_ms),
      raw_packet: row.raw_packet,
    }));
    const availablePacketCount = boundedRows[0] === undefined
      ? 0
      : numberValue(boundedRows[0].available_packet_count);

    return {
      window: {
        from_ms: fromMs,
        duration_ms: durationMs,
        to_ms: fromMs + durationMs,
        packet_count: packets.length,
        available_packet_count: availablePacketCount,
        packet_cap: MAX_REPLAY_PACKETS,
        capped: availablePacketCount > packets.length,
      },
      packets,
    };
  }
}
