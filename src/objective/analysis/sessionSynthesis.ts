import type {
  AnalysisModality,
  AnalysisQualityState,
  AnalysisResult,
  BaselineSummary,
  EvidenceTier,
  MultimodalPattern,
} from "./types.js";
import { ANALYSIS_VERSION } from "./versions.js";

export type FinalAnalysisMissingWindowReason = "queue_drop" | "analysis_failure";

export interface FinalAnalysisWindowRef {
  epoch_id: string;
  start_ms: number;
  end_ms: number;
  start_us: number;
  end_us: number;
}

export interface FinalAnalysisMissingWindow extends FinalAnalysisWindowRef {
  reason: FinalAnalysisMissingWindowReason;
}

export interface FinalAnalysisTail {
  epoch_id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
}

export interface FinalAnalysisEpochCoverage {
  epoch_id: string;
  first_sample_ms: number | null;
  last_sample_ms: number | null;
}

export interface FinalAnalysisRuleSummary {
  fired_window_count: number;
  first_fired_window: FinalAnalysisWindowRef | null;
  last_fired_window: FinalAnalysisWindowRef | null;
  longest_consecutive_run: number;
}

export interface FinalAnalysisMultimodalPatternSummary {
  count: number;
  first_window: FinalAnalysisWindowRef | null;
  last_window: FinalAnalysisWindowRef | null;
  supporting_modalities: AnalysisModality[];
  evidence_tiers: EvidenceTier[];
}

export interface FinalAnalysisFeatureTrend {
  valid_window_count: number;
  first_valid: number | null;
  last_valid: number | null;
  median: number | null;
  change_from_first_to_last: number | null;
}

export interface FinalSessionAnalysis {
  type: "final_session_analysis";
  session_id: string;
  device_id: string;
  analysis_version: string;
  created_at_ms: number;
  session: {
    duration_ms: number;
    start_ms: number | null;
    end_ms: number | null;
    epoch_count: number;
    epoch_ids: string[];
    completed_window_count: number;
    incomplete_tail_present: boolean;
    incomplete_tail_duration_ms: number;
    finalization_timestamp_ms: number;
  };
  epoch_coverage: FinalAnalysisEpochCoverage[];
  window_coverage: {
    first_completed_window: FinalAnalysisWindowRef | null;
    last_completed_window: FinalAnalysisWindowRef | null;
    completed_window_count: number;
    completed_windows: FinalAnalysisWindowRef[];
    missing_windows: FinalAnalysisMissingWindow[];
    incomplete_tails: FinalAnalysisTail[];
  };
  quality: {
    modality_quality_states: Record<AnalysisModality, Record<AnalysisQualityState, number>>;
    packet_count: number;
    packet_gap_count: number;
    sample_gap_count: number;
    truncated_packet_count: number;
    analysis_input_gap_count: number;
  };
  baseline: {
    collection_complete: boolean;
    ready_modalities: AnalysisModality[];
    summary: BaselineSummary | null;
  };
  window_observations: Array<{
    window: FinalAnalysisWindowRef;
    rules_triggered: string[];
    multimodal_pattern: MultimodalPattern;
    evidence_tier: EvidenceTier;
    supporting_modalities: AnalysisModality[];
  }>;
  rule_summary: Record<string, FinalAnalysisRuleSummary>;
  multimodal_summary: {
    patterns: Record<string, FinalAnalysisMultimodalPatternSummary>;
    contradiction_window_count: number;
    evidence_tier_counts: Record<EvidenceTier, number>;
  };
  feature_trends: Record<string, Record<string, FinalAnalysisFeatureTrend>>;
}

export interface FinalAnalysisEpochInput {
  epoch_id: string;
  first_sample_ms: number | null;
  last_sample_ms: number | null;
}

export interface FinalSessionAnalysisInput {
  session_id: string;
  device_id: string;
  completed_results: readonly AnalysisResult[];
  missing_windows: readonly FinalAnalysisMissingWindow[];
  incomplete_tails: readonly FinalAnalysisTail[];
  epoch_coverage: readonly FinalAnalysisEpochInput[];
  baseline_summary: BaselineSummary | null;
  created_at_ms: number;
}

const MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];

function emptyQualityCounts(): Record<AnalysisQualityState, number> {
  return { good: 0, usable: 0, limited: 0, unavailable: 0 };
}

function emptyEvidenceCounts(): Record<EvidenceTier, number> {
  return { corroborated: 0, moderate: 0, limited: 0, insufficient: 0 };
}

function windowRef(result: AnalysisResult): FinalAnalysisWindowRef {
  return {
    epoch_id: result.epoch_id,
    start_ms: result.window.start_ms,
    end_ms: result.window.end_ms,
    start_us: result.window.start_us,
    end_us: result.window.end_us,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function makeRuleSummary(results: readonly AnalysisResult[]): Record<string, FinalAnalysisRuleSummary> {
  const summaries = new Map<string, FinalAnalysisRuleSummary>();
  const previousFired = new Map<string, { epochId: string; endMs: number; run: number }>();

  for (const result of results) {
    const ref = windowRef(result);
    const fired = new Set<string>();
    for (const modality of MODALITIES) {
      for (const evaluation of result.modality_results[modality].rule_evaluations) {
        if (evaluation.status === "fired") {
          fired.add(evaluation.rule_id);
        }
      }
    }
    for (const ruleId of result.multimodal_result.rule_ids) {
      fired.add(ruleId);
    }

    const allRuleIds = new Set<string>([
      ...result.rules_triggered,
      ...result.multimodal_result.rule_ids,
      ...MODALITIES.flatMap((modality) => result.modality_results[modality].rule_evaluations.map((rule) => rule.rule_id)),
    ]);
    for (const ruleId of allRuleIds) {
      if (!summaries.has(ruleId)) {
        summaries.set(ruleId, {
          fired_window_count: 0,
          first_fired_window: null,
          last_fired_window: null,
          longest_consecutive_run: 0,
        });
      }
    }

    for (const [ruleId, summary] of summaries) {
      if (!fired.has(ruleId)) {
        previousFired.delete(ruleId);
        continue;
      }
      summary.fired_window_count += 1;
      if (summary.first_fired_window === null) {
        summary.first_fired_window = { ...ref };
      }
      summary.last_fired_window = { ...ref };
      const previous = previousFired.get(ruleId);
      const run = previous !== undefined &&
        previous.epochId === result.epoch_id &&
        previous.endMs === result.window.start_ms
        ? previous.run + 1
        : 1;
      summary.longest_consecutive_run = Math.max(summary.longest_consecutive_run, run);
      previousFired.set(ruleId, { epochId: result.epoch_id, endMs: result.window.end_ms, run });
    }
  }

  return Object.fromEntries(summaries.entries());
}

function makeFeatureTrends(results: readonly AnalysisResult[]): Record<string, Record<string, FinalAnalysisFeatureTrend>> {
  const values = new Map<string, Map<string, number[]>>();
  for (const modality of MODALITIES) {
    values.set(modality, new Map());
    for (const result of results) {
      const features = result.modality_results[modality].features as unknown as Record<string, unknown>;
      for (const [feature, value] of Object.entries(features)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          continue;
        }
        const modalityValues = values.get(modality)!;
        const featureValues = modalityValues.get(feature) ?? [];
        featureValues.push(value);
        modalityValues.set(feature, featureValues);
      }
    }
  }

  return Object.fromEntries(MODALITIES.map((modality) => {
    const featureEntries = [...values.get(modality)!.entries()].map(([feature, featureValues]) => ({
      feature,
      trend: {
        valid_window_count: featureValues.length,
        first_valid: featureValues[0] ?? null,
        last_valid: featureValues.at(-1) ?? null,
        median: median(featureValues),
        change_from_first_to_last: featureValues.length < 2
          ? null
          : featureValues.at(-1)! - featureValues[0],
      } satisfies FinalAnalysisFeatureTrend,
    }));
    return [modality, Object.fromEntries(featureEntries.map(({ feature, trend }) => [feature, trend]))];
  }));
}

function makeMultimodalSummary(results: readonly AnalysisResult[]): FinalSessionAnalysis["multimodal_summary"] {
  const patterns = new Map<string, FinalAnalysisMultimodalPatternSummary>();
  const evidenceTierCounts = emptyEvidenceCounts();
  let contradictionWindowCount = 0;
  for (const result of results) {
    const multimodal = result.multimodal_result;
    evidenceTierCounts[multimodal.evidence_tier] += 1;
    if (multimodal.pattern === "Cardiovascular measurement disagreement") {
      contradictionWindowCount += 1;
    }
    const existing = patterns.get(multimodal.pattern);
    if (existing === undefined) {
      patterns.set(multimodal.pattern, {
        count: 1,
        first_window: windowRef(result),
        last_window: windowRef(result),
        supporting_modalities: [...multimodal.supporting_modalities],
        evidence_tiers: [multimodal.evidence_tier],
      });
    } else {
      existing.count += 1;
      existing.last_window = windowRef(result);
      existing.supporting_modalities = [...new Set([
        ...existing.supporting_modalities,
        ...multimodal.supporting_modalities,
      ])];
      if (!existing.evidence_tiers.includes(multimodal.evidence_tier)) {
        existing.evidence_tiers.push(multimodal.evidence_tier);
      }
    }
  }
  return {
    patterns: Object.fromEntries(patterns.entries()),
    contradiction_window_count: contradictionWindowCount,
    evidence_tier_counts: evidenceTierCounts,
  };
}

export function synthesizeFinalSessionAnalysis(input: FinalSessionAnalysisInput): FinalSessionAnalysis {
  const results = [...input.completed_results];
  const completedWindows = results.map(windowRef);
  const qualityStates = Object.fromEntries(
    MODALITIES.map((modality) => [modality, emptyQualityCounts()]),
  ) as Record<AnalysisModality, Record<AnalysisQualityState, number>>;
  let packetCount = 0;
  let packetGapCount = 0;
  let sampleGapCount = 0;
  let truncatedPacketCount = 0;
  let analysisInputGapCount = 0;
  const observations: FinalSessionAnalysis["window_observations"] = [];

  for (const result of results) {
    const ref = windowRef(result);
    packetCount += result.source.packet_count;
    packetGapCount += result.source.packet_gap_count;
    sampleGapCount += result.source.sample_gap_count ?? 0;
    truncatedPacketCount += result.source.truncated_packet_count;
    analysisInputGapCount += result.source.analysis_input_gap_count;
    for (const modality of MODALITIES) {
      const state = result.modality_results[modality].quality.state;
      qualityStates[modality][state] += 1;
    }
    observations.push({
      window: ref,
      rules_triggered: [...result.rules_triggered],
      multimodal_pattern: result.multimodal_result.pattern,
      evidence_tier: result.multimodal_result.evidence_tier,
      supporting_modalities: [...result.multimodal_result.supporting_modalities],
    });
  }

  const validEpochCoverage = input.epoch_coverage.filter(
    (epoch): epoch is FinalAnalysisEpochInput & { first_sample_ms: number; last_sample_ms: number } =>
      epoch.first_sample_ms !== null && epoch.last_sample_ms !== null,
  );
  const durationMs = validEpochCoverage.reduce(
    (total, epoch) => total + Math.max(0, epoch.last_sample_ms - epoch.first_sample_ms),
    0,
  );
  const startMs = validEpochCoverage.length === 0
    ? null
    : Math.min(...validEpochCoverage.map((epoch) => epoch.first_sample_ms));
  const endMs = validEpochCoverage.length === 0
    ? null
    : Math.max(...validEpochCoverage.map((epoch) => epoch.last_sample_ms));
  const tails = input.incomplete_tails.map((tail) => ({ ...tail }));
  const tailDuration = tails.reduce((total, tail) => total + tail.duration_ms, 0);

  return {
    type: "final_session_analysis",
    session_id: input.session_id,
    device_id: input.device_id,
    analysis_version: input.completed_results[0]?.analysis_version ?? ANALYSIS_VERSION,
    created_at_ms: input.created_at_ms,
    session: {
      duration_ms: durationMs,
      start_ms: startMs,
      end_ms: endMs,
      epoch_count: input.epoch_coverage.length,
      epoch_ids: input.epoch_coverage.map((epoch) => epoch.epoch_id),
      completed_window_count: completedWindows.length,
      incomplete_tail_present: tails.length > 0,
      incomplete_tail_duration_ms: tailDuration,
      finalization_timestamp_ms: input.created_at_ms,
    },
    epoch_coverage: input.epoch_coverage.map((epoch) => ({ ...epoch })),
    window_coverage: {
      first_completed_window: completedWindows[0] ?? null,
      last_completed_window: completedWindows.at(-1) ?? null,
      completed_window_count: completedWindows.length,
      completed_windows: completedWindows,
      missing_windows: input.missing_windows.map((window) => ({ ...window })),
      incomplete_tails: tails,
    },
    quality: {
      modality_quality_states: qualityStates,
      packet_count: packetCount,
      packet_gap_count: packetGapCount,
      sample_gap_count: sampleGapCount,
      truncated_packet_count: truncatedPacketCount,
      analysis_input_gap_count: analysisInputGapCount,
    },
    baseline: {
      collection_complete: input.baseline_summary?.collection_complete ?? false,
      ready_modalities: input.baseline_summary?.ready_modalities ?? [],
      summary: input.baseline_summary === null ? null : structuredClone(input.baseline_summary),
    },
    window_observations: observations,
    rule_summary: makeRuleSummary(results),
    multimodal_summary: makeMultimodalSummary(results),
    feature_trends: makeFeatureTrends(results),
  };
}

export type FinalSessionAnalysisSubscriber = (analysis: FinalSessionAnalysis) => void;

export class FinalSessionAnalysisBus {
  private readonly subscribers = new Set<FinalSessionAnalysisSubscriber>();

  subscribe(subscriber: FinalSessionAnalysisSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(analysis: FinalSessionAnalysis): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(analysis);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown subscriber error";
        console.error(`[objective-final-analysis] subscriber failed message=${message}`);
      }
    }
  }
}
