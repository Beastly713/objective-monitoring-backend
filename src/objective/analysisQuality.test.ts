import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEcgQuality,
  evaluateGsrQuality,
  evaluatePpgQuality,
  evaluateTemperatureQuality,
} from "./analysis/quality.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisPpgSample,
  AnalysisTempSample,
  AnalysisWindow,
  EcgFeatures,
  PpgFeatures,
} from "./analysis/types.js";

function windowWith<T extends AnalysisWindow["samples"][keyof AnalysisWindow["samples"]]>(
  modality: keyof AnalysisWindow["samples"],
  samples: T[],
  sampleGapEvents: AnalysisWindow["metadata"]["sampleGapEvents"] = [],
): AnalysisWindow {
  return {
    sessionId: "session",
    epochId: "epoch",
    espAnchorUs: 1_000_000,
    window: { start_us: 1_000_000, end_us: 11_000_000, start_ms: 0, end_ms: 10_000, duration_ms: 10_000 },
    samples: {
      ecg: modality === "ecg" ? samples as AnalysisEcgSample[] : [],
      ppg: modality === "ppg" ? samples as AnalysisPpgSample[] : [],
      gsr: modality === "gsr" ? samples as AnalysisGsrSample[] : [],
      imu: [],
      temperature: modality === "temperature" ? samples as AnalysisTempSample[] : [],
    },
    metadata: {
      packetMetadata: [],
      packetGapEvents: [],
      sampleGapEvents,
      analysisInputGapEvents: [],
      discardedOutOfOrderSamples: [],
    },
  };
}

function tempSamples(count: number): AnalysisTempSample[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: index * 1_000_000,
    sampleTimeMs: count === 1 ? 9_000 : Math.round((index * 9_000) / (count - 1)),
    modality: "temperature" as const,
    temperatureC: 30,
  }));
}

function ppgSample(index: number): AnalysisPpgSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: index * 10_000,
    sampleTimeMs: index * 10,
    modality: "ppg",
    red: 100,
    ir: 200,
  };
}

const ppgFeatures: PpgFeatures = {
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

const ecgFeatures: EcgFeatures = {
  beat_count: 5,
  heart_rate_bpm: 75,
  rr_interval_ms: 800,
  rr_mean_ms: 800,
  rr_std_ms: 0,
  ecg_range_adc: 10,
  lead_off_fraction: 0,
};

test("temperature quality follows the exact sample-count boundaries", () => {
  const states = [0, 1, 9, 10, 15, 16].map((count) => {
    const samples = tempSamples(count);
    return evaluateTemperatureQuality(windowWith("temperature", samples), samples);
  });
  assert.deepEqual(states.map((quality) => quality.state), [
    "unavailable",
    "limited",
    "limited",
    "usable",
    "usable",
    "good",
  ]);
  assert.equal(states[1].reason_codes.includes("SAMPLES_BELOW_10"), true);
  assert.equal(states[5].coverage_fraction, 0.8);
});
test("ECG and PPG quality distinguish absent evidence from limited evidence", () => {
  const noEcg = evaluateEcgQuality(windowWith("ecg", []), [], ecgFeatures, 0);
  assert.equal(noEcg.state, "unavailable");
  const ecg = Array.from({ length: 2_500 }, (_, index) => ({
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: index * 4_000,
    sampleTimeMs: index * 4,
    modality: "ecg" as const,
    adc: 1000,
    loPlus: 0 as const,
    loMinus: 0 as const,
  }));
  assert.equal(evaluateEcgQuality(windowWith("ecg", ecg), ecg, ecgFeatures, 4).state, "good");

  const noPulses = Array.from({ length: 100 }, (_, index) => ppgSample(index));
  const unavailable = evaluatePpgQuality(windowWith("ppg", noPulses), noPulses, {
    ...ppgFeatures,
    pulse_rate_bpm: null,
  }, 0);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.reason_codes.includes("NO_VALID_PULSES"), true);
  const limited = evaluatePpgQuality(windowWith("ppg", noPulses), noPulses, ppgFeatures, 1);
  assert.equal(limited.state, "limited");
});

test("quality records fixed large-gap and legacy GSR saturation semantics", () => {
  const gsr = Array.from({ length: 100 }, (_, index): AnalysisGsrSample => ({
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: index * 100_000,
    sampleTimeMs: index * 100,
    modality: "gsr",
    raw: index < 6 ? 2_047 : 1_000,
  }));
  const gsrQuality = evaluateGsrQuality(windowWith("gsr", gsr), gsr);
  assert.equal(gsrQuality.state, "limited");
  assert.equal(gsrQuality.reason_codes.includes("SATURATED"), true);

  const gapWindow = windowWith("ppg", [ppgSample(0), ppgSample(100)], [
    { modality: "ppg", startMs: 0, endMs: 100, gapMs: 100 },
  ]);
  const gapQuality = evaluatePpgQuality(gapWindow, gapWindow.samples.ppg, ppgFeatures, 4);
  assert.equal(gapQuality.state, "limited");
  assert.equal(gapQuality.reason_codes.includes("LARGE_GAP"), true);
});
