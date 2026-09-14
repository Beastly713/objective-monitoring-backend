import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";

export type AnalysisModality = "ecg" | "ppg" | "gsr" | "imu" | "temperature";

export type AnalysisQualityState = "good" | "usable" | "limited" | "unavailable";

export type EvidenceTier = "corroborated" | "moderate" | "limited" | "insufficient";

export type RuleStatus = "fired" | "not_fired" | "ineligible";

export type ThresholdSource = "hardware" | "literature" | "prototype_heuristic" | "baseline_derived";

export interface AnalysisSampleBase {
  sessionId: string;
  bootId: string;
  epochId: string;
  packetSeq: number;
  sampleTimeUs: number;
  sampleTimeMs: number;
}
export interface AnalysisEcgSample extends AnalysisSampleBase {
  modality: "ecg";
  adc: number;
  loPlus: 0 | 1;
  loMinus: 0 | 1;
}

export interface AnalysisPpgSample extends AnalysisSampleBase {
  modality: "ppg";
  red: number;
  ir: number;
}

export interface AnalysisGsrSample extends AnalysisSampleBase {
  modality: "gsr";
  raw: number;
}

export interface AnalysisImuSample extends AnalysisSampleBase {
  modality: "imu";
  axG: number;
  ayG: number;
  azG: number;
  gxDps: number;
  gyDps: number;
  gzDps: number;
}

export interface AnalysisTempSample extends AnalysisSampleBase {
  modality: "temperature";
  temperatureC: number;
}

export type AnyAnalysisSample =
  | AnalysisEcgSample
  | AnalysisPpgSample
  | AnalysisGsrSample
  | AnalysisImuSample
  | AnalysisTempSample;

export interface ExpandedAnalysisSamples {
  ecg: AnalysisEcgSample[];
  ppg: AnalysisPpgSample[];
  gsr: AnalysisGsrSample[];
  imu: AnalysisImuSample[];
  temperature: AnalysisTempSample[];
}

export interface AnalysisWindowRef {
  start_us: number;
  end_us: number;
  start_ms: number;
  end_ms: number;
  duration_ms: 10_000;
}

export interface PacketMetadata {
  seq: number;
  sequence_status: Exclude<AcceptedObjectivePacket["sequence_status"], "duplicate_stale">;
  gap_before: number;
  start_ms: number;
  end_ms: number;
  truncated: boolean;
}

export interface PacketGapEvent {
  previousSeq: number | null;
  nextSeq: number;
  missingPackets: number;
  startMs: number;
  endMs: number;
}

export interface AnalysisInputGapEvent {
  seq: number;
  startMs: number;
  endMs: number;
}

export interface SampleGapEvent {
  modality: AnalysisModality;
  startMs: number;
  endMs: number;
  gapMs: number;
}

export interface DiscardedOutOfOrderSample {
  modality: AnalysisModality;
  sampleTimeMs: number;
}

export interface AnalysisWindowMetadata {
  packetMetadata: PacketMetadata[];
  packetGapEvents: PacketGapEvent[];
  sampleGapEvents: SampleGapEvent[];
  analysisInputGapEvents: AnalysisInputGapEvent[];
  discardedOutOfOrderSamples: DiscardedOutOfOrderSample[];
}

export interface AnalysisWindowSamples {
  ecg: AnalysisEcgSample[];
  ppg: AnalysisPpgSample[];
  gsr: AnalysisGsrSample[];
  imu: AnalysisImuSample[];
  temperature: AnalysisTempSample[];
}

/**
 * Detector context is deliberately separate from the reported window samples.
 * Context can help a stateful detector cross a window boundary, but it must
 * never affect sample counts or feature aggregates for the completed window.
 */
export interface AnalysisWindowContextSamples {
  ecg: AnalysisEcgSample[];
  ppg: AnalysisPpgSample[];
}

export interface AnalysisWindow {
  sessionId: string;
  epochId: string;
  espAnchorUs: number;
  window: AnalysisWindowRef;
  samples: AnalysisWindowSamples;
  context_samples?: AnalysisWindowContextSamples;
  metadata: AnalysisWindowMetadata;
  completed_at_ms?: number;
}

export interface ModalityQuality {
  state: AnalysisQualityState;
  sample_count: number;
  expected_sample_count: number;
  coverage_fraction: number;
  max_gap_ms: number | null;
  packet_gap: boolean;
  reason_codes: string[];
}

export type BaselineFeatureState = "building" | "ready" | "incomplete";

export interface FeatureBaseline {
  state: BaselineFeatureState;
  eligible_window_count: number;
  median: number | null;
  mad: number | null;
}

export interface ModalityBaselineState {
  modality: AnalysisModality;
  state: BaselineFeatureState;
  features: Record<string, FeatureBaseline>;
}

export interface BaselineSummary {
  collection_complete: boolean;
  ready_modality_count: number;
  ready_modalities: AnalysisModality[];
  modality_states: Record<AnalysisModality, ModalityBaselineState>;
}

export interface BaselineRelation {
  delta: number | null;
  percent_change: number | null;
  robust_z: number | null;
}

export interface BaselineReference {
  median: number;
  mad: number;
}

export interface EcgFeatures {
  beat_count: number;
  heart_rate_bpm: number | null;
  rr_interval_ms: number | null;
  rr_mean_ms: number | null;
  rr_std_ms: number | null;
  ecg_range_adc: number | null;
  lead_off_fraction: number;
}

export interface PpgFeatures {
  pulse_count: number;
  pulse_rate_bpm: number | null;
  pulse_interval_ms: number | null;
  pulse_interval_mean_ms: number | null;
  pulse_interval_std_ms: number | null;
  pulse_amplitude_raw: number | null;
  ppg_red_mean: number | null;
  ppg_ir_mean: number | null;
  ppg_red_std: number | null;
  ppg_ir_std: number | null;
}

export interface GsrFeatures {
  gsr_raw_mean: number | null;
  gsr_raw_min: number | null;
  gsr_raw_max: number | null;
  gsr_raw_range: number | null;
  gsr_raw_std: number | null;
  gsr_raw_delta_from_baseline: number | null;
  gsr_raw_slope_raw_per_s: number | null;
  gsr_robust_z: number | null;
}

export interface ImuFeatures {
  acceleration_magnitude_g_mean: number | null;
  acceleration_magnitude_g_std: number | null;
  motion_index_g: number | null;
  gyro_magnitude_dps_mean: number | null;
  movement_level: "low" | "moderate" | "high" | null;
}

export interface TemperatureFeatures {
  temperature_mean_c: number | null;
  temperature_min_c: number | null;
  temperature_max_c: number | null;
  temperature_delta_c: number | null;
  temperature_slope_c_per_min: number | null;
}

export interface ModalityFeatureMeta {
  unit: string;
  valid: boolean;
  baseline: BaselineRelation | null;
}

export interface RuleEvaluation {
  rule_id: string;
  status: RuleStatus;
  inputs: Record<string, number | string | boolean | null>;
  evidence: string[];
  threshold_source: ThresholdSource;
}

export interface EcgAnalysisResult {
  modality: "ecg";
  quality: ModalityQuality;
  features: EcgFeatures;
  feature_meta: Record<keyof EcgFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface PpgAnalysisResult {
  modality: "ppg";
  quality: ModalityQuality;
  features: PpgFeatures;
  feature_meta: Record<keyof PpgFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface GsrAnalysisResult {
  modality: "gsr";
  quality: ModalityQuality;
  features: GsrFeatures;
  feature_meta: Record<keyof GsrFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface ImuAnalysisResult {
  modality: "imu";
  quality: ModalityQuality;
  features: ImuFeatures;
  feature_meta: Record<keyof ImuFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export interface TemperatureAnalysisResult {
  modality: "temperature";
  quality: ModalityQuality;
  features: TemperatureFeatures;
  feature_meta: Record<keyof TemperatureFeatures, ModalityFeatureMeta>;
  observations: string[];
  rule_evaluations: RuleEvaluation[];
}

export type AnyModalityAnalysisResult =
  | EcgAnalysisResult
  | PpgAnalysisResult
  | GsrAnalysisResult
  | ImuAnalysisResult
  | TemperatureAnalysisResult;

export type ModalityResults = {
  ecg: EcgAnalysisResult;
  ppg: PpgAnalysisResult;
  gsr: GsrAnalysisResult;
  imu: ImuAnalysisResult;
  temperature: TemperatureAnalysisResult;
};

export type MultimodalPattern =
  | "Cardiovascular measurement disagreement"
  | "Cardiovascular change co-occurred with elevated movement"
  | "Multi-modality physiological change observed"
  | "Isolated cardiovascular change observed"
  | "Isolated electrodermal change observed"
  | "Isolated local skin-temperature change observed"
  | "No material change from session baseline observed"
  | "Insufficient evidence for multimodal interpretation";

export interface MultimodalAnalysisResult {
  pattern: MultimodalPattern;
  evidence_tier: EvidenceTier;
  supporting_modalities: AnalysisModality[];
  contradicting_modalities: AnalysisModality[];
  rule_ids: string[];
  explanation: string;
}

export interface AnalysisSourceTrace {
  first_packet_seq: number | null;
  last_packet_seq: number | null;
  packet_count: number;
  packet_gap_count: number;
  sample_gap_count?: number;
  truncated_packet_count: number;
  modalities_present: AnalysisModality[];
  discarded_out_of_order_samples: number;
  analysis_input_gap_count: number;
}

export interface AnalysisResult {
  type: "analysis_update";
  session_id: string;
  device_id: string;
  boot_id: string;
  epoch_id: string;
  analysis_version: string;
  conversion_version: string;
  feature_version: string;
  rule_version: string;
  created_at_ms: number;
  window: AnalysisWindowRef;
  source: AnalysisSourceTrace;
  baseline_ready: boolean;
  baseline: BaselineSummary;
  baseline_update?: {
    eligible_modalities: AnalysisModality[];
    baseline_after: BaselineSummary;
  };
  modality_results: ModalityResults;
  multimodal_result: MultimodalAnalysisResult;
  rules_triggered: string[];
}
