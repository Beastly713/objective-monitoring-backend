import type { AcceptedObjectivePacket, AcceptedPacketBus } from "../acceptedPacketBus.js";
import { BaselineState, type BaselineObservation } from "./baseline.js";
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
import {
  AnalysisWindowEngine,
  type AnalysisEpochCoverage,
  type CompletedAnalysisWindow,
  type IncompleteAnalysisTail,
} from "./windows.js";
import {
  FinalSessionAnalysisBus,
  synthesizeFinalSessionAnalysis,
  type FinalAnalysisMissingWindow,
  type FinalAnalysisTail,
  type FinalSessionAnalysis,
} from "./sessionSynthesis.js";
import type {
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

export const ANALYSIS_QUEUE_CAPACITY = 16;

export interface AnalysisWorkItem {
  window: AnalysisWindow | CompletedAnalysisWindow;
  queued_at_ms: number;
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

  enqueue(window: AnalysisWindow | CompletedAnalysisWindow, queuedAtMs = Date.now()): boolean {
    if (this.closed || this.items.length >= this.capacity) {
      return false;
    }
    this.items.push({ window, queued_at_ms: queuedAtMs });
    return true;
  }

  shift(): AnalysisWorkItem | undefined {
    return this.items.shift();
  }

  getDepth(): number {
    return this.items.length;
  }

  hasSession(sessionId: string): boolean {
    return this.items.some((item) => item.window.sessionId === sessionId);
  }

  close(): void {
    this.closed = true;
    this.items.length = 0;
  }
}

export interface AnalysisPipelineSnapshot {
  windowsEmitted: number;
  windowsFailed: number;
  packetProcessingFailures: number;
  queueDepth: number;
  queueDrops: number;
  pendingAnalysisWindows: number;
  lastAnalysisQueueWaitMs: number | null;
  lastAnalysisDurationMs: number | null;
  lastWindow: {
    session_id: string | null;
    epoch_id: string | null;
    start_ms: number | null;
    end_ms: number | null;
  };
  baseline: {
    collection_complete: boolean;
    ready_modalities: AnalysisModality[];
  };
  finalAnalysis: {
    session_id: string | null;
    state: "pending" | "complete" | "unavailable" | "error";
    available: boolean;
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
  detectorsProcessedThroughMs: number | null;
}

interface SessionAnalysisAccumulator {
  sessionId: string;
  deviceId: string;
  epochIds: string[];
  epochCoverage: Map<string, AnalysisEpochCoverage>;
  completedResults: AnalysisResult[];
  missingWindows: FinalAnalysisMissingWindow[];
  incompleteTails: FinalAnalysisTail[];
  baselineSummary: AnalysisResult["baseline"] | null;
}

type FinalAnalysisRuntimeState = "pending" | "complete" | "unavailable" | "error";

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
    sample_gap_count: analysisWindow.metadata.sampleGapEvents.length,
    truncated_packet_count: packets.filter((packet) => packet.truncated).length,
    modalities_present: MODALITIES.filter((modality) => analysisWindow.samples[modality].length > 0),
    discarded_out_of_order_samples: analysisWindow.metadata.discardedOutOfOrderSamples.length,
    analysis_input_gap_count: analysisWindow.metadata.analysisInputGapEvents.length,
  };
}

function baselineEligibleModalities(
  baseline: BaselineState,
  analysisWindow: AnalysisWindow,
  observations: readonly BaselineObservation[],
): AnalysisModality[] {
  if (baseline.getSummary().collection_complete || analysisWindow.window.end_ms > 60_000) {
    return [];
  }
  return observations
    .filter((observation) => observation.valid && observation.value !== null &&
      (observation.quality === "good" || observation.quality === "usable"))
    .map((observation) => observation.modality);
}

function completedWindowRef(
  analysisWindow: Pick<AnalysisWindow, "epochId" | "window">,
): FinalAnalysisMissingWindow {
  return {
    epoch_id: analysisWindow.epochId,
    start_ms: analysisWindow.window.start_ms,
    end_ms: analysisWindow.window.end_ms,
    start_us: analysisWindow.window.start_us,
    end_us: analysisWindow.window.end_us,
    reason: "queue_drop",
  };
}

function buildResult(
  state: AnalysisState,
  analysisWindow: AnalysisWindow,
  features: FeatureBundle,
  quality: QualityBundle,
  rules: AllModalityRuleEvaluations,
  multimodalResult: AnalysisResult["multimodal_result"],
  baselineBefore: BaselineState,
  baselineAfter: BaselineState,
  eligibleBaselineModalities: AnalysisModality[],
): AnalysisResult {
  const ecgBaseline = baselineBefore.getReference("ecg");
  const ppgBaseline = baselineBefore.getReference("ppg");
  const gsrBaseline = baselineBefore.getReference("gsr");
  const imuBaseline = baselineBefore.getReference("imu");
  const temperatureBaseline = baselineBefore.getReference("temperature");

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
    session_id: state.sessionId,
    device_id: state.deviceId,
    boot_id: state.bootId,
    epoch_id: state.epochId,
    analysis_version: ANALYSIS_VERSION,
    conversion_version: CONVERSION_VERSION,
    feature_version: FEATURE_VERSION,
    rule_version: RULE_VERSION,
    created_at_ms: analysisWindow.completed_at_ms ?? Date.now(),
    window: { ...analysisWindow.window },
    source: sourceTrace(analysisWindow),
    baseline_ready: baselineBefore.isGlobalReady(),
    baseline: baselineBefore.getSummary(),
    baseline_update: {
      eligible_modalities: [...eligibleBaselineModalities],
      baseline_after: baselineAfter.getSummary(),
    },
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
  private readonly sessionAccumulators = new Map<string, SessionAnalysisAccumulator>();
  private readonly stoppingSessions = new Set<string>();
  private readonly finalizingSessions = new Set<string>();
  private readonly endedSessions = new Set<string>();
  private readonly unsubscribe: () => void;
  readonly finalAnalysisBus: FinalSessionAnalysisBus;
  private workerScheduled = false;
  private workerRunning = false;
  private processingSessionId: string | null = null;
  private stopped = false;
  private windowsEmitted = 0;
  private windowsFailed = 0;
  private packetProcessingFailures = 0;
  private queueDrops = 0;
  private pipelineHealthy = true;
  private lastAnalysisQueueWaitMs: number | null = null;
  private lastAnalysisDurationMs: number | null = null;
  private readonly finalAnalysisStates = new Map<string, FinalAnalysisRuntimeState>();
  private lastWindow: AnalysisPipelineSnapshot["lastWindow"] = {
    session_id: null,
    epoch_id: null,
    start_ms: null,
    end_ms: null,
  };
  private lastTouchedState: AnalysisState | null = null;

  constructor(
    acceptedPacketBus: AcceptedPacketBus,
    private readonly resultBus: AnalysisResultBus,
    options: AnalysisPipelineOptions = {},
  ) {
    this.queue = new SerializedAnalysisQueue(options.queueCapacity);
    this.finalAnalysisBus = new FinalSessionAnalysisBus();
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
      pendingAnalysisWindows: this.queue.getDepth() + (this.processingSessionId === null ? 0 : 1),
      lastAnalysisQueueWaitMs: this.lastAnalysisQueueWaitMs,
      lastAnalysisDurationMs: this.lastAnalysisDurationMs,
      lastWindow: { ...this.lastWindow },
      baseline: {
        collection_complete: baseline.collection_complete,
        ready_modalities: [...baseline.ready_modalities],
      },
      finalAnalysis: this.latestFinalAnalysisSnapshot(),
      pipelineHealthy: this.pipelineHealthy,
      degraded: !this.pipelineHealthy,
    };
  }

  getFinalAnalysisState(sessionId: string): FinalAnalysisRuntimeState {
    return this.finalAnalysisStates.get(sessionId) ?? "unavailable";
  }

  requestSessionStop(sessionId: string): void {
    if (this.stopped || this.endedSessions.has(sessionId)) {
      return;
    }
    this.stoppingSessions.add(sessionId);
    this.finalAnalysisStates.set(sessionId, "pending");
    this.ensureSessionAccumulator(sessionId);
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
    this.sessionAccumulators.clear();
    this.stoppingSessions.clear();
    this.finalizingSessions.clear();
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
      this.queueDrops += 1;
      this.pipelineHealthy = false;
      return;
    }

    let state: AnalysisState;
    let completedWindows: CompletedAnalysisWindow[];
    try {
      state = this.getOrCreateState(packet);
      completedWindows = state.windowEngine.collectPacket(packet);
      this.updateSessionCollection(state);
    } catch (error) {
      this.packetProcessingFailures += 1;
      this.pipelineHealthy = false;
      const message = error instanceof Error ? error.message : "unknown collection error";
      console.error(
        `[objective-analysis] lightweight window collection failed session_id=${packet.session_id} seq=${packet.raw_packet.seq} message=${message}`,
      );
      return;
    }

    for (const window of completedWindows) {
      if (!this.queue.enqueue(window)) {
        this.recordWindowDrop(window, "queue_drop");
        continue;
      }
      this.scheduleWorker();
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
      const item = this.queue.shift();
      if (item === undefined) {
        return;
      }

      const queuedAtMs = item.queued_at_ms;
      const analysisStartedAtMs = Date.now();
      this.lastAnalysisQueueWaitMs = Math.max(0, analysisStartedAtMs - queuedAtMs);
      this.processingSessionId = item.window.sessionId;
      try {
        this.processCompletedWindow(item.window);
        this.pipelineHealthy = true;
      } catch (error) {
        this.windowsFailed += 1;
        this.pipelineHealthy = false;
        this.recordWindowDrop(item.window, "analysis_failure");
        const message = error instanceof Error ? error.message : "unknown analysis error";
        console.error(
          `[objective-analysis] completed-window analysis failed session_id=${item.window.sessionId} epoch_id=${item.window.epochId} window_start_ms=${item.window.window.start_ms} message=${message}`,
        );
      } finally {
        this.lastAnalysisDurationMs = Math.max(0, Date.now() - analysisStartedAtMs);
        this.processingSessionId = null;
        this.maybeFinalizeSession(item.window.sessionId);
      }
    } finally {
      this.workerRunning = false;
      if (!this.stopped && this.queue.getDepth() > 0) {
        this.scheduleWorker();
      }
      for (const sessionId of this.stoppingSessions) {
        this.maybeFinalizeSession(sessionId);
      }
    }
  }

  private processCompletedWindow(window: AnalysisWindow | CompletedAnalysisWindow): void {
    const analysisWindow = "materialize" in window ? window.materialize() : window;
    const state = this.states.get(stateKey(analysisWindow.sessionId, analysisWindow.epochId));
    if (state === undefined) {
      throw new Error(`analysis state missing for completed window ${analysisWindow.sessionId}/${analysisWindow.epochId}`);
    }

    const context = analysisWindow.context_samples;
    const needsDetectorContext = state.detectorsProcessedThroughMs === null ||
      analysisWindow.window.start_ms > state.detectorsProcessedThroughMs;
    if (needsDetectorContext) {
      state.ecgDetector.reset();
      state.ppgDetector.reset();
      state.ecgDetector.process(context?.ecg ?? []);
      state.ppgDetector.process(context?.ppg ?? []);
    }
    state.ecgDetector.process(analysisWindow.samples.ecg);
    state.ppgDetector.process(analysisWindow.samples.ppg);

    const baselineBefore = state.baseline.clone();
    const workingRules = cloneRuleState(state.rules);
    const workingMultimodal = cloneMultimodalState(state.multimodal);
    const analysisState = { ...state, rules: workingRules, multimodal: workingMultimodal };
    const features = calculateFeatures(analysisState, analysisWindow, baselineBefore);
    const quality = calculateQuality(state, analysisWindow, features);
    const rules = modalityRuleEvaluations(analysisState, features, quality, baselineBefore);
    const multimodalResult = evaluateMultimodalRules({
      qualities: quality,
      features,
      rules,
      baselineReady: baselineBefore.isGlobalReady(),
      baselineCollectionComplete: baselineBefore.getSummary().collection_complete,
      persistence: workingMultimodal,
    });

    const observations = baselineObservations(features, quality);
    const baselineAfter = baselineBefore.clone();
    baselineAfter.observeWindow(analysisWindow.window.end_ms, observations);
    const eligibleBaselineModalities = baselineEligibleModalities(
      baselineBefore,
      analysisWindow,
      observations,
    );
    const result = buildResult(
      state,
      analysisWindow,
      features,
      quality,
      rules,
      multimodalResult,
      baselineBefore,
      baselineAfter,
      eligibleBaselineModalities,
    );

    // Publication is the completion point for this one immutable window. The
    // state transition below is intentionally after evaluation/publication so
    // this window cannot use its own observations as a baseline.
    this.resultBus.publish(result);
    state.baseline.replaceWith(baselineAfter);
    state.rules.consecutiveTrue = { ...workingRules.consecutiveTrue };
    state.multimodal.previousDimensionKey = workingMultimodal.previousDimensionKey;
    state.multimodal.consecutiveSameCondition = workingMultimodal.consecutiveSameCondition;
    state.detectorsProcessedThroughMs = analysisWindow.window.end_ms;

    const accumulator = this.ensureSessionAccumulator(result.session_id, state.deviceId);
    accumulator.completedResults.push(result);
    accumulator.baselineSummary = baselineAfter.getSummary();
    this.windowsEmitted += 1;
    this.lastWindow = {
      session_id: result.session_id,
      epoch_id: result.epoch_id,
      start_ms: result.window.start_ms,
      end_ms: result.window.end_ms,
    };
  }

  private ensureSessionAccumulator(
    sessionId: string,
    deviceId = "unknown",
  ): SessionAnalysisAccumulator {
    let accumulator = this.sessionAccumulators.get(sessionId);
    if (accumulator === undefined) {
      accumulator = {
        sessionId,
        deviceId,
        epochIds: [],
        epochCoverage: new Map(),
        completedResults: [],
        missingWindows: [],
        incompleteTails: [],
        baselineSummary: null,
      };
      this.sessionAccumulators.set(sessionId, accumulator);
    } else if (accumulator.deviceId === "unknown" && deviceId !== "unknown") {
      accumulator.deviceId = deviceId;
    }
    return accumulator;
  }

  private updateSessionCollection(state: AnalysisState): void {
    const accumulator = this.ensureSessionAccumulator(state.sessionId, state.deviceId);
    if (!accumulator.epochIds.includes(state.epochId)) {
      accumulator.epochIds.push(state.epochId);
    }
    const coverage = state.windowEngine.getEpochCoverage();
    if (coverage !== null) {
      accumulator.epochCoverage.set(state.epochId, coverage);
    }
  }

  private addIncompleteTail(
    accumulator: SessionAnalysisAccumulator,
    tail: IncompleteAnalysisTail,
  ): void {
    if (accumulator.incompleteTails.some((existing) =>
      existing.epoch_id === tail.epoch_id &&
      existing.start_ms === tail.start_ms &&
      existing.end_ms === tail.end_ms
    )) {
      return;
    }
    accumulator.incompleteTails.push({
      epoch_id: tail.epoch_id,
      start_ms: tail.start_ms,
      end_ms: tail.end_ms,
      duration_ms: tail.duration_ms,
    });
  }

  private recordWindowDrop(
    analysisWindow: Pick<AnalysisWindow, "sessionId" | "epochId" | "window">,
    reason: "queue_drop" | "analysis_failure",
  ): void {
    if (reason === "queue_drop") {
      this.queueDrops += 1;
    }
    this.pipelineHealthy = false;
    const accumulator = this.ensureSessionAccumulator(analysisWindow.sessionId);
    const missingWindow = completedWindowRef(analysisWindow);
    missingWindow.reason = reason;
    if (!accumulator.missingWindows.some((existing) =>
      existing.epoch_id === missingWindow.epoch_id &&
      existing.start_ms === missingWindow.start_ms
    )) {
      accumulator.missingWindows.push(missingWindow);
    }
  }

  private latestFinalAnalysisSnapshot(): AnalysisPipelineSnapshot["finalAnalysis"] {
    const entries = [...this.finalAnalysisStates.entries()];
    const latest = entries.at(-1);
    if (latest === undefined) {
      return { session_id: null, state: "unavailable", available: false };
    }
    return {
      session_id: latest[0],
      state: latest[1],
      available: latest[1] === "complete",
    };
  }

  private getOrCreateState(packet: AcceptedObjectivePacket): AnalysisState {
    const key = stateKey(packet.session_id, packet.epoch_id);
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
        detectorsProcessedThroughMs: null,
      };
      this.states.set(key, state);
      this.activeEpochBySession.set(packet.session_id, key);
    }
    const accumulator = this.ensureSessionAccumulator(packet.session_id, packet.device_id);
    if (!accumulator.epochIds.includes(packet.epoch_id)) {
      accumulator.epochIds.push(packet.epoch_id);
    }
    this.lastTouchedState = state;
    return state;
  }

  private maybeFinalizeSession(sessionId: string): void {
    if (
      !this.stoppingSessions.has(sessionId) ||
      this.finalizingSessions.has(sessionId) ||
      this.processingSessionId === sessionId
    ) {
      return;
    }
    if (this.queue.hasSession(sessionId)) {
      return;
    }

    this.finalizingSessions.add(sessionId);
    try {
      const accumulator = this.ensureSessionAccumulator(sessionId);
      for (const state of this.states.values()) {
        if (state.sessionId !== sessionId) {
          continue;
        }
        this.updateSessionCollection(state);
        const tail = state.windowEngine.getIncompleteTail();
        if (tail !== null) {
          this.addIncompleteTail(accumulator, tail);
        }
        accumulator.baselineSummary = state.baseline.getSummary();
      }

      const finalAnalysis = synthesizeFinalSessionAnalysis({
        session_id: accumulator.sessionId,
        device_id: accumulator.deviceId,
        completed_results: accumulator.completedResults,
        missing_windows: accumulator.missingWindows,
        incomplete_tails: accumulator.incompleteTails,
        epoch_coverage: [...accumulator.epochCoverage.values()].map((coverage) => ({
          epoch_id: coverage.epoch_id,
          first_sample_ms: coverage.first_sample_ms,
          last_sample_ms: coverage.latest_sample_ms,
        })),
        baseline_summary: accumulator.baselineSummary,
        created_at_ms: Date.now(),
      });
      this.finalAnalysisBus.publish(finalAnalysis);
      this.finalAnalysisStates.set(sessionId, "complete");
    } catch (error) {
      this.finalAnalysisStates.set(sessionId, "error");
      this.pipelineHealthy = false;
      const message = error instanceof Error ? error.message : "unknown final analysis error";
      console.error(`[objective-final-analysis] synthesis failed session_id=${sessionId} message=${message}`);
    }

    // The final bus/store now own the synthesized object. Release the mutable
    // per-session accumulator only after synthesis and publication complete.
    this.sessionAccumulators.delete(sessionId);

    for (const [key, state] of this.states) {
      if (state.sessionId === sessionId) {
        this.states.delete(key);
        if (this.lastTouchedState === state) {
          this.lastTouchedState = null;
        }
      }
    }
    this.activeEpochBySession.delete(sessionId);
    this.stoppingSessions.delete(sessionId);
    this.endedSessions.add(sessionId);
    this.finalizingSessions.delete(sessionId);
  }
}
