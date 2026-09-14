import {
  EPSILON,
  mad,
  mean,
  median,
  nearestRankPercentile,
  olsSlope,
  populationStd,
  robustZ,
} from "./statistics.js";
import type {
  AnalysisEcgSample,
  AnalysisGsrSample,
  AnalysisImuSample,
  AnalysisPpgSample,
  AnalysisTempSample,
  BaselineReference,
  EcgFeatures,
  GsrFeatures,
  ImuFeatures,
  PpgFeatures,
  TemperatureFeatures,
} from "./types.js";

const ECG_LARGE_GAP_US = 12_000;
const ECG_SMOOTHING_SAMPLES = 20;
const ECG_THRESHOLD_CONTEXT_SAMPLES = 2_500;
const ECG_THRESHOLD_WARMUP_SAMPLES = 250;
const ECG_CANDIDATE_MIN_MS = 20;
const ECG_CANDIDATE_MAX_MS = 200;
const ECG_REFINEMENT_RADIUS_US = 40_000;
const ECG_REFRACTORY_MS = 250;
const ECG_MIN_RR_MS = 300;
const ECG_MAX_RR_MS = 2_000;

const PPG_LARGE_GAP_US = 25_000;
const PPG_SMOOTHING_SAMPLES = 3;
const PPG_THRESHOLD_CONTEXT_SAMPLES = 1_000;
const PPG_THRESHOLD_WARMUP_SAMPLES = 100;
const PPG_TROUGH_LOOKBACK_US = 600_000;
const PPG_MIN_SPACING_MS = 300;

interface EcgWaveformPoint {
  timeUs: number;
  adc: number;
  segmentId: number;
}

interface EcgEnergyPoint {
  timeUs: number;
  rawEnergy: number;
  energySmooth: number;
  absoluteDerivative: number;
  segmentId: number;
}

interface EcgCandidate {
  members: EcgEnergyPoint[];
}

export interface DetectedEcgBeat {
  timeUs: number;
  timeMs: number;
  localDeflection: number;
  segmentId: number;
}

function isLeadOff(sample: AnalysisEcgSample): boolean {
  return sample.loPlus === 1 || sample.loMinus === 1;
}

export class EcgStreamingDetector {
  private previousSample: { timeUs: number; adc: number } | null = null;
  private lastInputTimeUs: number | null = null;
  private energyWindow: EcgEnergyPoint[] = [];
  private thresholdContext: number[] = [];
  private candidate: EcgCandidate | null = null;
  private readonly acceptedBeats: DetectedEcgBeat[] = [];
  private readonly waveform: EcgWaveformPoint[] = [];
  private segmentStartUs: number | null = null;
  private segmentId = 0;
  private outOfOrderSamples = 0;

  process(samples: readonly AnalysisEcgSample[]): void {
    for (const sample of samples) {
      this.processSample(sample);
    }
  }

  processSample(sample: AnalysisEcgSample): void {
    if (this.lastInputTimeUs !== null && sample.sampleTimeUs < this.lastInputTimeUs) {
      this.outOfOrderSamples += 1;
      return;
    }
    this.lastInputTimeUs = sample.sampleTimeUs;

    if (isLeadOff(sample)) {
      this.resetSegment();
      return;
    }

    if (
      this.previousSample !== null &&
      sample.sampleTimeUs - this.previousSample.timeUs > ECG_LARGE_GAP_US
    ) {
      this.resetSegment();
    }

    if (this.segmentStartUs === null) {
      this.segmentStartUs = sample.sampleTimeUs;
    }
    this.waveform.push({ timeUs: sample.sampleTimeUs, adc: sample.adc, segmentId: this.segmentId });

    if (this.previousSample === null) {
      this.previousSample = { timeUs: sample.sampleTimeUs, adc: sample.adc };
      this.prune(sample.sampleTimeUs);
      return;
    }

    const derivative = sample.adc - this.previousSample.adc;
    this.previousSample = { timeUs: sample.sampleTimeUs, adc: sample.adc };
    const energy = derivative * derivative;
    const energyPoint: EcgEnergyPoint = {
      timeUs: sample.sampleTimeUs,
      rawEnergy: energy,
      energySmooth: 0,
      absoluteDerivative: Math.abs(derivative),
      segmentId: this.segmentId,
    };
    this.energyWindow.push(energyPoint);
    if (this.energyWindow.length > ECG_SMOOTHING_SAMPLES) {
      this.energyWindow.shift();
    }
    if (this.energyWindow.length < ECG_SMOOTHING_SAMPLES) {
      this.prune(sample.sampleTimeUs);
      return;
    }

    energyPoint.energySmooth = mean(this.energyWindow.map((point) => point.rawEnergy)) ?? 0;

    this.thresholdContext.push(energyPoint.energySmooth);
    if (this.thresholdContext.length > ECG_THRESHOLD_CONTEXT_SAMPLES) {
      this.thresholdContext.shift();
    }
    if (this.thresholdContext.length < ECG_THRESHOLD_WARMUP_SAMPLES) {
      this.prune(sample.sampleTimeUs);
      return;
    }

    const contextMedian = median(this.thresholdContext)!;
    const contextMad = mad(this.thresholdContext)!;
    const threshold = contextMedian + 4 * 1.4826 * contextMad;
    if (energyPoint.energySmooth > threshold) {
      if (this.candidate === null) {
        this.candidate = { members: [energyPoint] };
      } else {
        this.candidate.members.push(energyPoint);
      }
    } else if (this.candidate !== null) {
      this.finishCandidate();
    }
    this.prune(sample.sampleTimeUs);
  }

  getAcceptedBeats(): readonly DetectedEcgBeat[] {
    return this.acceptedBeats;
  }

  getOutOfOrderSampleCount(): number {
    return this.outOfOrderSamples;
  }

  getValidRrIntervals(startMs: number, endMs: number): number[] {
    const intervals: number[] = [];
    for (let index = 0; index < this.acceptedBeats.length; index += 1) {
      const current = this.acceptedBeats[index];
      if (current.timeMs < startMs || current.timeMs >= endMs) {
        continue;
      }
      const previous = this.previousBeatInSegment(index);
      if (previous === null) {
        continue;
      }
      const intervalMs = current.timeMs - previous.timeMs;
      if (intervalMs >= ECG_MIN_RR_MS && intervalMs <= ECG_MAX_RR_MS) {
        intervals.push(intervalMs);
      }
    }
    return intervals;
  }

  extractFeatures(
    samples: readonly AnalysisEcgSample[],
    startMs: number,
    endMs: number,
  ): EcgFeatures {
    const beats = this.acceptedBeats.filter((beat) => beat.timeMs >= startMs && beat.timeMs < endMs);
    const rrIntervals = this.getValidRrIntervals(startMs, endMs);
    const nonLeadOff = samples.filter((sample) => !isLeadOff(sample)).map((sample) => sample.adc);
    const allAdc = nonLeadOff.length === 0 ? null :
      nearestRankPercentile(nonLeadOff, 0.95)! - nearestRankPercentile(nonLeadOff, 0.05)!;
    const medianRr = median(rrIntervals);
    return {
      beat_count: beats.length,
      heart_rate_bpm: rrIntervals.length >= 3 ? 60_000 / medianRr! : null,
      rr_interval_ms: medianRr,
      rr_mean_ms: mean(rrIntervals),
      rr_std_ms: rrIntervals.length >= 5 ? populationStd(rrIntervals) : null,
      ecg_range_adc: allAdc,
      lead_off_fraction: samples.length === 0
        ? 0
        : samples.filter((sample) => isLeadOff(sample)).length / samples.length,
    };
  }

  reset(): void {
    this.previousSample = null;
    this.lastInputTimeUs = null;
    this.energyWindow = [];
    this.thresholdContext = [];
    this.candidate = null;
    this.acceptedBeats.length = 0;
    this.waveform.length = 0;
    this.segmentStartUs = null;
    this.segmentId = 0;
    this.outOfOrderSamples = 0;
  }

  private resetSegment(): void {
    this.previousSample = null;
    this.energyWindow = [];
    this.thresholdContext = [];
    this.candidate = null;
    this.segmentStartUs = null;
    this.segmentId += 1;
  }

  private finishCandidate(): void {
    const candidate = this.candidate;
    this.candidate = null;
    if (candidate === null || candidate.members.length === 0) {
      return;
    }
    const first = candidate.members[0];
    const last = candidate.members[candidate.members.length - 1];
    const durationMs = (last.timeUs - first.timeUs) / 1_000;
    if (durationMs < ECG_CANDIDATE_MIN_MS || durationMs > ECG_CANDIDATE_MAX_MS) {
      return;
    }

    let seed = candidate.members[0];
    for (const member of candidate.members.slice(1)) {
      if (
        member.absoluteDerivative > seed.absoluteDerivative ||
        (member.absoluteDerivative === seed.absoluteDerivative && member.timeUs < seed.timeUs)
      ) {
        seed = member;
      }
    }
    const searchStart = seed.timeUs - ECG_REFINEMENT_RADIUS_US;
    const searchEnd = seed.timeUs + ECG_REFINEMENT_RADIUS_US;
    const searchPoints = this.waveform.filter(
      (point) =>
        point.segmentId === seed.segmentId &&
        point.timeUs >= searchStart &&
        point.timeUs <= searchEnd,
    );
    if (searchPoints.length === 0) {
      return;
    }
    const localBaseline = median(searchPoints.map((point) => point.adc))!;
    let refined = searchPoints[0];
    let refinedDeflection = Math.abs(refined.adc - localBaseline);
    for (const point of searchPoints.slice(1)) {
      const deflection = Math.abs(point.adc - localBaseline);
      if (deflection > refinedDeflection || (deflection === refinedDeflection && point.timeUs < refined.timeUs)) {
        refined = point;
        refinedDeflection = deflection;
      }
    }
    this.acceptBeat({
      timeUs: refined.timeUs,
      timeMs: refined.timeUs / 1_000,
      localDeflection: refinedDeflection,
      segmentId: refined.segmentId,
    });
  }

  private acceptBeat(beat: DetectedEcgBeat): void {
    const previous = this.acceptedBeats.at(-1);
    if (previous !== undefined && previous.segmentId === beat.segmentId) {
      const separationMs = beat.timeMs - previous.timeMs;
      if (separationMs < ECG_REFRACTORY_MS) {
        const newWins =
          beat.localDeflection > previous.localDeflection ||
          (beat.localDeflection === previous.localDeflection && beat.timeMs < previous.timeMs);
        if (newWins) {
          this.acceptedBeats[this.acceptedBeats.length - 1] = beat;
        }
        return;
      }
    }
    this.acceptedBeats.push(beat);
  }

  private previousBeatInSegment(index: number): DetectedEcgBeat | null {
    const current = this.acceptedBeats[index];
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = this.acceptedBeats[previousIndex];
      if (previous.segmentId === current.segmentId) {
        return previous;
      }
    }
    return null;
  }

  private prune(currentTimeUs: number): void {
    const cutoffUs = currentTimeUs - 15_000_000;
    while (this.waveform.length > 0 && this.waveform[0].timeUs < cutoffUs) {
      this.waveform.shift();
    }
    while (this.acceptedBeats.length > 0 && this.acceptedBeats[0].timeUs < cutoffUs) {
      this.acceptedBeats.shift();
    }
  }
}

interface PpgRawPoint {
  timeUs: number;
  ir: number;
  segmentId: number;
}

interface PpgSmoothPoint {
  timeUs: number;
  value: number;
  segmentId: number;
}

export interface DetectedPpgPulse {
  timeUs: number;
  timeMs: number;
  ir: number;
  prominence: number;
  segmentId: number;
}

export class PpgStreamingDetector {
  private lastRawSample: { timeUs: number; ir: number } | null = null;
  private lastInputTimeUs: number | null = null;
  private smoothWindow: PpgRawPoint[] = [];
  private thresholdContext: number[] = [];
  private smoothPoints: PpgSmoothPoint[] = [];
  private readonly rawPoints: PpgRawPoint[] = [];
  private readonly acceptedPulses: DetectedPpgPulse[] = [];
  private segmentStartUs: number | null = null;
  private segmentId = 0;
  private outOfOrderSamples = 0;

  process(samples: readonly AnalysisPpgSample[]): void {
    for (const sample of samples) {
      this.processSample(sample);
    }
  }

  processSample(sample: AnalysisPpgSample): void {
    if (this.lastInputTimeUs !== null && sample.sampleTimeUs < this.lastInputTimeUs) {
      this.outOfOrderSamples += 1;
      return;
    }
    this.lastInputTimeUs = sample.sampleTimeUs;
    if (this.lastRawSample !== null && sample.sampleTimeUs - this.lastRawSample.timeUs > PPG_LARGE_GAP_US) {
      this.resetSegment();
    }
    if (this.segmentStartUs === null) {
      this.segmentStartUs = sample.sampleTimeUs;
    }

    const rawPoint: PpgRawPoint = {
      timeUs: sample.sampleTimeUs,
      ir: sample.ir,
      segmentId: this.segmentId,
    };
    this.rawPoints.push(rawPoint);
    this.lastRawSample = { timeUs: sample.sampleTimeUs, ir: sample.ir };
    this.smoothWindow.push(rawPoint);
    if (this.smoothWindow.length > PPG_SMOOTHING_SAMPLES) {
      this.smoothWindow.shift();
    }
    if (this.smoothWindow.length < PPG_SMOOTHING_SAMPLES) {
      this.prune(sample.sampleTimeUs);
      return;
    }

    const smoothPoint: PpgSmoothPoint = {
      timeUs: sample.sampleTimeUs,
      value: mean(this.smoothWindow.map((point) => point.ir))!,
      segmentId: this.segmentId,
    };
    this.smoothPoints.push(smoothPoint);
    this.thresholdContext.push(smoothPoint.value);
    if (this.thresholdContext.length > PPG_THRESHOLD_CONTEXT_SAMPLES) {
      this.thresholdContext.shift();
    }

    if (this.thresholdContext.length >= PPG_THRESHOLD_WARMUP_SAMPLES && this.smoothPoints.length >= 3) {
      const left = this.smoothPoints[this.smoothPoints.length - 3];
      const center = this.smoothPoints[this.smoothPoints.length - 2];
      const right = this.smoothPoints[this.smoothPoints.length - 1];
      if (
        left.segmentId === center.segmentId &&
        center.segmentId === right.segmentId &&
        center.value > left.value &&
        center.value > right.value
      ) {
        const troughPoints = this.smoothPoints.filter(
          (point) =>
            point.segmentId === center.segmentId &&
            point.timeUs >= Math.max(this.segmentStartUs!, center.timeUs - PPG_TROUGH_LOOKBACK_US) &&
            point.timeUs <= center.timeUs,
        );
        if (troughPoints.length > 0) {
          let trough = troughPoints[0];
          for (const point of troughPoints.slice(1)) {
            if (point.value < trough.value || (point.value === trough.value && point.timeUs < trough.timeUs)) {
              trough = point;
            }
          }
          const prominence = center.value - trough.value;
          const contextMad = mad(this.thresholdContext)!;
          const minimumProminence = Math.max(1, 2 * 1.4826 * contextMad);
          if (prominence >= minimumProminence) {
            const rawPeak = this.rawPoints.find(
              (point) => point.segmentId === center.segmentId && point.timeUs === center.timeUs,
            );
            this.acceptPulse({
              timeUs: center.timeUs,
              timeMs: center.timeUs / 1_000,
              ir: rawPeak?.ir ?? center.value,
              prominence,
              segmentId: center.segmentId,
            });
          }
        }
      }
    }
    this.prune(sample.sampleTimeUs);
  }

  getAcceptedPulses(): readonly DetectedPpgPulse[] {
    return this.acceptedPulses;
  }

  getOutOfOrderSampleCount(): number {
    return this.outOfOrderSamples;
  }

  getValidIntervals(startMs: number, endMs: number): number[] {
    const intervals: number[] = [];
    for (let index = 0; index < this.acceptedPulses.length; index += 1) {
      const current = this.acceptedPulses[index];
      if (current.timeMs < startMs || current.timeMs >= endMs) {
        continue;
      }
      const previous = this.previousPulseInSegment(index);
      if (previous === null) {
        continue;
      }
      const intervalMs = current.timeMs - previous.timeMs;
      if (intervalMs >= 300 && intervalMs <= 2_000) {
        intervals.push(intervalMs);
      }
    }
    return intervals;
  }

  extractFeatures(
    samples: readonly AnalysisPpgSample[],
    startMs: number,
    endMs: number,
  ): PpgFeatures {
    const pulses = this.acceptedPulses.filter((pulse) => pulse.timeMs >= startMs && pulse.timeMs < endMs);
    const intervals = this.getValidIntervals(startMs, endMs);
    const amplitudes: number[] = [];
    for (const pulse of pulses) {
      const index = this.acceptedPulses.indexOf(pulse);
      const previous = this.previousPulseInSegment(index);
      if (previous === null) {
        continue;
      }
      const between = this.rawPoints.filter(
        (point) =>
          point.segmentId === pulse.segmentId &&
          point.timeUs >= previous.timeUs &&
          point.timeUs <= pulse.timeUs,
      );
      if (between.length > 0) {
        amplitudes.push(pulse.ir - Math.min(...between.map((point) => point.ir)));
      }
    }
    const medianInterval = median(intervals);
    const red = samples.map((sample) => sample.red);
    const ir = samples.map((sample) => sample.ir);
    return {
      pulse_count: pulses.length,
      pulse_rate_bpm: intervals.length >= 3 ? 60_000 / medianInterval! : null,
      pulse_interval_ms: medianInterval,
      pulse_interval_mean_ms: mean(intervals),
      pulse_interval_std_ms: intervals.length >= 5 ? populationStd(intervals) : null,
      pulse_amplitude_raw: median(amplitudes),
      ppg_red_mean: mean(red),
      ppg_ir_mean: mean(ir),
      ppg_red_std: populationStd(red),
      ppg_ir_std: populationStd(ir),
    };
  }

  reset(): void {
    this.lastRawSample = null;
    this.lastInputTimeUs = null;
    this.smoothWindow = [];
    this.thresholdContext = [];
    this.smoothPoints = [];
    this.rawPoints.length = 0;
    this.acceptedPulses.length = 0;
    this.segmentStartUs = null;
    this.segmentId = 0;
    this.outOfOrderSamples = 0;
  }

  private resetSegment(): void {
    this.lastRawSample = null;
    this.smoothWindow = [];
    this.thresholdContext = [];
    this.smoothPoints = [];
    this.segmentStartUs = null;
    this.segmentId += 1;
  }

  private acceptPulse(pulse: DetectedPpgPulse): void {
    const previous = this.acceptedPulses.at(-1);
    if (previous !== undefined && previous.segmentId === pulse.segmentId) {
      const separationMs = pulse.timeMs - previous.timeMs;
      if (separationMs < PPG_MIN_SPACING_MS) {
        const newWins =
          pulse.prominence > previous.prominence ||
          (pulse.prominence === previous.prominence && pulse.timeMs < previous.timeMs);
        if (newWins) {
          this.acceptedPulses[this.acceptedPulses.length - 1] = pulse;
        }
        return;
      }
    }
    this.acceptedPulses.push(pulse);
  }

  private previousPulseInSegment(index: number): DetectedPpgPulse | null {
    const current = this.acceptedPulses[index];
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = this.acceptedPulses[previousIndex];
      if (previous.segmentId === current.segmentId) {
        return previous;
      }
    }
    return null;
  }

  private prune(currentTimeUs: number): void {
    const cutoffUs = currentTimeUs - 15_000_000;
    while (this.rawPoints.length > 0 && this.rawPoints[0].timeUs < cutoffUs) {
      this.rawPoints.shift();
    }
    while (this.smoothPoints.length > 0 && this.smoothPoints[0].timeUs < cutoffUs) {
      this.smoothPoints.shift();
    }
    while (this.acceptedPulses.length > 0 && this.acceptedPulses[0].timeUs < cutoffUs) {
      this.acceptedPulses.shift();
    }
  }
}

export function calculateGsrFeatures(
  samples: readonly AnalysisGsrSample[],
  baseline?: BaselineReference,
): GsrFeatures {
  if (samples.length === 0) {
    return {
      gsr_raw_mean: null,
      gsr_raw_min: null,
      gsr_raw_max: null,
      gsr_raw_range: null,
      gsr_raw_std: null,
      gsr_raw_delta_from_baseline: null,
      gsr_raw_slope_raw_per_s: null,
      gsr_robust_z: null,
    };
  }
  const values = samples.map((sample) => sample.raw);
  const rawMean = mean(values)!;
  const firstTimeMs = samples[0].sampleTimeMs;
  const slope = olsSlope(
    samples.map((sample) => (sample.sampleTimeMs - firstTimeMs) / 1_000),
    values,
  );
  return {
    gsr_raw_mean: rawMean,
    gsr_raw_min: Math.min(...values),
    gsr_raw_max: Math.max(...values),
    gsr_raw_range: Math.max(...values) - Math.min(...values),
    gsr_raw_std: populationStd(values),
    gsr_raw_delta_from_baseline: baseline === undefined ? null : rawMean - baseline.median,
    gsr_raw_slope_raw_per_s: slope,
    gsr_robust_z: baseline === undefined ? null : robustZ(rawMean, baseline.median, baseline.mad),
  };
}

export function calculateImuFeatures(
  samples: readonly AnalysisImuSample[],
  baseline?: BaselineReference,
): ImuFeatures {
  if (samples.length === 0) {
    return {
      acceleration_magnitude_g_mean: null,
      acceleration_magnitude_g_std: null,
      motion_index_g: null,
      gyro_magnitude_dps_mean: null,
      movement_level: null,
    };
  }
  const acceleration = samples.map((sample) =>
    Math.sqrt(sample.axG ** 2 + sample.ayG ** 2 + sample.azG ** 2),
  );
  const motionIndex = median(acceleration.map((magnitude) => Math.abs(magnitude - 1)))!;
  const gyro = samples.map((sample) =>
    Math.sqrt(sample.gxDps ** 2 + sample.gyDps ** 2 + sample.gzDps ** 2),
  );
  const lowThreshold = Math.max(0.03, baseline === undefined ? 0 : baseline.median + 2 * baseline.mad);
  const highThreshold = Math.max(0.1, baseline === undefined ? 0 : baseline.median + 3 * baseline.mad);
  const movementLevel = motionIndex < lowThreshold
    ? "low"
    : motionIndex < highThreshold
      ? "moderate"
      : "high";
  return {
    acceleration_magnitude_g_mean: mean(acceleration),
    acceleration_magnitude_g_std: populationStd(acceleration),
    motion_index_g: motionIndex,
    gyro_magnitude_dps_mean: mean(gyro),
    movement_level: movementLevel,
  };
}

export function calculateTemperatureFeatures(
  samples: readonly AnalysisTempSample[],
  baseline?: BaselineReference,
): TemperatureFeatures {
  if (samples.length === 0) {
    return {
      temperature_mean_c: null,
      temperature_min_c: null,
      temperature_max_c: null,
      temperature_delta_c: null,
      temperature_slope_c_per_min: null,
    };
  }
  const values = samples.map((sample) => sample.temperatureC);
  const temperatureMean = mean(values)!;
  const firstTimeMs = samples[0].sampleTimeMs;
  return {
    temperature_mean_c: temperatureMean,
    temperature_min_c: Math.min(...values),
    temperature_max_c: Math.max(...values),
    temperature_delta_c: baseline === undefined ? null : temperatureMean - baseline.median,
    temperature_slope_c_per_min: olsSlope(
      samples.map((sample) => (sample.sampleTimeMs - firstTimeMs) / 60_000),
      values,
    ),
  };
}

export function baselineRelation(
  current: number | null,
  baseline: BaselineReference | undefined,
  kind: "percent" | "robust" | "delta" = "delta",
): { delta: number | null; percent_change: number | null; robust_z: number | null } {
  if (current === null || baseline === undefined) {
    return { delta: null, percent_change: null, robust_z: null };
  }
  return {
    delta: current - baseline.median,
    percent_change: kind === "percent"
      ? (100 * (current - baseline.median)) / Math.max(Math.abs(baseline.median), EPSILON)
      : null,
    robust_z: kind === "robust" ? robustZ(current, baseline.median, baseline.mad) : null,
  };
}
