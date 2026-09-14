import { clamp } from "./statistics.js";
import { LARGE_GAP_MS } from "./windows.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisModality,
  AnalysisPpgSample,
  AnalysisTempSample,
  AnalysisWindow,
  EcgFeatures,
  GsrFeatures,
  ImuFeatures,
  ModalityQuality,
  PpgFeatures,
  TemperatureFeatures,
} from "./types.js";

export const EXPECTED_SAMPLE_COUNTS: Record<AnalysisModality, number> = {
  ecg: 2_500,
  ppg: 1_000,
  gsr: 1_280,
  imu: 1_000,
  temperature: 20,
};

export interface QualityEvidence {
  ecgValidRrCount?: number;
  ppgValidIntervalCount?: number;
}

interface WindowGapSummary {
  maxGapMs: number | null;
  largeGap: boolean;
  packetGap: boolean;
}

function qualityBase(modality: AnalysisModality, sampleCount: number, gap: WindowGapSummary): ModalityQuality {
  const expected = EXPECTED_SAMPLE_COUNTS[modality];
  return {
    state: "unavailable",
    sample_count: sampleCount,
    expected_sample_count: expected,
    coverage_fraction: clamp(sampleCount / expected, 0, 1),
    max_gap_ms: gap.maxGapMs,
    packet_gap: gap.packetGap,
    reason_codes: [],
  };
}

function gapSummary(
  window: AnalysisWindow,
  modality: AnalysisModality,
  samples: readonly { sampleTimeMs: number }[],
): WindowGapSummary {
  const gaps = window.metadata.sampleGapEvents.filter((event) => event.modality === modality);
  const maxGapMs = gaps.length === 0 ? null : Math.max(...gaps.map((event) => event.gapMs));
  const largeGap = gaps.some((event) => event.gapMs > LARGE_GAP_MS[modality]);
  return {
    maxGapMs,
    largeGap,
    packetGap: window.metadata.packetGapEvents.length > 0,
  };
}

function orderedReasons(candidates: readonly [string, boolean][], priority: readonly string[]): string[] {
  const present = new Set(candidates.filter(([, condition]) => condition).map(([code]) => code));
  return priority.filter((code) => present.has(code));
}

export function evaluateEcgQuality(
  window: AnalysisWindow,
  samples: readonly AnalysisEcgSample[],
  features: EcgFeatures,
  validRrCount: number,
): ModalityQuality {
  const gap = gapSummary(window, "ecg", samples);
  const quality = qualityBase("ecg", samples.length, gap);
  const coverage = quality.coverage_fraction;
  const leadOffOver50 = features.lead_off_fraction > 0.5;
  const leadOffOver20 = features.lead_off_fraction > 0.2;
  const leadOffOver5 = features.lead_off_fraction > 0.05;
  const reasons = orderedReasons(
    [
      ["NO_SAMPLES", samples.length === 0],
      ["LEAD_OFF_OVER_50", leadOffOver50],
      ["COVERAGE_BELOW_50", coverage < 0.5],
      ["LEAD_OFF_OVER_20", leadOffOver20],
      ["RR_INSUFFICIENT", validRrCount < 4],
      ["LARGE_GAP", gap.largeGap],
      ["PACKET_GAP", gap.packetGap],
      ["COVERAGE_BELOW_80", coverage < 0.8],
      ["LEAD_OFF_OVER_5", leadOffOver5],
    ],
    [
      "NO_SAMPLES",
      "LEAD_OFF_OVER_50",
      "COVERAGE_BELOW_50",
      "LEAD_OFF_OVER_20",
      "RR_INSUFFICIENT",
      "LARGE_GAP",
      "PACKET_GAP",
      "COVERAGE_BELOW_80",
      "LEAD_OFF_OVER_5",
    ],
  );

  if (samples.length === 0 || leadOffOver50) {
    quality.state = "unavailable";
  } else if (
    leadOffOver20 ||
    validRrCount < 3 ||
    coverage < 0.5 ||
    gap.largeGap ||
    gap.packetGap
  ) {
    quality.state = "limited";
  } else if (
    coverage >= 0.8 &&
    features.lead_off_fraction <= 0.05 &&
    validRrCount >= 4 &&
    !gap.largeGap &&
    !gap.packetGap
  ) {
    quality.state = "good";
  } else {
    quality.state = "usable";
  }
  quality.reason_codes = reasons;
  return quality;
}

export function evaluatePpgQuality(
  window: AnalysisWindow,
  samples: readonly AnalysisPpgSample[],
  features: PpgFeatures,
  validIntervalCount: number,
  movementLevel: ImuFeatures["movement_level"] = null,
): ModalityQuality {
  const gap = gapSummary(window, "ppg", samples);
  const quality = qualityBase("ppg", samples.length, gap);
  const coverage = quality.coverage_fraction;
  const noValidPulses = samples.length > 0 && validIntervalCount === 0;
  const highMotion = movementLevel === "high";
  const reasons = orderedReasons(
    [
      ["NO_SAMPLES", samples.length === 0],
      ["NO_VALID_PULSES", noValidPulses],
      ["COVERAGE_BELOW_50", coverage < 0.5],
      ["PULSE_INTERVAL_INSUFFICIENT", validIntervalCount < 4],
      ["HIGH_MOTION", highMotion],
      ["LARGE_GAP", gap.largeGap],
      ["PACKET_GAP", gap.packetGap],
      ["COVERAGE_BELOW_80", coverage < 0.8],
    ],
    [
      "NO_SAMPLES",
      "NO_VALID_PULSES",
      "COVERAGE_BELOW_50",
      "PULSE_INTERVAL_INSUFFICIENT",
      "HIGH_MOTION",
      "LARGE_GAP",
      "PACKET_GAP",
      "COVERAGE_BELOW_80",
    ],
  );

  if (samples.length === 0 || noValidPulses) {
    quality.state = "unavailable";
  } else if (
    coverage < 0.5 ||
    validIntervalCount === 1 ||
    validIntervalCount === 2 ||
    features.pulse_rate_bpm === null ||
    highMotion ||
    gap.largeGap ||
    gap.packetGap
  ) {
    quality.state = "limited";
  } else if (
    coverage >= 0.8 &&
    validIntervalCount >= 4 &&
    !highMotion &&
    !gap.largeGap &&
    !gap.packetGap
  ) {
    quality.state = "good";
  } else {
    quality.state = "usable";
  }
  quality.reason_codes = reasons;
  return quality;
}

export function evaluateGsrQuality(
  window: AnalysisWindow,
  samples: readonly AnalysisGsrSample[],
): ModalityQuality {
  const gap = gapSummary(window, "gsr", samples);
  const quality = qualityBase("gsr", samples.length, gap);
  const coverage = quality.coverage_fraction;
  const saturatedCount = samples.filter((sample) => sample.raw <= -2_048 || sample.raw >= 2_047).length;
  const saturatedFraction = samples.length === 0 ? 0 : saturatedCount / samples.length;
  const saturated = saturatedFraction >= 0.05;
  quality.reason_codes = orderedReasons(
    [
      ["NO_SAMPLES", samples.length === 0],
      ["COVERAGE_BELOW_50", coverage < 0.5],
      ["LARGE_GAP", gap.largeGap],
      ["PACKET_GAP", gap.packetGap],
      ["SATURATED", saturated],
      ["COVERAGE_BELOW_80", coverage < 0.8],
    ],
    ["NO_SAMPLES", "COVERAGE_BELOW_50", "LARGE_GAP", "PACKET_GAP", "SATURATED", "COVERAGE_BELOW_80"],
  );
  if (samples.length === 0) {
    quality.state = "unavailable";
  } else if (coverage < 0.5 || gap.largeGap || gap.packetGap || saturated) {
    quality.state = "limited";
  } else if (coverage >= 0.8 && !gap.largeGap && !gap.packetGap && !saturated) {
    quality.state = "good";
  } else {
    quality.state = "usable";
  }
  return quality;
}

export function evaluateImuQuality(
  window: AnalysisWindow,
  samples: readonly AnalysisImuSample[],
): ModalityQuality {
  const gap = gapSummary(window, "imu", samples);
  const quality = qualityBase("imu", samples.length, gap);
  const coverage = quality.coverage_fraction;
  quality.reason_codes = orderedReasons(
    [
      ["NO_SAMPLES", samples.length === 0],
      ["COVERAGE_BELOW_50", coverage < 0.5],
      ["LARGE_GAP", gap.largeGap],
      ["PACKET_GAP", gap.packetGap],
      ["COVERAGE_BELOW_80", coverage < 0.8],
    ],
    ["NO_SAMPLES", "COVERAGE_BELOW_50", "LARGE_GAP", "PACKET_GAP", "COVERAGE_BELOW_80"],
  );
  if (samples.length === 0) {
    quality.state = "unavailable";
  } else if (coverage < 0.5 || gap.largeGap || gap.packetGap) {
    quality.state = "limited";
  } else if (coverage >= 0.8 && !gap.largeGap && !gap.packetGap) {
    quality.state = "good";
  } else {
    quality.state = "usable";
  }
  return quality;
}

export function evaluateTemperatureQuality(
  window: AnalysisWindow,
  samples: readonly AnalysisTempSample[],
): ModalityQuality {
  const gap = gapSummary(window, "temperature", samples);
  const quality = qualityBase("temperature", samples.length, gap);
  const coverage = quality.coverage_fraction;
  const stale = samples.length > 0 && samples.at(-1)!.sampleTimeMs < window.window.end_ms - 1_500;
  quality.reason_codes = orderedReasons(
    [
      ["NO_SAMPLES", samples.length === 0],
      ["SAMPLES_BELOW_10", samples.length > 0 && samples.length < 10],
      ["STALE", stale],
      ["LARGE_GAP", gap.largeGap],
      ["PACKET_GAP", gap.packetGap],
      ["SAMPLES_BELOW_16", samples.length > 0 && samples.length < 16],
    ],
    ["NO_SAMPLES", "SAMPLES_BELOW_10", "STALE", "LARGE_GAP", "PACKET_GAP", "SAMPLES_BELOW_16"],
  );
  if (samples.length === 0) {
    quality.state = "unavailable";
  } else if (samples.length < 10 || coverage < 0.5 || stale || gap.largeGap || gap.packetGap) {
    quality.state = "limited";
  } else if (samples.length >= 16 && !gap.largeGap && !gap.packetGap) {
    quality.state = "good";
  } else {
    quality.state = "usable";
  }
  return quality;
}

export function evaluateQuality(
  window: AnalysisWindow,
  features: {
    ecg: EcgFeatures;
    ppg: PpgFeatures;
    gsr: GsrFeatures;
    imu: ImuFeatures;
    temperature: TemperatureFeatures;
  },
  evidence: QualityEvidence = {},
): {
  ecg: ModalityQuality;
  ppg: ModalityQuality;
  gsr: ModalityQuality;
  imu: ModalityQuality;
  temperature: ModalityQuality;
} {
  const ecg = evaluateEcgQuality(window, window.samples.ecg, features.ecg, evidence.ecgValidRrCount ?? 0);
  const ppg = evaluatePpgQuality(
    window,
    window.samples.ppg,
    features.ppg,
    evidence.ppgValidIntervalCount ?? 0,
    features.imu.movement_level,
  );
  return {
    ecg,
    ppg,
    gsr: evaluateGsrQuality(window, window.samples.gsr),
    imu: evaluateImuQuality(window, window.samples.imu),
    temperature: evaluateTemperatureQuality(window, window.samples.temperature),
  };
}

export function qualityAtLeastUsable(state: ModalityQuality["state"]): boolean {
  return state === "good" || state === "usable";
}
