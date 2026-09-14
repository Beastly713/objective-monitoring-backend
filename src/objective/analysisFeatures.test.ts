import assert from "node:assert/strict";
import test from "node:test";

import {
  EcgStreamingDetector,
  PpgStreamingDetector,
  calculateGsrFeatures,
  calculateImuFeatures,
  calculateTemperatureFeatures,
} from "./analysis/features.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisPpgSample,
  AnalysisTempSample,
} from "./analysis/types.js";

function ecgSample(timeMs: number, adc: number, loPlus: 0 | 1 = 0, loMinus: 0 | 1 = 0): AnalysisEcgSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: timeMs * 1_000,
    sampleTimeMs: timeMs,
    modality: "ecg",
    adc,
    loPlus,
    loMinus,
  };
}

function ppgSample(timeMs: number, ir: number, red = 900): AnalysisPpgSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: timeMs * 1_000,
    sampleTimeMs: timeMs,
    modality: "ppg",
    red,
    ir,
  };
}

function gsrSample(timeMs: number, raw: number): AnalysisGsrSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: timeMs * 1_000,
    sampleTimeMs: timeMs,
    modality: "gsr",
    raw,
  };
}

function imuSample(timeMs: number, axG: number, ayG: number, azG: number): AnalysisImuSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: timeMs * 1_000,
    sampleTimeMs: timeMs,
    modality: "imu",
    axG,
    ayG,
    azG,
    gxDps: 1,
    gyDps: 2,
    gzDps: 2,
  };
}

function temperatureSample(timeMs: number, temperatureC: number): AnalysisTempSample {
  return {
    sessionId: "session",
    bootId: "boot",
    epochId: "epoch",
    packetSeq: 1,
    sampleTimeUs: timeMs * 1_000,
    sampleTimeMs: timeMs,
    modality: "temperature",
    temperatureC,
  };
}

test("ECG detector retains streaming state and extracts deterministic RR features", () => {
  const detector = new EcgStreamingDetector();
  const centers = [2_000, 2_800, 3_600, 4_400];
  const samples: AnalysisEcgSample[] = [];
  for (let timeMs = 0; timeMs <= 6_000; timeMs += 4) {
    let adc = 1_000;
    for (const center of centers) {
      const offset = timeMs - center;
      adc = offset === -20 ? 1_005
        : offset === -16 ? 1_025
          : offset === -12 ? 1_060
            : offset === -8 ? 1_100
              : offset === -4 ? 1_050
                : offset === 0 ? 1_000
                  : adc;
    }
    samples.push(ecgSample(timeMs, adc));
  }
  detector.process(samples);
  const beats = detector.getAcceptedBeats();
  assert.equal(beats.length, 4);
  assert.deepEqual(detector.getValidRrIntervals(0, 6_000), [800, 800, 800]);
  const features = detector.extractFeatures(samples, 0, 6_000);
  assert.equal(features.heart_rate_bpm, 75);
  assert.equal(features.rr_interval_ms, 800);
  assert.equal(features.rr_mean_ms, 800);
  assert.equal(features.rr_std_ms, null);
});

test("ECG lead-off and out-of-order samples cannot create a bridged interval", () => {
  const detector = new EcgStreamingDetector();
  detector.process([
    ecgSample(0, 1000),
    ecgSample(4, 1001),
    ecgSample(2, 1002),
    ecgSample(8, 1000, 1, 0),
    ecgSample(12, 1001),
  ]);
  assert.equal(detector.getOutOfOrderSampleCount(), 1);
  assert.deepEqual(detector.getValidRrIntervals(0, 100), []);
});

test("PPG detector uses strict local maxima and produces a 75 bpm pulse train", () => {
  const detector = new PpgStreamingDetector();
  const samples: AnalysisPpgSample[] = [];
  for (let timeMs = 0; timeMs <= 8_000; timeMs += 10) {
    let ir = 1_000;
    for (let center = 2_000; center <= 5_200; center += 800) {
      const offset = timeMs - center;
      ir = offset === -10 ? 1_100
        : offset === 0 ? 1_300
          : offset === 10 ? 1_100
            : ir;
    }
    samples.push(ppgSample(timeMs, ir));
  }
  detector.process(samples);
  assert.equal(detector.getAcceptedPulses().length, 5);
  assert.deepEqual(detector.getValidIntervals(0, 8_000), [800, 800, 800, 800]);
  assert.equal(detector.extractFeatures(samples, 0, 8_000).pulse_rate_bpm, 75);

  const plateauDetector = new PpgStreamingDetector();
  const plateau: AnalysisPpgSample[] = [];
  for (let timeMs = 0; timeMs <= 2_000; timeMs += 10) {
    const ir = timeMs >= 1_500 && timeMs <= 1_510 ? 1_300 : 1_000;
    plateau.push(ppgSample(timeMs, ir));
  }
  plateauDetector.process(plateau);
  assert.equal(plateauDetector.getAcceptedPulses().length, 0);
});

test("PPG gap reset prevents intervals from spanning a discontinuity", () => {
  const detector = new PpgStreamingDetector();
  const samples = [
    ...Array.from({ length: 120 }, (_, index) => ppgSample(index * 10, 1000)),
    ppgSample(2_000, 1000),
    ppgSample(2_010, 1200),
    ppgSample(2_020, 1000),
  ];
  detector.process(samples);
  assert.deepEqual(detector.getValidIntervals(0, 3_000), []);
});

test("GSR, IMU, and temperature features use the specified engineering-domain formulas", () => {
  const gsr = calculateGsrFeatures(Array.from({ length: 10 }, (_, index) => gsrSample(index * 1_000, index * 10)));
  assert.equal(gsr.gsr_raw_mean, 45);
  assert.equal(gsr.gsr_raw_slope_raw_per_s, 10);
  assert.equal(gsr.gsr_raw_std, Math.sqrt(825));

  const imu = calculateImuFeatures([
    imuSample(0, 0, 0, 1),
    imuSample(1_000, 0, 0, 1),
  ]);
  assert.equal(imu.acceleration_magnitude_g_mean, 1);
  assert.equal(imu.motion_index_g, 0);
  assert.equal(imu.movement_level, "low");

  const temperature = calculateTemperatureFeatures([
    temperatureSample(0, 30),
    temperatureSample(30_000, 30.5),
    temperatureSample(60_000, 31),
  ]);
  assert.equal(temperature.temperature_slope_c_per_min, 1);
  assert.equal(temperature.temperature_mean_c, 30.5);
});
