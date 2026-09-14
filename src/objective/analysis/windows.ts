import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import { expandAcceptedPacket } from "./converters.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisInputGapEvent,
  AnalysisModality,
  AnalysisPpgSample,
  AnalysisTempSample,
  AnalysisWindow,
  AnalysisWindowMetadata,
  AnalysisWindowSamples,
  DiscardedOutOfOrderSample,
  PacketGapEvent,
  PacketMetadata,
  SampleGapEvent,
} from "./types.js";

export const WINDOW_DURATION_MS = 10_000;
export const WINDOW_STEP_MS = 1_000;
export const SAMPLE_RETENTION_MS = 15_000;

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
 * A small monotonic array with a head index. The analysis workload is short
 * lived and bounded, so a direct structure is easier to inspect than a ring
 * buffer while retaining bounded memory after pruning.
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

type BufferMap = {
  ecg: SampleBuffer<AnalysisEcgSample>;
  ppg: SampleBuffer<AnalysisPpgSample>;
  gsr: SampleBuffer<AnalysisGsrSample>;
  imu: SampleBuffer<AnalysisImuSample>;
  temperature: SampleBuffer<AnalysisTempSample>;
};

function emptyBuffers(): BufferMap {
  return {
    ecg: new SampleBuffer<AnalysisEcgSample>(),
    ppg: new SampleBuffer<AnalysisPpgSample>(),
    gsr: new SampleBuffer<AnalysisGsrSample>(),
    imu: new SampleBuffer<AnalysisImuSample>(),
    temperature: new SampleBuffer<AnalysisTempSample>(),
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

function key(sessionId: string, epochId: string): string {
  return JSON.stringify([sessionId, epochId]);
}

export class AnalysisWindowEngine {
  private sessionId: string | null = null;
  private epochId: string | null = null;
  private espAnchorUs: number | null = null;
  private nextWindowEndMs = WINDOW_DURATION_MS;
  private latestSampleMs = -Infinity;
  private previousPacket: PacketMetadata | null = null;
  private buffers = emptyBuffers();
  private packetMetadata: PacketMetadata[] = [];
  private packetGapEvents: PacketGapEvent[] = [];
  private sampleGapEvents: SampleGapEvent[] = [];
  private analysisInputGapEvents: AnalysisInputGapEvent[] = [];
  private discardedOutOfOrderSamples: DiscardedOutOfOrderSample[] = [];
  private readonly pendingInputGaps: PendingInputGap[] = [];

  ingestPacket(packet: AcceptedObjectivePacket): AnalysisWindow[] {
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
    this.packetMetadata.push(metadata);
    this.previousPacket = metadata;

    const expanded = expandAcceptedPacket(packet);
    this.appendSamples("ecg", expanded.ecg);
    this.appendSamples("ppg", expanded.ppg);
    this.appendSamples("gsr", expanded.gsr);
    this.appendSamples("imu", expanded.imu);
    this.appendSamples("temperature", expanded.temperature);

    const windows: AnalysisWindow[] = [];
    while (this.latestSampleMs >= this.nextWindowEndMs) {
      const endMs = this.nextWindowEndMs;
      const startMs = endMs - WINDOW_DURATION_MS;
      windows.push(this.createWindow(startMs, endMs));
      this.nextWindowEndMs += WINDOW_STEP_MS;
    }

    this.pruneMetadata();
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
    this.previousPacket = null;
    this.buffers = emptyBuffers();
    this.packetMetadata = [];
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

  private ensureEpoch(packet: AcceptedObjectivePacket): void {
    const isNewEpoch =
      this.sessionId !== packet.session_id ||
      this.epochId !== packet.epoch_id ||
      (this.espAnchorUs !== null && this.espAnchorUs !== packet.esp_anchor_us);
    if (isNewEpoch) {
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
  }

  private appendSamples<T extends TimedSample>(
    modality: AnalysisModality,
    samples: readonly T[],
  ): void {
    const buffer = this.buffers[modality] as unknown as SampleBuffer<T>;
    const lastTimeMs = buffer.latestTimeMs();
    for (const sample of samples) {
      if (lastTimeMs !== null && sample.sampleTimeMs < lastTimeMs) {
        this.discardedOutOfOrderSamples.push({ modality, sampleTimeMs: sample.sampleTimeMs });
        continue;
      }

      const currentLastTimeMs = buffer.latestTimeMs();
      if (currentLastTimeMs !== null) {
        const gapMs = sample.sampleTimeMs - currentLastTimeMs;
        if (gapMs > LARGE_GAP_MS[modality]) {
          this.sampleGapEvents.push({
            modality,
            startMs: currentLastTimeMs,
            endMs: sample.sampleTimeMs,
            gapMs,
          });
        }
      }

      if (buffer.append(sample)) {
        this.latestSampleMs = Math.max(this.latestSampleMs, sample.sampleTimeMs);
      } else {
        this.discardedOutOfOrderSamples.push({ modality, sampleTimeMs: sample.sampleTimeMs });
      }
    }
  }

  private createWindow(startMs: number, endMs: number): AnalysisWindow {
    const window: AnalysisWindow = {
      sessionId: this.sessionId!,
      epochId: this.epochId!,
      espAnchorUs: this.espAnchorUs!,
      window: {
        start_us: this.espAnchorUs! + startMs * 1_000,
        end_us: this.espAnchorUs! + endMs * 1_000,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: 10_000,
      },
      samples: {
        ecg: [...this.buffers.ecg.range(startMs, endMs)],
        ppg: [...this.buffers.ppg.range(startMs, endMs)],
        gsr: [...this.buffers.gsr.range(startMs, endMs)],
        imu: [...this.buffers.imu.range(startMs, endMs)],
        temperature: [...this.buffers.temperature.range(startMs, endMs)],
      } satisfies AnalysisWindowSamples,
      metadata: this.windowMetadata(startMs, endMs),
    };
    return window;
  }

  private windowMetadata(startMs: number, endMs: number): AnalysisWindowMetadata {
    return {
      packetMetadata: this.packetMetadata
        .filter((packet) => intersects(packet.start_ms, packet.end_ms, startMs, endMs))
        .map((packet) => ({ ...packet })),
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

  private pruneMetadata(): void {
    if (!Number.isFinite(this.latestSampleMs)) {
      return;
    }
    const cutoffMs = this.latestSampleMs - SAMPLE_RETENTION_MS;
    this.buffers.ecg.pruneBefore(cutoffMs);
    this.buffers.ppg.pruneBefore(cutoffMs);
    this.buffers.gsr.pruneBefore(cutoffMs);
    this.buffers.imu.pruneBefore(cutoffMs);
    this.buffers.temperature.pruneBefore(cutoffMs);
    this.packetMetadata = this.packetMetadata.filter((packet) => packet.end_ms >= cutoffMs);
    this.packetGapEvents = this.packetGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.sampleGapEvents = this.sampleGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.analysisInputGapEvents = this.analysisInputGapEvents.filter((event) => event.endMs >= cutoffMs);
    this.discardedOutOfOrderSamples = this.discardedOutOfOrderSamples.filter(
      (event) => event.sampleTimeMs >= cutoffMs,
    );
  }
}
