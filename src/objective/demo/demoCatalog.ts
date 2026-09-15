import type { DemoScenarioDefinition, DemoScenarioId } from "./demoTypes.js";

export const DEMO_SCENARIOS: readonly DemoScenarioDefinition[] = [
  {
    id: "stable_baseline",
    title: "Stable physiological baseline",
    description: "All five synthetic modalities remain close to the established baseline.",
    expected_pattern: "No material change from session baseline observed",
    expected_rule_ids: ["MM-08"],
    expected_evidence_tier: "moderate",
    hidden_prime_duration_ms: 0,
    visible_duration_ms: 30_000,
  },
  {
    id: "isolated_cardiovascular_change",
    title: "Isolated cardiovascular change at rest",
    description: "ECG and PPG rates change together while electrodermal, temperature, and motion signals stay stable.",
    expected_pattern: "Isolated cardiovascular change observed",
    expected_rule_ids: ["ECG-01", "PPG-01", "MM-03"],
    expected_evidence_tier: "limited",
    hidden_prime_duration_ms: 10_000,
    visible_duration_ms: 30_000,
  },
  {
    id: "isolated_electrodermal_change",
    title: "Isolated electrodermal change",
    description: "GSR rises with a deterministic positive slope while cardiovascular and temperature signals remain stable.",
    expected_pattern: "Isolated electrodermal change observed",
    expected_rule_ids: ["GSR-01", "MM-04"],
    expected_evidence_tier: "limited",
    hidden_prime_duration_ms: 10_000,
    visible_duration_ms: 30_000,
  },
  {
    id: "isolated_temperature_change",
    title: "Isolated local skin-temperature change",
    description: "Local synthetic skin temperature steps above baseline after the persistence requirement is primed.",
    expected_pattern: "Isolated local skin-temperature change observed",
    expected_rule_ids: ["TEMP-01", "MM-05"],
    expected_evidence_tier: "limited",
    hidden_prime_duration_ms: 20_000,
    visible_duration_ms: 30_000,
  },
  {
    id: "corroborated_multimodal_change",
    title: "Corroborated multimodal physiological change",
    description: "ECG, PPG, and GSR change together with good quality and no motion confound.",
    expected_pattern: "Multi-modality physiological change observed",
    expected_rule_ids: ["ECG-01", "PPG-01", "GSR-01", "MM-02"],
    expected_evidence_tier: "corroborated",
    hidden_prime_duration_ms: 30_000,
    visible_duration_ms: 30_000,
  },
] as const;

const scenarioById = new Map<DemoScenarioId, DemoScenarioDefinition>(
  DEMO_SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

export function getDemoScenario(id: string): DemoScenarioDefinition | undefined {
  return scenarioById.get(id as DemoScenarioId);
}

export function listDemoScenarios(): DemoScenarioDefinition[] {
  return DEMO_SCENARIOS.map((scenario) => ({
    ...scenario,
    expected_rule_ids: [...scenario.expected_rule_ids],
  }));
}
