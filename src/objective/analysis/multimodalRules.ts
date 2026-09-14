import { qualityAtLeastUsable } from "./quality.js";
import type {
  AnalysisModality,
  EcgFeatures,
  EvidenceTier,
  GsrFeatures,
  ImuFeatures,
  ModalityQuality,
  MultimodalAnalysisResult,
  PpgFeatures,
  RuleEvaluation,
  TemperatureFeatures,
} from "./types.js";
import type { AllModalityRuleEvaluations } from "./rules.js";

export interface MultimodalPersistenceState {
  previousDimensionKey: string | null;
  consecutiveSameCondition: number;
}
export function createMultimodalPersistenceState(): MultimodalPersistenceState {
  return { previousDimensionKey: null, consecutiveSameCondition: 0 };
}

export function resetMultimodalPersistenceState(state: MultimodalPersistenceState): void {
  state.previousDimensionKey = null;
  state.consecutiveSameCondition = 0;
}

export interface MultimodalRuleInput {
  qualities: {
    ecg: ModalityQuality;
    ppg: ModalityQuality;
    gsr: ModalityQuality;
    imu: ModalityQuality;
    temperature: ModalityQuality;
  };
  features: {
    ecg: EcgFeatures;
    ppg: PpgFeatures;
    gsr: GsrFeatures;
    imu: ImuFeatures;
    temperature: TemperatureFeatures;
  };
  rules: AllModalityRuleEvaluations;
  baselineReady: boolean;
  baselineCollectionComplete: boolean;
  persistence: MultimodalPersistenceState;
}

function fired(evaluations: readonly RuleEvaluation[], ruleId: string): boolean {
  return evaluations.some((rule) => rule.rule_id === ruleId && rule.status === "fired");
}

function qualityGoodCount(qualities: MultimodalRuleInput["qualities"]): number {
  return Object.values(qualities).filter((quality) => quality.state === "good").length;
}

function usableModalities(qualities: MultimodalRuleInput["qualities"]): AnalysisModality[] {
  const modalities: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];
  return modalities.filter((modality) => qualityAtLeastUsable(qualities[modality]!.state));
}

function cardiovascularSources(input: MultimodalRuleInput): AnalysisModality[] {
  const sources: AnalysisModality[] = [];
  if (fired(input.rules.ecg, "ECG-01")) {
    sources.push("ecg");
  }
  if (fired(input.rules.ppg, "PPG-01")) {
    sources.push("ppg");
  }
  return sources;
}

function explanation(pattern: MultimodalAnalysisResult["pattern"]): string {
  return pattern;
}

export function evaluateMultimodalRules(input: MultimodalRuleInput): MultimodalAnalysisResult {
  const disagreement = fired(input.rules.ppg, "PPG-02");
  const hrAvailable = input.features.ecg.heart_rate_bpm !== null;
  const prAvailable = input.features.ppg.pulse_rate_bpm !== null;
  const comparisonUnavailable =
    !disagreement &&
    ((fired(input.rules.ecg, "ECG-01") && !prAvailable) ||
      (fired(input.rules.ppg, "PPG-01") && !hrAvailable));
  const cardiovascularChange = !disagreement && !comparisonUnavailable &&
    (fired(input.rules.ecg, "ECG-01") || fired(input.rules.ppg, "PPG-01"));
  const electrodermalChange = fired(input.rules.gsr, "GSR-01");
  const temperatureChange = fired(input.rules.temperature, "TEMP-01");
  const movementHigh = input.features.imu.movement_level === "high";
  const activeDimensions = [
    cardiovascularChange ? "cardiovascular" : null,
    electrodermalChange ? "electrodermal" : null,
    temperatureChange ? "temperature" : null,
  ].filter((value): value is string => value !== null);
  const cardiovascularSupport = cardiovascularSources(input);
  const supportingForDimensions: AnalysisModality[] = [
    ...cardiovascularSupport,
    ...(electrodermalChange ? ["gsr" as const] : []),
    ...(temperatureChange ? ["temperature" as const] : []),
  ];
  const supportingModalities = [...new Set(supportingForDimensions)];
  const usableCount = usableModalities(input.qualities).length;

  const sameMultimodalCondition =
    activeDimensions.length >= 2 &&
    supportingModalities.length >= 2 &&
    !movementHigh &&
    !disagreement &&
    !comparisonUnavailable;
  const dimensionKey = activeDimensions.join("+");
  if (sameMultimodalCondition) {
    if (input.persistence.previousDimensionKey === dimensionKey) {
      input.persistence.consecutiveSameCondition += 1;
    } else {
      input.persistence.previousDimensionKey = dimensionKey;
      input.persistence.consecutiveSameCondition = 1;
    }
  } else {
    input.persistence.previousDimensionKey = null;
    input.persistence.consecutiveSameCondition = 0;
  }

  let pattern: MultimodalAnalysisResult["pattern"];
  let selectedRuleId: string;
  let supporting: AnalysisModality[];
  let contradicting: AnalysisModality[] = [];

  if (disagreement) {
    pattern = "Cardiovascular measurement disagreement";
    selectedRuleId = "MM-06";
    supporting = ["ecg", "ppg"];
    contradicting = ["ecg", "ppg"];
  } else if (cardiovascularChange && movementHigh) {
    pattern = "Cardiovascular change co-occurred with elevated movement";
    selectedRuleId = "MM-01";
    supporting = [...cardiovascularSupport, "imu"];
  } else if (sameMultimodalCondition && input.persistence.consecutiveSameCondition >= 2) {
    pattern = "Multi-modality physiological change observed";
    selectedRuleId = "MM-02";
    supporting = supportingModalities;
  } else if (cardiovascularChange && !electrodermalChange && !temperatureChange) {
    pattern = "Isolated cardiovascular change observed";
    selectedRuleId = "MM-03";
    supporting = cardiovascularSupport;
  } else if (!cardiovascularChange && electrodermalChange && !temperatureChange) {
    pattern = "Isolated electrodermal change observed";
    selectedRuleId = "MM-04";
    supporting = ["gsr"];
  } else if (!cardiovascularChange && !electrodermalChange && temperatureChange) {
    pattern = "Isolated local skin-temperature change observed";
    selectedRuleId = "MM-05";
    supporting = ["temperature"];
  } else if (input.baselineReady && usableCount >= 3 && !disagreement && !cardiovascularChange && !electrodermalChange && !temperatureChange) {
    pattern = "No material change from session baseline observed";
    selectedRuleId = "MM-08";
    supporting = usableModalities(input.qualities);
  } else {
    pattern = "Insufficient evidence for multimodal interpretation";
    selectedRuleId = "MM-07";
    supporting = [];
  }

  const evidenceTier = assignEvidenceTier(
    pattern,
    supporting,
    input,
    input.persistence.consecutiveSameCondition,
    comparisonUnavailable,
  );
  return {
    pattern,
    evidence_tier: evidenceTier,
    supporting_modalities: supporting,
    contradicting_modalities: contradicting,
    rule_ids: pattern === "Cardiovascular measurement disagreement"
      ? ["PPG-02", selectedRuleId]
      : [selectedRuleId],
    explanation: explanation(pattern),
  };
}

function assignEvidenceTier(
  pattern: MultimodalAnalysisResult["pattern"],
  supporting: readonly AnalysisModality[],
  input: MultimodalRuleInput,
  sameConditionCount: number,
  comparisonUnavailable: boolean,
): EvidenceTier {
  if (
    pattern === "Cardiovascular measurement disagreement" ||
    pattern === "Insufficient evidence for multimodal interpretation" ||
    comparisonUnavailable
  ) {
    return "insufficient";
  }
  if (
    pattern === "Multi-modality physiological change observed" &&
    supporting.length >= 3 &&
    supporting.filter((modality) => input.qualities[modality].state === "good").length >= 3 &&
    sameConditionCount >= 3
  ) {
    return "corroborated";
  }
  if (
    pattern === "Multi-modality physiological change observed" &&
    supporting.length >= 2 &&
    supporting.every((modality) => qualityAtLeastUsable(input.qualities[modality].state)) &&
    sameConditionCount >= 2
  ) {
    return "moderate";
  }
  if (
    pattern === "No material change from session baseline observed" &&
    input.baselineCollectionComplete &&
    supporting.length >= 3 &&
    supporting.every((modality) => input.qualities[modality].state === "good")
  ) {
    return "moderate";
  }
  return "limited";
}
