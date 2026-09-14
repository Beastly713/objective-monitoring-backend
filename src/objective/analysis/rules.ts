import { percentChange } from "./statistics.js";
import { qualityAtLeastUsable } from "./quality.js";
import type {
  AnalysisModality,
  BaselineReference,
  EcgFeatures,
  ImuFeatures,
  ModalityQuality,
  PpgFeatures,
  RuleEvaluation,
  RuleStatus,
  TemperatureFeatures,
  GsrFeatures,
} from "./types.js";

export interface RulePersistenceState {
  consecutiveTrue: Record<string, number>;
}
export function createRulePersistenceState(): RulePersistenceState {
  return { consecutiveTrue: {} };
}

export function resetRulePersistenceState(state: RulePersistenceState): void {
  state.consecutiveTrue = {};
}

function persistentStatus(
  state: RulePersistenceState,
  ruleId: string,
  eligible: boolean,
  condition: boolean,
  requiredWindows: number,
): { status: RuleStatus; count: number } {
  if (!eligible || !condition) {
    state.consecutiveTrue[ruleId] = 0;
    return { status: eligible ? "not_fired" : "ineligible", count: 0 };
  }
  const count = (state.consecutiveTrue[ruleId] ?? 0) + 1;
  state.consecutiveTrue[ruleId] = count;
  return { status: count >= requiredWindows ? "fired" : "not_fired", count };
}

function evaluation(
  ruleId: string,
  status: RuleStatus,
  inputs: Record<string, number | string | boolean | null>,
  evidence: string[],
  thresholdSource: RuleEvaluation["threshold_source"],
): RuleEvaluation {
  return {
    rule_id: ruleId,
    status,
    inputs,
    evidence,
    threshold_source: thresholdSource,
  };
}

export interface EcgRuleInput {
  quality: ModalityQuality;
  features: EcgFeatures;
  baseline?: BaselineReference;
  state: RulePersistenceState;
}

export function evaluateEcgRules(input: EcgRuleInput): RuleEvaluation[] {
  const hrChange = input.features.heart_rate_bpm === null || input.baseline === undefined
    ? null
    : percentChange(input.features.heart_rate_bpm, input.baseline.median);
  const hrEligible =
    qualityAtLeastUsable(input.quality.state) &&
    input.features.heart_rate_bpm !== null &&
    input.baseline !== undefined &&
    input.features.lead_off_fraction <= 0.2;
  const hrPersistent = persistentStatus(
    input.state,
    "ECG-01",
    hrEligible,
    hrChange !== null && Math.abs(hrChange) >= 15,
    2,
  );
  const ecg01 = evaluation(
    "ECG-01",
    hrPersistent.status,
    {
      heart_rate_bpm: input.features.heart_rate_bpm,
      baseline_hr_bpm: input.baseline?.median ?? null,
      percent_change: hrChange,
      lead_off_fraction: input.features.lead_off_fraction,
      consecutive_true: hrPersistent.count,
    },
    hrEligible
      ? ["absolute heart-rate baseline change is at least 15%", `consecutive_true=${hrPersistent.count}`]
      : ["heart-rate rule inputs are unavailable or ECG lead-off is too high"],
    "baseline_derived",
  );

  const insufficiencyReasons = new Set([
    "LEAD_OFF_OVER_20",
    "LEAD_OFF_OVER_50",
    "RR_INSUFFICIENT",
    "LARGE_GAP",
    "PACKET_GAP",
    "COVERAGE_BELOW_50",
  ]);
  const hasInsufficientEvidence = input.quality.reason_codes.some((reason) => insufficiencyReasons.has(reason));
  const limitedBeatEvidence =
    input.quality.sample_count > 0 &&
    input.features.heart_rate_bpm === null &&
    hasInsufficientEvidence;
  const ecg02 = evaluation(
    "ECG-02",
    limitedBeatEvidence ? "fired" : input.quality.sample_count === 0 ? "ineligible" : "not_fired",
    {
      sample_count: input.quality.sample_count,
      heart_rate_bpm: input.features.heart_rate_bpm,
      beat_evidence_limited: limitedBeatEvidence,
    },
    limitedBeatEvidence
      ? ["ECG samples are present but beat-based evidence is insufficient"]
      : ["ECG beat evidence is absent or sufficient for this rule"],
    "prototype_heuristic",
  );
  return [ecg01, ecg02];
}

export interface PpgRuleInput {
  quality: ModalityQuality;
  features: PpgFeatures;
  baseline?: BaselineReference;
  state: RulePersistenceState;
  ecgQuality: ModalityQuality;
  ecgFeatures: EcgFeatures;
}

export function evaluatePpgRules(input: PpgRuleInput): RuleEvaluation[] {
  const pulseChange = input.features.pulse_rate_bpm === null || input.baseline === undefined
    ? null
    : percentChange(input.features.pulse_rate_bpm, input.baseline.median);
  const pulseEligible =
    qualityAtLeastUsable(input.quality.state) &&
    input.features.pulse_rate_bpm !== null &&
    input.baseline !== undefined;
  const pulsePersistent = persistentStatus(
    input.state,
    "PPG-01",
    pulseEligible,
    pulseChange !== null && Math.abs(pulseChange) >= 15,
    2,
  );
  const ppg01 = evaluation(
    "PPG-01",
    pulsePersistent.status,
    {
      pulse_rate_bpm: input.features.pulse_rate_bpm,
      baseline_pulse_rate_bpm: input.baseline?.median ?? null,
      percent_change: pulseChange,
      consecutive_true: pulsePersistent.count,
    },
    pulseEligible
      ? ["absolute pulse-rate baseline change is at least 15%", `consecutive_true=${pulsePersistent.count}`]
      : ["pulse-rate rule inputs are unavailable"],
    "baseline_derived",
  );

  const disagreementEligible =
    qualityAtLeastUsable(input.ecgQuality.state) &&
    qualityAtLeastUsable(input.quality.state) &&
    input.ecgFeatures.heart_rate_bpm !== null &&
    input.features.pulse_rate_bpm !== null;
  const rateDifference = disagreementEligible
    ? Math.abs(input.ecgFeatures.heart_rate_bpm! - input.features.pulse_rate_bpm!)
    : null;
  const rateThreshold = disagreementEligible
    ? Math.max(
      10,
      0.1 * ((input.ecgFeatures.heart_rate_bpm! + input.features.pulse_rate_bpm!) / 2),
    )
    : null;
  const disagreement =
    disagreementEligible && rateDifference !== null && rateThreshold !== null && rateDifference > rateThreshold;
  const ppg02 = evaluation(
    "PPG-02",
    disagreementEligible ? (disagreement ? "fired" : "not_fired") : "ineligible",
    {
      heart_rate_bpm: input.ecgFeatures.heart_rate_bpm,
      pulse_rate_bpm: input.features.pulse_rate_bpm,
      rate_difference_bpm: rateDifference,
      rate_threshold_bpm: rateThreshold,
    },
    disagreement
      ? ["ECG and PPG rates differ by more than the strict disagreement threshold"]
      : ["ECG and PPG rates agree or cannot be compared"],
    "prototype_heuristic",
  );
  return [ppg01, ppg02];
}

export interface GsrRuleInput {
  quality: ModalityQuality;
  features: GsrFeatures;
  baseline?: BaselineReference;
  state: RulePersistenceState;
}

export function evaluateGsrRules(input: GsrRuleInput): RuleEvaluation[] {
  const eligible =
    qualityAtLeastUsable(input.quality.state) &&
    input.features.gsr_raw_mean !== null &&
    input.features.gsr_robust_z !== null &&
    input.features.gsr_raw_slope_raw_per_s !== null &&
    input.baseline !== undefined;
  const condition =
    eligible &&
    input.features.gsr_robust_z! >= 2 &&
    input.features.gsr_raw_slope_raw_per_s! > 0;
  const persistent = persistentStatus(input.state, "GSR-01", eligible, condition, 2);
  return [evaluation(
    "GSR-01",
    persistent.status,
    {
      gsr_raw_mean: input.features.gsr_raw_mean,
      robust_z: input.features.gsr_robust_z,
      slope_raw_per_s: input.features.gsr_raw_slope_raw_per_s,
      consecutive_true: persistent.count,
    },
    condition
      ? ["GSR robust z is at least 2 and raw slope is positive", `consecutive_true=${persistent.count}`]
      : ["electrodermal upward-change conditions are not satisfied"],
    "baseline_derived",
  )];
}

export interface ImuRuleInput {
  quality: ModalityQuality;
  features: ImuFeatures;
  baselineReady: boolean;
}

export function evaluateImuRules(input: ImuRuleInput): RuleEvaluation[] {
  const eligible = qualityAtLeastUsable(input.quality.state) && input.features.movement_level !== null;
  const fired = eligible && input.features.movement_level === "high";
  return [evaluation(
    "IMU-01",
    eligible ? (fired ? "fired" : "not_fired") : "ineligible",
    {
      motion_index_g: input.features.motion_index_g,
      movement_level: input.features.movement_level,
      baseline_ready: input.baselineReady,
    },
    fired ? ["movement level is high"] : ["movement level is not high or IMU evidence is unavailable"],
    input.baselineReady ? "baseline_derived" : "prototype_heuristic",
  )];
}

export interface TemperatureRuleInput {
  quality: ModalityQuality;
  features: TemperatureFeatures;
  baseline?: BaselineReference;
  state: RulePersistenceState;
}

export function evaluateTemperatureRules(input: TemperatureRuleInput): RuleEvaluation[] {
  const eligible =
    qualityAtLeastUsable(input.quality.state) &&
    input.features.temperature_mean_c !== null &&
    input.features.temperature_delta_c !== null &&
    input.baseline !== undefined;
  const condition = eligible && Math.abs(input.features.temperature_delta_c!) >= 0.5;
  const persistent = persistentStatus(input.state, "TEMP-01", eligible, condition, 3);
  return [evaluation(
    "TEMP-01",
    persistent.status,
    {
      temperature_mean_c: input.features.temperature_mean_c,
      temperature_delta_c: input.features.temperature_delta_c,
      consecutive_true: persistent.count,
    },
    condition
      ? ["absolute temperature delta is at least 0.5 degC", `consecutive_true=${persistent.count}`]
      : ["temperature-change condition is not satisfied"],
    "baseline_derived",
  )];
}

export function evaluateQualityRule(
  modality: AnalysisModality,
  quality: ModalityQuality,
  requiredFeaturePresent: boolean,
): RuleEvaluation {
  const ineligible = quality.state === "unavailable" || !requiredFeaturePresent;
  return evaluation(
    "QUALITY-01",
    ineligible ? "ineligible" : "not_fired",
    {
      modality,
      quality: quality.state,
      required_feature_present: requiredFeaturePresent,
    },
    ineligible ? ["required modality evidence is insufficient"] : ["required modality evidence is present"],
    "prototype_heuristic",
  );
}

export interface AllModalityRuleInput {
  ecg: EcgRuleInput;
  ppg: PpgRuleInput;
  gsr: GsrRuleInput;
  imu: ImuRuleInput;
  temperature: TemperatureRuleInput;
}

export interface AllModalityRuleEvaluations {
  ecg: RuleEvaluation[];
  ppg: RuleEvaluation[];
  gsr: RuleEvaluation[];
  imu: RuleEvaluation[];
  temperature: RuleEvaluation[];
}

export function evaluateAllModalityRules(input: AllModalityRuleInput): AllModalityRuleEvaluations {
  const ecg = evaluateEcgRules(input.ecg);
  const ppg = evaluatePpgRules(input.ppg);
  const gsr = evaluateGsrRules(input.gsr);
  const imu = evaluateImuRules(input.imu);
  const temperature = evaluateTemperatureRules(input.temperature);
  ecg.push(evaluateQualityRule("ecg", input.ecg.quality, input.ecg.features.heart_rate_bpm !== null));
  ppg.push(evaluateQualityRule("ppg", input.ppg.quality, input.ppg.features.pulse_rate_bpm !== null));
  gsr.push(evaluateQualityRule("gsr", input.gsr.quality, input.gsr.features.gsr_raw_mean !== null));
  imu.push(evaluateQualityRule("imu", input.imu.quality, input.imu.features.motion_index_g !== null));
  temperature.push(
    evaluateQualityRule("temperature", input.temperature.quality, input.temperature.features.temperature_mean_c !== null),
  );
  return { ecg, ppg, gsr, imu, temperature };
}

export function firedRuleIds(evaluations: AllModalityRuleEvaluations): string[] {
  return [evaluations.ecg, evaluations.ppg, evaluations.gsr, evaluations.imu, evaluations.temperature]
    .flat()
    .filter((rule) => rule.status === "fired")
    .map((rule) => rule.rule_id);
}

export function ruleObservations(evaluations: readonly RuleEvaluation[]): string[] {
  const observations: string[] = [];
  for (const rule of evaluations) {
    if (rule.status !== "fired") {
      continue;
    }
    const text: Record<string, string> = {
      "ECG-01": "Heart-rate change detected",
      "ECG-02": "ECG data are limited for beat-based analysis",
      "PPG-01": "Pulse-rate change detected",
      "PPG-02": "Cardiovascular measurement disagreement",
      "GSR-01": "Increased electrodermal activity relative to session baseline",
      "IMU-01": "Elevated movement during analysis window",
      "TEMP-01": "Local skin-temperature change detected",
    };
    const observation = text[rule.rule_id];
    if (observation !== undefined && !observations.includes(observation)) {
      observations.push(observation);
    }
  }
  return observations;
}
