import assert from "node:assert/strict";
import test from "node:test";

import {
  createMultimodalPersistenceState,
  evaluateMultimodalRules,
} from "./analysis/multimodalRules.js";
import type {
  EcgFeatures,
  GsrFeatures,
  ImuFeatures,
  ModalityQuality,
  PpgFeatures,
  RuleEvaluation,
  TemperatureFeatures,
} from "./analysis/types.js";
import type { AllModalityRuleEvaluations } from "./analysis/rules.js";

function quality(state: ModalityQuality["state"] = "good"): ModalityQuality {
  return {
    state,
    sample_count: 100,
    expected_sample_count: 100,
    coverage_fraction: 1,
    max_gap_ms: null,
    packet_gap: false,
    reason_codes: [],
  };
}

function firedRule(ruleId: string): RuleEvaluation {
  return {
    rule_id: ruleId,
    status: "fired",
    inputs: {},
    evidence: [],
    threshold_source: "prototype_heuristic",
  };
}

function ruleSet(ids: Partial<Record<keyof AllModalityRuleEvaluations, string[]>> = {}): AllModalityRuleEvaluations {
  return {
    ecg: (ids.ecg ?? []).map(firedRule),
    ppg: (ids.ppg ?? []).map(firedRule),
    gsr: (ids.gsr ?? []).map(firedRule),
    imu: (ids.imu ?? []).map(firedRule),
    temperature: (ids.temperature ?? []).map(firedRule),
  };
}

function input(ids: Partial<Record<keyof AllModalityRuleEvaluations, string[]>> = {}) {
  const ecg: EcgFeatures = {
    beat_count: 5,
    heart_rate_bpm: 75,
    rr_interval_ms: 800,
    rr_mean_ms: 800,
    rr_std_ms: 0,
    ecg_range_adc: 10,
    lead_off_fraction: 0,
  };
  const ppg: PpgFeatures = {
    pulse_count: 5,
    pulse_rate_bpm: 75,
    pulse_interval_ms: 800,
    pulse_interval_mean_ms: 800,
    pulse_interval_std_ms: 0,
    pulse_amplitude_raw: 10,
    ppg_red_mean: 100,
    ppg_ir_mean: 200,
    ppg_red_std: 0,
    ppg_ir_std: 0,
  };
  const gsr: GsrFeatures = {
    gsr_raw_mean: 100,
    gsr_raw_min: 90,
    gsr_raw_max: 110,
    gsr_raw_range: 20,
    gsr_raw_std: 1,
    gsr_raw_delta_from_baseline: 0,
    gsr_raw_slope_raw_per_s: 0,
    gsr_robust_z: 0,
  };
  const imu: ImuFeatures = {
    acceleration_magnitude_g_mean: 1,
    acceleration_magnitude_g_std: 0,
    motion_index_g: 0,
    gyro_magnitude_dps_mean: 0,
    movement_level: "low",
  };
  const temperature: TemperatureFeatures = {
    temperature_mean_c: 30,
    temperature_min_c: 30,
    temperature_max_c: 30,
    temperature_delta_c: 0,
    temperature_slope_c_per_min: 0,
  };
  return {
    qualities: { ecg: quality(), ppg: quality(), gsr: quality(), imu: quality(), temperature: quality() },
    features: { ecg, ppg, gsr, imu, temperature },
    rules: ruleSet(ids),
    baselineReady: true,
    baselineCollectionComplete: true,
    persistence: createMultimodalPersistenceState(),
  };
}

test("multimodal precedence selects the one highest-priority pattern", () => {
  const disagreement = input({ ecg: ["ECG-01"], ppg: ["PPG-01", "PPG-02"], gsr: ["GSR-01"] });
  assert.equal(evaluateMultimodalRules(disagreement).pattern, "Cardiovascular measurement disagreement");

  const movement = input({ ecg: ["ECG-01"], imu: ["IMU-01"], gsr: ["GSR-01"] });
  movement.features.imu.movement_level = "high";
  assert.equal(evaluateMultimodalRules(movement).pattern, "Cardiovascular change co-occurred with elevated movement");

  const isolated = input({ ecg: ["ECG-01"] });
  assert.equal(evaluateMultimodalRules(isolated).pattern, "Isolated cardiovascular change observed");
  assert.deepEqual(evaluateMultimodalRules(isolated).supporting_modalities, ["ecg"]);
});

test("MM-02 requires the same dimension combination for two consecutive windows", () => {
  const stateful = input({ ecg: ["ECG-01"], gsr: ["GSR-01"] });
  const first = evaluateMultimodalRules(stateful);
  assert.equal(first.pattern, "Insufficient evidence for multimodal interpretation");
  assert.equal(first.evidence_tier, "insufficient");
  const second = evaluateMultimodalRules(stateful);
  assert.equal(second.pattern, "Multi-modality physiological change observed");
  assert.equal(second.evidence_tier, "moderate");
});

test("isolated GSR/temperature, no-change, and insufficient-evidence fallbacks are explicit", () => {
  const gsr = input({ gsr: ["GSR-01"] });
  assert.equal(evaluateMultimodalRules(gsr).pattern, "Isolated electrodermal change observed");

  const temperature = input({ temperature: ["TEMP-01"] });
  assert.equal(evaluateMultimodalRules(temperature).pattern, "Isolated local skin-temperature change observed");

  const noChange = input();
  assert.equal(evaluateMultimodalRules(noChange).pattern, "No material change from session baseline observed");
  assert.equal(evaluateMultimodalRules(noChange).evidence_tier, "moderate");

  const insufficient = input();
  insufficient.baselineReady = false;
  assert.equal(evaluateMultimodalRules(insufficient).pattern, "Insufficient evidence for multimodal interpretation");
  assert.equal(evaluateMultimodalRules(insufficient).evidence_tier, "insufficient");
});
