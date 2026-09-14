import type { AcceptedObjectivePacket, AcceptedPacketBus } from "../acceptedPacketBus.js";
import { BaselineState, type BaselineObservation } from "./baseline.js";
import {
  expandAcceptedPacket,
} from "./converters.js";
import {
  baselineRelation,
  calculateGsrFeatures,
  calculateImuFeatures,
  calculateTemperatureFeatures,
  EcgStreamingDetector,
  PpgStreamingDetector,
} from "./features.js";
import {
  evaluateAllModalityRules,
  firedRuleIds,
  ruleObservations,
  type AllModalityRuleEvaluations,
  type RulePersistenceState,
} from "./rules.js";
import {
  createMultimodalPersistenceState,
  evaluateMultimodalRules,
  type MultimodalPersistenceState,
} from "./multimodalRules.js";
import { evaluateQuality, type QualityEvidence } from "./quality.js";
import {
  ANALYSIS_VERSION,
  CONVERSION_VERSION,
  FEATURE_VERSION,
  RULE_VERSION,
} from "./versions.js";
import { AnalysisResultBus } from "./resultBus.js";
import { AnalysisWindowEngine } from "./windows.js";
import type {
  AnalysisInputGapEvent,
  AnalysisModality,
  AnalysisResult,
  BaselineRelation,
  EcgFeatures,
  GsrFeatures,
  ImuFeatures,
  ModalityFeatureMeta,
  ModalityQuality,
  PpgFeatures,
  TemperatureFeatures,
  AnalysisWindow,
} from "./types.js";

export const ANALYSIS_QUEUE_CAPACITY = 1_000;

export interface AnalysisWorkItem {
  packet: AcceptedObjectivePacket;
}

export class SerializedAnalysisQueue {
  readonly capacity: number;
  private readonly items: AnalysisWorkItem[] = [];
  private closed = false;

  constructor(capacity = ANALYSIS_QUEUE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("analysis queue capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  enqueue(packet: AcceptedObjectivePacket): boolean {
    if (this.closed || this.items.length >= this.capacity) {
      return false;
    }
    this.items.push({ packet });
    return true;
  }

  shift(): AnalysisWorkItem | undefined {
    return this.items.shift();
  }

  getDepth(): number {
    return this.items.length;
  }

  hasSession(sessionId: string): boolean {
    return this.items.some((item) => item.packet.session_id === sessionId);
  }

  close(): void {
    this.closed = true;
  }
}

export interface AnalysisPipelineSnapshot {
  windowsEmitted: number;
  windowsFailed: number;
  packetProcessingFailures: number;
  queueDepth: number;
  queueDrops: number;
  lastWindow: {
    session_id: string | null;
    epoch_id: string | null;
    end_ms: number | null;
  };
  baseline: {
    collection_complete: boolean;
    ready_modalities: AnalysisModality[];
  };
  pipelineHealthy: boolean;
  degraded: boolean;
}

export interface AnalysisPipelineOptions {
  queueCapacity?: number;
}

interface AnalysisState {
  sessionId: string;
  epochId: string;
  deviceId: string;
  bootId: string;
  windowEngine: AnalysisWindowEngine;
  ecgDetector: EcgStreamingDetector;
  ppgDetector: PpgStreamingDetector;
  baseline: BaselineState;
  rules: RulePersistenceState;
  multimodal: MultimodalPersistenceState;
}

type FeatureBundle = {
  ecg: EcgFeatures;
  ppg: PpgFeatures;
  gsr: GsrFeatures;
  imu: ImuFeatures;
  temperature: TemperatureFeatures;
};

type QualityBundle = {
  ecg: ModalityQuality;
  ppg: ModalityQuality;
  gsr: ModalityQuality;
  imu: ModalityQuality;
  temperature: ModalityQuality;
};

const MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];

function stateKey(sessionId: string, epochId: string): string {
  return JSON.stringify([sessionId, epochId]);
}

function packetInterval(packet: AcceptedObjectivePacket): { startMs: number; endMs: number } {
  return {
    startMs: packet.plot_t0_ms,
    endMs: packet.plot_t0_ms + (packet.raw_packet.t1_us - packet.raw_packet.t0_us) / 1_000,
  };
}

function cloneRuleState(state: RulePersistenceState): RulePersistenceState {
  return { consecutiveTrue: { ...state.consecutiveTrue } };
}

function cloneMultimodalState(state: MultimodalPersistenceState): MultimodalPersistenceState {
  return { ...state };
}

function emptyBaseline(): { collection_complete: boolean; ready_modalities: AnalysisModality[] } {
  return { collection_complete: false, ready_modalities: [] };
}

function featureMeta<T extends object>(
  features: T,
  units: Record<keyof T, string>,
  relations: Partial<Record<keyof T, BaselineRelation>> = {},
): Record<keyof T, ModalityFeatureMeta> {
  const result = {} as Record<keyof T, ModalityFeatureMeta>;
  for (const key of Object.keys(features) as Array<keyof T>) {
    const value = features[key];
    const valid = typeof value === "number" ? Number.isFinite(value) : value !== null;
    result[key] = {
      unit: units[key],
      valid,
      baseline: relations[key] ?? null,
    };
  }
  return result;
}

function validNumber(value: number | null): boolean {
  return value !== null && Number.isFinite(value);
}

function baselineObservation(
  modality: AnalysisModality,
  feature: BaselineObservation["feature"],
  value: number | null,
  quality: ModalityQuality,
): BaselineObservation {
  return {
    modality,
    feature,
    value,
    valid: validNumber(value),
    quality: quality.state,
  };
}

function calculateFeatures(
  state: AnalysisState,
  analysisWindow: AnalysisWindow,
  baseline: BaselineState,
): FeatureBundle {
  return {
    ecg: state.ecgDetector.extractFeatures(
      analysisWindow.samples.ecg,
      analysisWindow.window.start_ms,
      analysisWindow.window.end_ms,
    ),
    ppg: state.ppgDetector.extractFeatures(
      analysisWindow.samples.ppg,
      analysisWindow.window.start_ms,
      analysisWindow.window.end_ms,
    ),
    gsr: calculateGsrFeatures(
      analysisWindow.samples.gsr,
      baseline.getReference("gsr"),
    ),
    imu: calculateImuFeatures(
      analysisWindow.samples.imu,
      baseline.getReference("imu"),
    ),
    temperature: calculateTemperatureFeatures(
      analysisWindow.samples.temperature,
      baseline.getReference("temperature"),
    ),
  };
}

function calculateQuality(
  state: AnalysisState,
  analysisWindow: AnalysisWindow,
  features: FeatureBundle,
): QualityBundle {
  const evidence: QualityEvidence = {
    ecgValidRrCount: state.ecgDetector.getValidRrIntervals(
      analysisWindow.window.start_ms,
      analysisWindow.window.end_ms,
    ).length,
    ppgValidIntervalCount: state.ppgDetector.getValidIntervals(
      analysisWindow.window.start_ms,
      analysisWindow.window.end_ms,
    ).length,
  };
  return evaluateQuality(analysisWindow, features, evidence);
}

function baselineObservations(
  features: FeatureBundle,
  quality: QualityBundle,
): BaselineObservation[] {
  return [
    baselineObservation("ecg", "heart_rate_bpm", features.ecg.heart_rate_bpm, quality.ecg),
    baselineObservation("ppg", "pulse_rate_bpm", features.ppg.pulse_rate_bpm, quality.ppg),
    baselineObservation("gsr", "gsr_raw_mean", features.gsr.gsr_raw_mean, quality.gsr),
    baselineObservation("imu", "motion_index_g", features.imu.motion_index_g, quality.imu),
    baselineObservation(
      "temperature",
      "temperature_mean_c",
      features.temperature.temperature_mean_c,
      quality.temperature,
    ),
  ];
}

function modalityRuleEvaluations(
  state: AnalysisState,
  features: FeatureBundle,
  quality: QualityBundle,
  baseline: BaselineState,
): AllModalityRuleEvaluations {
  return evaluateAllModalityRules({
    ecg: {
      quality: quality.ecg,
      features: features.ecg,
      baseline: baseline.getReference("ecg"),
      state: state.rules,
    },
    ppg: {
      quality: quality.ppg,
      features: features.ppg,
      baseline: baseline.getReference("ppg"),
      state: state.rules,
      ecgQuality: quality.ecg,
      ecgFeatures: features.ecg,
    },
    gsr: {
      quality: quality.gsr,
      features: features.gsr,
      baseline: baseline.getReference("gsr"),
      state: state.rules,
    },
    imu: {
      quality: quality.imu,
      features: features.imu,
      baselineReady: baseline.isModalityReady("imu"),
    },
    temperature: {
      quality: quality.temperature,
      features: features.temperature,
      baseline: baseline.getReference("temperature"),
      state: state.rules,
    },
  });
}

function sourceTrace(analysisWindow: AnalysisWindow): AnalysisResult["source"] {
  const packets = analysisWindow.metadata.packetMetadata;
  return {
    first_packet_seq: packets[0]?.seq ?? null,
    last_packet_seq: packets.at(-1)?.seq ?? null,
    packet_count: packets.length,
    packet_gap_count: analysisWindow.metadata.packetGapEvents.length,
    truncated_packet_count: packets.filter((packet) => packet.truncated).length,
    modalities_present: MODALITIES.filter((modality) => analysisWindow.samples[modality].length > 0),
    discarded_out_of_order_samples: analysisWindow.metadata.discardedOutOfOrderSamples.length,
    analysis_input_gap_count: analysisWindow.metadata.analysisInputGapEvents.length,
  };
}

function buildResult(
  state: AnalysisState,
  packet: AcceptedObjectivePacket,
  analysisWindow: AnalysisWindow,
  features: FeatureBundle,
  quality: QualityBundle,
  rules: AllModalityRuleEvaluations,
  multimodalResult: AnalysisResult["multimodal_result"],
  baseline: BaselineState,
): AnalysisResult {
  const ecgBaseline = baseline.getReference("ecg");
  const ppgBaseline = baseline.getReference("ppg");
  const gsrBaseline = baseline.getReference("gsr");
  const imuBaseline = baseline.getReference("imu");
  const temperatureBaseline = baseline.getReference("temperature");

  const modalityResults: AnalysisResult["modality_results"] = {
    ecg: {
      modality: "ecg",
      quality: quality.ecg,
      features: features.ecg,
      feature_meta: featureMeta(
        features.ecg,
        {
          beat_count: "count",
          heart_rate_bpm: "bpm",
          rr_interval_ms: "ms",
          rr_mean_ms: "ms",
          rr_std_ms: "ms",
          ecg_range_adc: "ADC counts",
          lead_off_fraction: "fraction",
        },
        { heart_rate_bpm: baselineRelation(features.ecg.heart_rate_bpm, ecgBaseline, "percent") },
      ),
      observations: ruleObservations(rules.ecg),
      rule_evaluations: rules.ecg,
    },
    ppg: {
      modality: "ppg",
      quality: quality.ppg,
      features: features.ppg,
      feature_meta: featureMeta(
        features.ppg,
        {
          pulse_count: "count",
          pulse_rate_bpm: "bpm",
          pulse_interval_ms: "ms",
          pulse_interval_mean_ms: "ms",
          pulse_interval_std_ms: "ms",
          pulse_amplitude_raw: "ADC/FIFO counts",
          ppg_red_mean: "ADC/FIFO counts",
          ppg_ir_mean: "ADC/FIFO counts",
          ppg_red_std: "ADC/FIFO counts",
          ppg_ir_std: "ADC/FIFO counts",
        },
        { pulse_rate_bpm: baselineRelation(features.ppg.pulse_rate_bpm, ppgBaseline, "percent") },
      ),
      observations: ruleObservations(rules.ppg),
      rule_evaluations: rules.ppg,
    },
    gsr: {
      modality: "gsr",
      quality: quality.gsr,
      features: features.gsr,
      feature_meta: featureMeta(
        features.gsr,
        {
          gsr_raw_mean: "counts",
          gsr_raw_min: "counts",
          gsr_raw_max: "counts",
          gsr_raw_range: "counts",
          gsr_raw_std: "counts",
          gsr_raw_delta_from_baseline: "counts",
          gsr_raw_slope_raw_per_s: "counts/s",
          gsr_robust_z: "z",
        },
        {
          gsr_raw_mean: baselineRelation(features.gsr.gsr_raw_mean, gsrBaseline, "robust"),
          gsr_raw_delta_from_baseline: baselineRelation(
            features.gsr.gsr_raw_delta_from_baseline === null || gsrBaseline === undefined
              ? null
              : features.gsr.gsr_raw_delta_from_baseline + gsrBaseline.median,
            gsrBaseline,
            "delta",
          ),
        },
      ),
      observations: ruleObservations(rules.gsr),
      rule_evaluations: rules.gsr,
    },
    imu: {
      modality: "imu",
      quality: quality.imu,
      features: features.imu,
      feature_meta: featureMeta(
        features.imu,
        {
          acceleration_magnitude_g_mean: "g",
          acceleration_magnitude_g_std: "g",
          motion_index_g: "g",
          gyro_magnitude_dps_mean: "deg/s",
          movement_level: "level",
        },
        { motion_index_g: baselineRelation(features.imu.motion_index_g, imuBaseline, "robust") },
      ),
      observations: ruleObservations(rules.imu),
      rule_evaluations: rules.imu,
    },
    temperature: {
      modality: "temperature",
      quality: quality.temperature,
      features: features.temperature,
      feature_meta: featureMeta(
        features.temperature,
        {
          temperature_mean_c: "degC",
          temperature_min_c: "degC",
          temperature_max_c: "degC",
          temperature_delta_c: "degC",
          temperature_slope_c_per_min: "degC/min",
        },
        {
          temperature_mean_c: baselineRelation(
            features.temperature.temperature_mean_c,
            temperatureBaseline,
            "percent",
          ),
          temperature_delta_c: baselineRelation(
            features.temperature.temperature_delta_c === null || temperatureBaseline === undefined
              ? null
              : features.temperature.temperature_delta_c + temperatureBaseline.median,
            temperatureBaseline,
            "delta",
          ),
        },
      ),
      observations: ruleObservations(rules.temperature),
      rule_evaluations: rules.temperature,
    },
  };

  const modalityRules = firedRuleIds(rules);
  const multimodalRule = multimodalResult.rule_ids.find((ruleId) => ruleId.startsWith("MM-"));
  return {
    type: "analysis_update",
    session_id: packet.session_id,
    device_id: state.deviceId,
    boot_id: packet.boot_id,
    epoch_id: packet.epoch_id,
    analysis_version: ANALYSIS_VERSION,
    conversion_version: CONVERSION_VERSION,
    feature_version: FEATURE_VERSION,
    rule_version: RULE_VERSION,
    created_at_ms: packet.received_at_ms,
    window: { ...analysisWindow.window },
    source: sourceTrace(analysisWindow),
    baseline_ready: baseline.isGlobalReady(),
    baseline: baseline.getSummary(),
    modality_results: modalityResults,
    multimodal_result: multimodalResult,
    rules_triggered: multimodalRule === undefined
      ? modalityRules
      : [...modalityRules, multimodalRule],
  };
}

export class ObjectiveAnalysisPipeline {
  readonly queue: SerializedAnalysisQueue;
  private readonly states = new Map<string, AnalysisState>();
  private readonly activeEpochBySession = new Map<string, string>();
  private readonly pendingInputGaps = new Map<string, AnalysisInputGapEvent[]>();
  private readonly stoppingSessions = new Set<string>();
  private readonly endedSessions = new Set<string>();
  private readonly unsubscribe: () => void;
  private workerScheduled = false;
  private workerRunning = false;
  private processingSessionId: string | null = null;
  private processingWindowStarted = false;
  private stopped = false;
  private windowsEmitted = 0;
  private windowsFailed = 0;
  private packetProcessingFailures = 0;
  private queueDrops = 0;
  private pipelineHealthy = true;
  private lastWindow: AnalysisPipelineSnapshot["lastWindow"] = {
    session_id: null,
    epoch_id: null,
    end_ms: null,
  };
  private lastTouchedState: AnalysisState | null = null;

  constructor(
    acceptedPacketBus: AcceptedPacketBus,
    private readonly resultBus: AnalysisResultBus,
    options: AnalysisPipelineOptions = {},
  ) {
    this.queue = new SerializedAnalysisQueue(options.queueCapacity);
    this.unsubscribe = acceptedPacketBus.subscribe((packet) => this.enqueue(packet));
  }

  getSnapshot(): AnalysisPipelineSnapshot {
    const state = this.lastTouchedState !== null && this.states.has(stateKey(
      this.lastTouchedState.sessionId,
      this.lastTouchedState.epochId,
    ))
      ? this.lastTouchedState
      : [...this.states.values()].at(-1) ?? null;
    const baseline = state?.baseline.getSummary() ?? emptyBaseline();
    return {
      windowsEmitted: this.windowsEmitted,
      windowsFailed: this.windowsFailed,
      packetProcessingFailures: this.packetProcessingFailures,
      queueDepth: this.queue.getDepth(),
      queueDrops: this.queueDrops,
      lastWindow: { ...this.lastWindow },
      baseline: {
        collection_complete: baseline.collection_complete,
        ready_modalities: [...baseline.ready_modalities],
      },
      pipelineHealthy: this.pipelineHealthy,
      degraded: !this.pipelineHealthy,
    };
  }

  requestSessionStop(sessionId: string): void {
    if (this.stopped) {
      return;
    }
    this.stoppingSessions.add(sessionId);
    this.maybeFinalizeSession(sessionId);
  }

  close(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.unsubscribe();
    this.queue.close();
    this.states.clear();
    this.activeEpochBySession.clear();
    this.pendingInputGaps.clear();
    this.stoppingSessions.clear();
    this.endedSessions.clear();
    this.lastTouchedState = null;
  }

  private enqueue(packet: AcceptedObjectivePacket): void {
    if (this.stopped) {
      return;
    }
    if (this.endedSessions.has(packet.session_id)) {
      this.queueDrops += 1;
      this.pipelineHealthy = false;
      return;
    }
    if (this.stoppingSessions.has(packet.session_id)) {
      this.recordQueueDrop(packet);
      return;
    }
    if (!this.queue.enqueue(packet)) {
      this.recordQueueDrop(packet);
      return;
    }
    this.scheduleWorker();
  }

  private recordQueueDrop(packet: AcceptedObjectivePacket): void {
    this.queueDrops += 1;
    this.pipelineHealthy = false;
    const key = stateKey(packet.session_id, packet.epoch_id);
    const state = this.states.get(key);
    const interval = packetInterval(packet);
    const event: AnalysisInputGapEvent = {
      seq: packet.raw_packet.seq,
      startMs: interval.startMs,
      endMs: interval.endMs,
    };
    if (state !== undefined) {
      state.windowEngine.recordAnalysisInputGap(packet.session_id, packet.epoch_id, event);
      return;
    }
    const pending = this.pendingInputGaps.get(key) ?? [];
    if (pending.length < ANALYSIS_QUEUE_CAPACITY) {
      pending.push(event);
      this.pendingInputGaps.set(key, pending);
    }
  }

  private scheduleWorker(): void {
    if (this.workerScheduled || this.workerRunning || this.stopped) {
      return;
    }
    this.workerScheduled = true;
    setImmediate(() => {
      this.workerScheduled = false;
      this.runWorker();
    });
  }

  private runWorker(): void {
    if (this.workerRunning || this.stopped) {
      return;
    }
    this.workerRunning = true;
    try {
      for (let index = 0; index < 4 && this.queue.getDepth() > 0; index += 1) {
        const item = this.queue.shift();
        if (item === undefined) {
          break;
        }
        this.processingWindowStarted = false;
        try {
          this.processAcceptedPacket(item.packet);
          this.pipelineHealthy = true;
        } catch (error) {
          if (this.processingWindowStarted) {
            this.windowsFailed += 1;
          } else {
            this.packetProcessingFailures += 1;
          }
          this.pipelineHealthy = false;
          const message = error instanceof Error ? error.message : "unknown analysis error";
          console.error(
            `[objective-analysis] packet processing failed session_id=${item.packet.session_id} seq=${item.packet.raw_packet.seq} message=${message}`,
          );
        } finally {
          this.maybeFinalizeSession(item.packet.session_id);
        }
      }
    } finally {
      this.workerRunning = false;
      if (!this.stopped && this.queue.getDepth() > 0) {
        this.scheduleWorker();
      }
    }
  }

  private processAcceptedPacket(packet: AcceptedObjectivePacket): void {
    this.processingSessionId = packet.session_id;
    try {
      const state = this.getOrCreateState(packet);
      const expanded = expandAcceptedPacket(packet);
      state.ecgDetector.process(expanded.ecg);
      state.ppgDetector.process(expanded.ppg);
      const windows = state.windowEngine.ingestPacket(packet);
      if (windows.length === 0) {
        return;
      }

      this.processingWindowStarted = true;
      const results: AnalysisResult[] = [];
      const workingBaseline = state.baseline.clone();
      const workingRules = cloneRuleState(state.rules);
      const workingMultimodal = cloneMultimodalState(state.multimodal);

      for (const analysisWindow of windows) {
        const provisionalFeatures = calculateFeatures(
          { ...state, rules: workingRules, multimodal: workingMultimodal },
          analysisWindow,
          workingBaseline,
        );
        const provisionalQuality = calculateQuality(
          state,
          analysisWindow,
          provisionalFeatures,
        );
        workingBaseline.observeWindow(
          analysisWindow.window.end_ms,
          baselineObservations(provisionalFeatures, provisionalQuality),
        );

        const features = calculateFeatures(
          { ...state, rules: workingRules, multimodal: workingMultimodal },
          analysisWindow,
          workingBaseline,
        );
        const quality = calculateQuality(state, analysisWindow, features);
        const rules = modalityRuleEvaluations(
          { ...state, rules: workingRules, multimodal: workingMultimodal },
          features,
          quality,
          workingBaseline,
        );
        const multimodalResult = evaluateMultimodalRules({
          qualities: quality,
          features,
          rules,
          baselineReady: workingBaseline.isGlobalReady(),
          baselineCollectionComplete: workingBaseline.getSummary().collection_complete,
          persistence: workingMultimodal,
        });
        results.push(
          buildResult(
            state,
            packet,
            analysisWindow,
            features,
            quality,
            rules,
            multimodalResult,
            workingBaseline,
          ),
        );
      }

      state.baseline.replaceWith(workingBaseline);
      state.rules.consecutiveTrue = { ...workingRules.consecutiveTrue };
      state.multimodal.previousDimensionKey = workingMultimodal.previousDimensionKey;
      state.multimodal.consecutiveSameCondition = workingMultimodal.consecutiveSameCondition;
      this.windowsEmitted += results.length;
      for (const result of results) {
        this.lastWindow = {
          session_id: result.session_id,
          epoch_id: result.epoch_id,
          end_ms: result.window.end_ms,
        };
        this.resultBus.publish(result);
      }
    } finally {
      this.processingSessionId = null;
    }
  }

  private getOrCreateState(packet: AcceptedObjectivePacket): AnalysisState {
    const key = stateKey(packet.session_id, packet.epoch_id);
    const activeKey = this.activeEpochBySession.get(packet.session_id);
    if (activeKey !== undefined && activeKey !== key) {
      for (const [existingKey, state] of this.states) {
        if (state.sessionId === packet.session_id && existingKey !== key) {
          this.states.delete(existingKey);
        }
      }
      for (const pendingKey of this.pendingInputGaps.keys()) {
        if (pendingKey !== key && pendingKey.startsWith(`[\"${packet.session_id}\"`)) {
          this.pendingInputGaps.delete(pendingKey);
        }
      }
    }

    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        sessionId: packet.session_id,
        epochId: packet.epoch_id,
        deviceId: packet.device_id,
        bootId: packet.boot_id,
        windowEngine: new AnalysisWindowEngine(),
        ecgDetector: new EcgStreamingDetector(),
        ppgDetector: new PpgStreamingDetector(),
        baseline: new BaselineState(),
        rules: { consecutiveTrue: {} },
        multimodal: createMultimodalPersistenceState(),
      };
      this.states.set(key, state);
      this.activeEpochBySession.set(packet.session_id, key);
      const pending = this.pendingInputGaps.get(key);
      if (pending !== undefined) {
        for (const event of pending) {
          state.windowEngine.recordAnalysisInputGap(packet.session_id, packet.epoch_id, event);
        }
        this.pendingInputGaps.delete(key);
      }
    }
    this.lastTouchedState = state;
    return state;
  }

  private maybeFinalizeSession(sessionId: string): void {
    if (!this.stoppingSessions.has(sessionId) || this.processingSessionId === sessionId) {
      return;
    }
    if (this.queue.hasSession(sessionId)) {
      return;
    }
    for (const [key, state] of this.states) {
      if (state.sessionId === sessionId) {
        this.states.delete(key);
        if (this.lastTouchedState === state) {
          this.lastTouchedState = null;
        }
      }
    }
    this.activeEpochBySession.delete(sessionId);
    for (const key of this.pendingInputGaps.keys()) {
      if (key.startsWith(`[\"${sessionId}\"`)) {
        this.pendingInputGaps.delete(key);
      }
    }
    this.stoppingSessions.delete(sessionId);
    this.endedSessions.add(sessionId);
  }
}
