export const EPSILON = 1e-9;
export const MAD_SCALE = 1.4826;

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mad(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) {
    return null;
  }
  return median(values.map((value) => Math.abs(value - center)));
}

export function robustSigma(values: readonly number[]): number | null {
  const value = mad(values);
  return value === null ? null : MAD_SCALE * value;
}

export function populationStd(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const average = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (!(percentile > 0 && percentile <= 1)) {
    throw new Error("percentile must be greater than 0 and less than or equal to 1");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function olsSlope(x: readonly number[], y: readonly number[]): number | null {
  if (x.length === 0 || x.length !== y.length) {
    return null;
  }
  if (x.length === 1) {
    return 0;
  }

  const xMean = mean(x)!;
  const yMean = mean(y)!;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xDelta = x[index] - xMean;
    numerator += xDelta * (y[index] - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function percentChange(current: number, baseline: number): number {
  return (100 * (current - baseline)) / Math.max(Math.abs(baseline), EPSILON);
}

export function robustZ(current: number, baselineMedian: number, baselineMad: number): number {
  return (current - baselineMedian) / Math.max(MAD_SCALE * baselineMad, EPSILON);
}
