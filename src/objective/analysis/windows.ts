import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import { expandAcceptedPacket } from "./converters.js";
import type {
  AnyAnalysisSample,
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisInputGapEvent,
  AnalysisModality,
  AnalysisPpgSample,
  AnalysisTempSample,
  AnalysisWindow,
  AnalysisWindowContextSamples,
  AnalysisWindowMetadata,
  AnalysisWindowSamples,
  DiscardedOutOfOrderSample,
  ExpandedAnalysisSamples,
  PacketGapEvent,
  PacketMetadata,
  SampleGapEvent,
} from "./types.js";

export const WINDOW_DURATION_MS = 10_000;
export const WINDOW_STEP_MS = 10_000;
export const SAMPLE_RETENTION_MS = 15_000;
export const DETECTOR_CONTEXT_MS = 2_000;

export const LARGE_GAP_MS: Record<AnalysisModality, number> = {
  ecg: 12,
  ppg: 25,
  gsr: 20,
  imu: 25,
  temperature: 1_500,
};

export interface TimedSample {
  sampleTimeMs: number;
}

/**
 * A small monotonic array with a head index. This remains useful to callers
 * outside the collector and keeps the existing bounded-buffer contract.
 */
export class SampleBuffer<T extends TimedSample> {
  private items: T[] = [];
  private head = 0;
  private lastTimeMs = -Infinity;

  append(sample: T): boolean {
    if (sample.sampleTimeMs < this.lastTimeMs) {
      return false;
    }
    this.items.push(sample);
    this.lastTimeMs = sample.sampleTimeMs;
    return true;
  }

  range(startMs: number, endMs: number): readonly T[] {
    const values: T[] = [];
    for (let index = this.head; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (item.sampleTimeMs >= endMs) {
        break;
      }
      if (item.sampleTimeMs >= startMs) {
        values.push(item);
      }
    }
    return values;
  }

  pruneBefore(cutoffMs: number): void {
    while (this.head < this.items.length && this.items[this.head].sampleTimeMs < cutoffMs) {
      this.head += 1;
    }
    if (this.head > 1_024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.lastTimeMs = -Infinity;
  }

  latestTimeMs(): number | null {
    return Number.isFinite(this.lastTimeMs) ? this.lastTimeMs : null;
  }

  size(): number {
    return this.items.length - this.head;
  }
}

interface PendingInputGap {
  sessionId: string;
  epochId: string;
  event: AnalysisInputGapEvent;
}

type AcceptedSampleIndexes = Record<AnalysisModality, number[]>;

interface BufferedPacket {
  packet: AcceptedObjectivePacket;
  metadata: PacketMetadata;
  acceptedSampleIndexes: AcceptedSampleIndexes;
  expanded: ExpandedAnalysisSamples | null;
}

/**
 * A completed window boundary with the raw packet references needed to
 * materialize its samples later. Collection can therefore remain lightweight;
 * expansion happens only when the serialized analysis worker takes the item.
 */
export interface CompletedAnalysisWindow {
  sessionId: string;
  epochId: string;
  espAnchorUs: number;
  window: AnalysisWindow["window"];
  metadata: AnalysisWindowMetadata;
  completed_at_ms: number;
  materialize(): AnalysisWindow;
}

export interface IncompleteAnalysisTail {
  session_id: string;
  epoch_id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

export interface AnalysisEpochCoverage {
  session_id: string;
  epoch_id: string;
  first_sample_ms: number | null;
  latest_sample_ms: number | null;
}

export interface AnalysisCollectionSnapshot {
  session_id: string;
  epoch_id: string;
  latest_sample_ms: number | null;
  collecting_window_start_ms: number;
  collecting_window_end_ms: number;
  progress_ms: number;
  progress_fraction: number;
  window_duration_ms: number;
}

const MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];

function emptyAcceptedSampleIndexes(): AcceptedSampleIndexes {
  return {
    ecg: [],
    ppg: [],
    gsr: [],
    imu: [],
    temperature: [],
  };
}

function packetMetadata(packet: AcceptedObjectivePacket): PacketMetadata {
  const startMs = packet.plot_t0_ms;
  const endMs = startMs + (packet.raw_packet.t1_us - packet.raw_packet.t0_us) / 1_000;
  return {
    seq: packet.raw_packet.seq,
    sequence_status: packet.sequence_status,
    gap_before: packet.gap_before,
    start_ms: startMs,
    end_ms: endMs,
    truncated: packet.raw_packet.truncated === 1,
  };
}

function intersects(startMs: number, endMs: number, otherStartMs: number, otherEndMs: number): boolean {
  return endMs > otherStartMs && startMs < otherEndMs;
}

function rawSamples(packet: AcceptedObjectivePacket, modality: AnalysisModality): readonly (readonly number[])[] {
  switch (modality) {
    case "ecg":
      return packet.raw_packet.ecg;
    case "ppg":
      return packet.raw_packet.ppg;
    case "gsr":
      return packet.raw_packet.gsr;
    case "imu":
      return packet.raw_packet.imu;
    case "temperature":
      return packet.raw_packet.temp;
  }
}

function rawSampleTimeMs(packet: AcceptedObjectivePacket, sample: readonly number[]): number {
  return packet.plot_t0_ms + sample[0] / 1_000;
}

export class AnalysisWindowEngine {
  private sessionId: string | null = null;
  private epochId: string | null = null;
  private espAnchorUs: number | null = null;
  private nextWindowEndMs = WINDOW_DURATION_MS;
  private latestSampleMs = -Infinity;
  private firstSampleMs = Infinity;
  private latestPacketReceivedAtMs: number | null = null;
  private previousPacket: PacketMetadata | null = null;
  private bufferedPackets: BufferedPacket[] = [];
  private lastSampleTimeByModality: Record<AnalysisModality, number | null> = {
    ecg: null,
    ppg: null,
    gsr: null,
    imu: null,
    temperature: null,
  };
  private packetGapEvents: PacketGapEvent[] = [];
  private sampleGapEvents: SampleGapEvent[] = [];
  private analysisInputGapEvents: AnalysisInputGapEvent[] = [];
  private discardedOutOfOrderSamples: DiscardedOutOfOrderSample[] = [];
  private readonly pendingInputGaps: PendingInputGap[] = [];

  ingestPacket(packet: AcceptedObjectivePacket): AnalysisWindow[] {
    return this.collectPacket(packet).map((window) => window.materialize());
  }

  collectPacket(packet: AcceptedObjectivePacket): CompletedAnalysisWindow[] {
    this.ensureEpoch(packet);

    const metadata = packetMetadata(packet);
    if (packet.sequence_status === "gap" && packet.gap_before > 0) {
      const previous = this.previousPacket;
      const startMs = previous?.end_ms ?? metadata.start_ms;
      this.packetGapEvents.push({
        previousSeq: previous?.seq ?? null,
        nextSeq: metadata.seq,
        missingPackets: packet.gap_before,
        startMs,
        endMs: Math.max(startMs, metadata.start_ms),
      });
    }

    const acceptedSampleIndexes = this.collectSampleMetadata(packet);
    this.bufferedPackets.push({
      packet,
      metadata,
      acceptedSampleIndexes,
      expanded: null,
    });
    this.previousPacket = metadata;
    this.latestPacketReceivedAtMs = packet.received_at_ms;

    const windows: CompletedAnalysisWindow[] = [];
    while (this.latestSampleMs >= this.nextWindowEndMs) {
      const endMs = this.nextWindowEndMs;
      const startMs = endMs - WINDOW_DURATION_MS;
      windows.push(this.createWindowDescriptor(startMs, endMs));
      this.nextWindowEndMs += WINDOW_STEP_MS;
    }

    this.pruneRawRetention();
    return windows;
  }

  recordAnalysisInputGap(
    sessionId: string,
    epochId: string,
    event: AnalysisInputGapEvent,
  ): void {
    if (this.sessionId === sessionId && this.epochId === epochId) {
      this.analysisInputGapEvents.push({ ...event });
      return;
    }
    this.pendingInputGaps.push({ sessionId, epochId, event: { ...event } });
  }

  reset(): void {
    this.sessionId = null;
    this.epochId = null;
    this.espAnchorUs = null;
    this.nextWindowEndMs = WINDOW_DURATION_MS;
    this.latestSampleMs = -Infinity;
    this.firstSampleMs = Infinity;
    this.latestPacketReceivedAtMs = null;
    this.previousPacket = null;
    this.bufferedPackets = [];
    this.lastSampleTimeByModality = {
      ecg: null,
      ppg: null,
      gsr: null,
      imu: null,
      temperature: null,
    };
    this.packetGapEvents = [];
    this.sampleGapEvents = [];
    this.analysisInputGapEvents = [];
    this.discardedOutOfOrderSamples = [];
  }

  getLatestSampleMs(): number | null {
    return Number.isFinite(this.latestSampleMs) ? this.latestSampleMs : null;
  }

  getNextWindowEndMs(): number {
    return this.nextWindowEndMs;
  }

  getCollectionSnapshot(): AnalysisCollectionSnapshot | null {
    if (this.sessionId === null || this.epochId === null) {
      return null;
    }

    const collectingWindowStartMs = this.nextWindowEndMs - WINDOW_DURATION_MS;
    const progressMs = Number.isFinite(this.latestSampleMs)
      ? Math.min(
        WINDOW_DURATION_MS,
        Math.max(0, this.latestSampleMs - collectingWindowStartMs),
      )
      : 0;

    return {
      session_id: this.sessionId,
      epoch_id: this.epochId,
      latest_sample_ms: Number.isFinite(this.latestSampleMs) ? this.latestSampleMs : null,
      collecting_window_start_ms: collectingWindowStartMs,
      collecting_window_end_ms: this.nextWindowEndMs,
      progress_ms: progressMs,
      progress_fraction: progressMs / WINDOW_DURATION_MS,
      window_duration_ms: WINDOW_DURATION_MS,
    };
  }

  getIncompleteTail(): IncompleteAnalysisTail | null {
    if (this.sessionId === null || this.epochId === null || !Number.isFinite(this.latestSampleMs)) {
      return null;
    }
    const startMs = this.nextWindowEndMs - WINDOW_DURATION_MS;
    const durationMs = Math.max(0, this.latestSampleMs - startMs);
    if (durationMs <= 0) {
      return null;
    }
    return {
      session_id: this.sessionId,
      epoch_id: this.epochId,
      start_ms: startMs,
      end_ms: this.latestSampleMs,
      duration_ms: durationMs,
    };
  }

  getEpochCoverage(): AnalysisEpochCoverage | null {
    if (this.sessionId === null || this.epochId === null) {
      return null;
    }
    return {
      session_id: this.sessionId,
      epoch_id: this.epochId,
      first_sample_ms: Number.isFinite(this.firstSampleMs) ? this.firstSampleMs : null,
      latest_sample_ms: Number.isFinite(this.latestSampleMs) ? this.latestSampleMs : null,
    };
  }

  private ensureEpoch(packet: AcceptedObjectivePacket): void {
    const isNewEpoch =
      this.sessionId !== packet.session_id ||
      this.epochId !== packet.epoch_id ||
      (this.espAnchorUs !== null && this.espAnchorUs !== packet.esp_anchor_us);
    if (!isNewEpoch) {
      return;
    }

    this.reset();
    this.sessionId = packet.session_id;
    this.epochId = packet.epoch_id;
    this.espAnchorUs = packet.esp_anchor_us;
    for (let index = this.pendingInputGaps.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingInputGaps[index];
      if (pending.sessionId === packet.session_id && pending.epochId === packet.epoch_id) {
        this.analysisInputGapEvents.unshift(pending.event);
        this.pendingInputGaps.splice(index, 1);
      }
    }
  }

  private collectSampleMetadata(packet: AcceptedObjectivePacket): AcceptedSampleIndexes {
    const accepted = emptyAcceptedSampleIndexes();
    for (const modality of MODALITIES) {
      const samples = rawSamples(packet, modality);
      let lastTimeMs = this.lastSampleTimeByModality[modality];
      for (let index = 0; index < samples.length; index += 1) {
        const sampleTimeMs = rawSampleTimeMs(packet, samples[index]);
        if (lastTimeMs !== null && sampleTimeMs < lastTimeMs) {
          this.discardedOutOfOrderSamples.push({ modality, sampleTimeMs });
          continue;
        }

        if (lastTimeMs !== null) {
          const gapMs = sampleTimeMs - lastTimeMs;
          if (gapMs > LARGE_GAP_MS[modality]) {
            this.sampleGapEvents.push({
              modality,
              startMs: lastTimeMs,
              endMs: sampleTimeMs,
              gapMs,
            });
          }
        }

        accepted[modality].push(index);
        lastTimeMs = sampleTimeMs;
        this.latestSampleMs = Math.max(this.latestSampleMs, sampleTimeMs);
        this.firstSampleMs = Math.min(this.firstSampleMs, sampleTimeMs);
      }
      this.lastSampleTimeByModality[modality] = lastTimeMs;
    }
    return accepted;
  }

  private createWindowDescriptor(startMs: number, endMs: number): CompletedAnalysisWindow {
    const metadata = this.windowMetadata(startMs, endMs);
    const bufferedPackets = this.bufferedPackets.filter((buffered) =>
      intersects(
        buffered.metadata.start_ms,
        buffered.metadata.end_ms,
        startMs - DETECTOR_CONTEXT_MS,
        endMs,
      )
    );
    const sessionId = this.sessionId!;
    const epochId = this.epochId!;
    const espAnchorUs = this.espAnchorUs!;
    const completedAtMs = this.latestPacketReceivedAtMs ?? Date.now();
    let materialized: AnalysisWindow | null = null;
    return {
      sessionId,
      epochId,
      espAnchorUs,
      window: {
        start_us: espAnchorUs + startMs * 1_000,
        end_us: espAnchorUs + endMs * 1_000,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: 10_000,
      },
      metadata,
      completed_at_ms: completedAtMs,
      materialize: () => {
        materialized ??= this.materializeWindow(
          sessionId,
          epochId,
          espAnchorUs,
          startMs,
          endMs,
          metadata,
          completedAtMs,
          bufferedPackets,
        );
        return materialized;
      },
    };
  }

  private materializeWindow(
    sessionId: string,
    epochId: string,
    espAnchorUs: number,
    startMs: number,
    endMs: number,
    metadata: AnalysisWindowMetadata,
    completedAtMs: number,
    bufferedPackets: readonly BufferedPacket[],
  ): AnalysisWindow {
    const samples = {
      ecg: this.samplesFor("ecg", startMs, endMs, bufferedPackets),
      ppg: this.samplesFor("ppg", startMs, endMs, bufferedPackets),
      gsr: this.samplesFor("gsr", startMs, endMs, bufferedPackets),
      imu: this.samplesFor("imu", startMs, endMs, bufferedPackets),
      temperature: this.samplesFor("temperature", startMs, endMs, bufferedPackets),
    } satisfies AnalysisWindowSamples;
    const context_samples: AnalysisWindowContextSamples = {
      ecg: this.samplesFor("ecg", startMs - DETECTOR_CONTEXT_MS, startMs, bufferedPackets),
      ppg: this.samplesFor("ppg", startMs - DETECTOR_CONTEXT_MS, startMs, bufferedPackets),
    };

    return {
      sessionId,
      epochId,
      espAnchorUs,
      window: {
        start_us: espAnchorUs + startMs * 1_000,
        end_us: espAnchorUs + endMs * 1_000,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: 10_000,
      },
      samples,
      context_samples,
      metadata,
      completed_at_ms: completedAtMs,
    };
  }

  private samplesFor(modality: "ecg", startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnalysisEcgSample[];
  private samplesFor(modality: "ppg", startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnalysisPpgSample[];
  private samplesFor(modality: "gsr", startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnalysisGsrSample[];
  private samplesFor(modality: "imu", startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnalysisImuSample[];
  private samplesFor(modality: "temperature", startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnalysisTempSample[];
  private samplesFor(modality: AnalysisModality, startMs: number, endMs: number, bufferedPackets?: readonly BufferedPacket[]): AnyAnalysisSample[];
  private samplesFor(
    modality: AnalysisModality,
    startMs: number,
    endMs: number,
    bufferedPackets = this.bufferedPackets,
  ): AnyAnalysisSample[] {
    const values: AnyAnalysisSample[] = [];
    for (const buffered of bufferedPackets) {
      if (!intersects(buffered.metadata.start_ms, buffered.metadata.end_ms, startMs, endMs)) {
        continue;
      }
      const expanded = buffered.expanded ?? expandAcceptedPacket(buffered.packet);
      buffered.expanded = expanded;
      const acceptedIndexes = new Set(buffered.acceptedSampleIndexes[modality]);
      for (let index = 0; index < expanded[modality].length; index += 1) {
        const sample = expanded[modality][index];
        if (
          acceptedIndexes.has(index) &&
          sample.sampleTimeMs >= startMs &&
          sample.sampleTimeMs < endMs
        ) {
          values.push(sample);
        }
      }
    }
    return values;
  }

  private windowMetadata(startMs: number, endMs: number): AnalysisWindowMetadata {
    return {
      packetMetadata: this.bufferedPackets
        .filter((buffered) => intersects(buffered.metadata.start_ms, buffered.metadata.end_ms, startMs, endMs))
        .map((buffered) => ({ ...buffered.metadata })),
      packetGapEvents: this.packetGapEvents
        .filter((event) => intersects(event.startMs, event.endMs, startMs, endMs))
        .map((event) => ({ ...event })),
      sampleGapEvents: this.sampleGapEvents
        .filter((event) => intersects(event.startMs, event.endMs, startMs, endMs))
        .map((event) => ({ ...event })),
      analysisInputGapEvents: this.analysisInputGapEvents
        .filter((event) => intersects(event.startMs, event.endMs, startMs, endMs))
        .map((event) => ({ ...event })),
      discardedOutOfOrderSamples: this.discardedOutOfOrderSamples
        .filter((event) => event.sampleTimeMs >= startMs && event.sampleTimeMs < endMs)
        .map((event) => ({ ...event })),
    };
  }

  private pruneRawRetention(): void {
    if (!Number.isFinite(this.latestSampleMs)) {
      return;
    }
    const cutoffMs = this.latestSampleMs - SAMPLE_RETENTION_MS;
    this.bufferedPackets = this.bufferedPackets.filter((buffered) => buffered.metadata.end_ms >= cutoffMs);
    this.packetGapEvents = this.packetGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.sampleGapEvents = this.sampleGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.analysisInputGapEvents = this.analysisInputGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.discardedOutOfOrderSamples = this.discardedOutOfOrderSamples.filter(
      (event) => event.sampleTimeMs >= cutoffMs,
    );
  }
}
