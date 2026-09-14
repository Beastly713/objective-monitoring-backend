import assert from "node:assert/strict";
import test from "node:test";

import {
  createRulePersistenceState,
  evaluateEcgRules,
  evaluateGsrRules,
  evaluateImuRules,
  evaluatePpgRules,
  evaluateTemperatureRules,
} from "./analysis/rules.js";
import type {
  EcgFeatures,
  GsrFeatures,
  ImuFeatures,
  ModalityQuality,
  PpgFeatures,
  TemperatureFeatures,
} from "./analysis/types.js";

function quality(state: ModalityQuality["state"], sampleCount = 100): ModalityQuality {
  return {
    state,
    sample_count: sampleCount,
    expected_sample_count: 100,
    coverage_fraction: 1,
    max_gap_ms: null,
    packet_gap: false,
    reason_codes: [],
  };
}

const ecgFeatures: EcgFeatures = {
  beat_count: 5,
  heart_rate_bpm: 92,
  rr_interval_ms: 652.173913,
  rr_mean_ms: 652.173913,
  rr_std_ms: 0,
  ecg_range_adc: 20,
  lead_off_fraction: 0,
};

const ppgFeatures: PpgFeatures = {
  pulse_count: 5,
  pulse_rate_bpm: 70,
  pulse_interval_ms: 857.142857,
  pulse_interval_mean_ms: 857.142857,
  pulse_interval_std_ms: 0,
  pulse_amplitude_raw: 30,
  ppg_red_mean: 100,
  ppg_ir_mean: 200,
  ppg_red_std: 1,
  ppg_ir_std: 2,
};

const gsrFeatures: GsrFeatures = {
  gsr_raw_mean: 128.826,
  gsr_raw_min: 100,
  gsr_raw_max: 150,
  gsr_raw_range: 50,
  gsr_raw_std: 10,
  gsr_raw_delta_from_baseline: 28.826,
  gsr_raw_slope_raw_per_s: 1,
  gsr_robust_z: 2,
};

const imuFeatures: ImuFeatures = {
  acceleration_magnitude_g_mean: 1.2,
  acceleration_magnitude_g_std: 0,
  motion_index_g: 0.2,
  gyro_magnitude_dps_mean: 1,
  movement_level: "high",
};

const temperatureFeatures: TemperatureFeatures = {
  temperature_mean_c: 30.5,
  temperature_min_c: 30,
  temperature_max_c: 31,
  temperature_delta_c: 0.5,
  temperature_slope_c_per_min: 0.01,
};

test("ECG-01 uses an inclusive 15% threshold and two-window persistence", () => {
  const state = createRulePersistenceState();
  const first = evaluateEcgRules({ quality: quality("usable"), features: ecgFeatures, baseline: { median: 80, mad: 2 }, state });
  assert.equal(first.find((rule) => rule.rule_id === "ECG-01")?.status, "not_fired");
  const second = evaluateEcgRules({ quality: quality("usable"), features: ecgFeatures, baseline: { median: 80, mad: 2 }, state });
  assert.equal(second.find((rule) => rule.rule_id === "ECG-01")?.status, "fired");

  const falseWindow = evaluateEcgRules({
    quality: quality("usable"),
    features: { ...ecgFeatures, heart_rate_bpm: 91.999 },
    baseline: { median: 80, mad: 2 },
    state,
  });
  assert.equal(falseWindow.find((rule) => rule.rule_id === "ECG-01")?.status, "not_fired");
});
test("ECG-02 fires only for present ECG with insufficient beat evidence", () => {
  const rules = evaluateEcgRules({
    quality: { ...quality("limited"), reason_codes: ["RR_INSUFFICIENT"] },
    features: { ...ecgFeatures, heart_rate_bpm: null },
    baseline: undefined,
    state: createRulePersistenceState(),
  });
  assert.equal(rules.find((rule) => rule.rule_id === "ECG-02")?.status, "fired");
});

test("PPG-02 is strict above max(10 bpm, 10 percent)", () => {
  const exact = evaluatePpgRules({
    quality: quality("usable"),
    features: ppgFeatures,
    baseline: { median: 70, mad: 1 },
    state: createRulePersistenceState(),
    ecgQuality: quality("usable"),
    ecgFeatures: { ...ecgFeatures, heart_rate_bpm: 80 },
  });
  assert.equal(exact.find((rule) => rule.rule_id === "PPG-02")?.status, "not_fired");
  const above = evaluatePpgRules({
    quality: quality("usable"),
    features: { ...ppgFeatures, pulse_rate_bpm: 69.9999 },
    baseline: { median: 70, mad: 1 },
    state: createRulePersistenceState(),
    ecgQuality: quality("usable"),
    ecgFeatures: { ...ecgFeatures, heart_rate_bpm: 80 },
  });
  assert.equal(above.find((rule) => rule.rule_id === "PPG-02")?.status, "fired");
});

test("GSR-01 and TEMP-01 preserve their inclusive thresholds and persistence", () => {
  const gsrState = createRulePersistenceState();
  const gsrInput = {
    quality: quality("usable"),
    features: gsrFeatures,
    baseline: { median: 100, mad: 10 },
    state: gsrState,
  };
  assert.equal(evaluateGsrRules(gsrInput)[0].status, "not_fired");
  assert.equal(evaluateGsrRules(gsrInput)[0].status, "fired");

  const tempState = createRulePersistenceState();
  const tempInput = {
    quality: quality("usable"),
    features: temperatureFeatures,
    baseline: { median: 30, mad: 0 },
    state: tempState,
  };
  assert.equal(evaluateTemperatureRules(tempInput)[0].status, "not_fired");
  assert.equal(evaluateTemperatureRules(tempInput)[0].status, "not_fired");
  assert.equal(evaluateTemperatureRules(tempInput)[0].status, "fired");
});

test("IMU-01 fires for high movement without persistence", () => {
  const result = evaluateImuRules({ quality: quality("usable"), features: imuFeatures, baselineReady: false });
  assert.equal(result[0].status, "fired");
  assert.equal(result[0].threshold_source, "prototype_heuristic");
});
