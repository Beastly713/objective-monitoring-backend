import { mad, median } from "./statistics.js";
import { qualityAtLeastUsable } from "./quality.js";
import type {
  AnalysisModality,
  BaselineReference,
  BaselineSummary,
  FeatureBaseline,
  ModalityBaselineState,
  ModalityQuality,
} from "./types.js";

export const BASELINE_COLLECTION_END_MS = 60_000;
export const MIN_BASELINE_WINDOWS = 4;

export type BaselineFeatureName =
  | "heart_rate_bpm"
  | "pulse_rate_bpm"
  | "gsr_raw_mean"
  | "motion_index_g"
  | "temperature_mean_c";

export interface BaselineObservation {
  modality: AnalysisModality;
  feature: BaselineFeatureName;
  value: number | null;
  valid: boolean;
  quality: ModalityQuality["state"];
}
const REQUIRED_FEATURES: Record<AnalysisModality, BaselineFeatureName> = {
  ecg: "heart_rate_bpm",
  ppg: "pulse_rate_bpm",
  gsr: "gsr_raw_mean",
  imu: "motion_index_g",
  temperature: "temperature_mean_c",
};

const PHYSIOLOGICAL_MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "temperature"];
const ALL_MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];

function emptyFeature(): FeatureBaseline {
  return {
    state: "building",
    eligible_window_count: 0,
    median: null,
    mad: null,
  };
}

function emptyState(modality: AnalysisModality): ModalityBaselineState {
  return {
    modality,
    state: "building",
    features: { [REQUIRED_FEATURES[modality]]: emptyFeature() },
  };
}

function cloneFeature(feature: FeatureBaseline): FeatureBaseline {
  return { ...feature };
}

function cloneModalityState(state: ModalityBaselineState): ModalityBaselineState {
  return {
    modality: state.modality,
    state: state.state,
    features: Object.fromEntries(
      Object.entries(state.features).map(([name, feature]) => [name, cloneFeature(feature)]),
    ),
  };
}

export class BaselineState {
  private readonly values = new Map<AnalysisModality, number[]>();
  private readonly states = new Map<AnalysisModality, ModalityBaselineState>();
  private collectionComplete = false;

  constructor() {
    this.reset();
  }

  observeWindow(windowEndMs: number, observations: readonly BaselineObservation[]): void {
    if (this.collectionComplete) {
      return;
    }

    if (windowEndMs <= BASELINE_COLLECTION_END_MS) {
      for (const observation of observations) {
        if (
          observation.value !== null &&
          Number.isFinite(observation.value) &&
          observation.valid &&
          qualityAtLeastUsable(observation.quality)
        ) {
          this.values.get(observation.modality)!.push(observation.value);
        }
      }
    }

    if (windowEndMs >= BASELINE_COLLECTION_END_MS) {
      this.closeCollection();
    }
  }

  getFeatureBaseline(
    modality: AnalysisModality,
    feature: BaselineFeatureName = REQUIRED_FEATURES[modality],
  ): FeatureBaseline {
    return cloneFeature(this.states.get(modality)!.features[feature]);
  }

  getReference(modality: AnalysisModality): BaselineReference | undefined {
    const feature = this.getFeatureBaseline(modality);
    if (feature.state !== "ready" || feature.median === null || feature.mad === null) {
      return undefined;
    }
    return { median: feature.median, mad: feature.mad };
  }

  isModalityReady(modality: AnalysisModality): boolean {
    return this.states.get(modality)!.state === "ready";
  }

  isGlobalReady(): boolean {
    return PHYSIOLOGICAL_MODALITIES.filter((modality) => this.isModalityReady(modality)).length >= 2;
  }

  getSummary(): BaselineSummary {
    const modalityStates = Object.fromEntries(
      ALL_MODALITIES.map((modality) => [modality, cloneModalityState(this.states.get(modality)!)]),
    ) as Record<AnalysisModality, ModalityBaselineState>;
    const readyModalities = ALL_MODALITIES.filter((modality) => modalityStates[modality].state === "ready");
    return {
      collection_complete: this.collectionComplete,
      ready_modality_count: readyModalities.length,
      ready_modalities: readyModalities,
      modality_states: modalityStates,
    };
  }

  reset(): void {
    this.collectionComplete = false;
    this.values.clear();
    this.states.clear();
    for (const modality of ALL_MODALITIES) {
      this.values.set(modality, []);
      this.states.set(modality, emptyState(modality));
    }
  }

  private closeCollection(): void {
    this.collectionComplete = true;
    for (const modality of ALL_MODALITIES) {
      const featureName = REQUIRED_FEATURES[modality];
      const featureValues = this.values.get(modality)!;
      const feature = this.states.get(modality)!.features[featureName];
      feature.eligible_window_count = featureValues.length;
      if (featureValues.length >= MIN_BASELINE_WINDOWS) {
        feature.state = "ready";
        feature.median = median(featureValues);
        feature.mad = mad(featureValues);
        this.states.get(modality)!.state = "ready";
      } else {
        feature.state = "incomplete";
        this.states.get(modality)!.state = "incomplete";
      }
    }
  }
}

export function requiredBaselineFeature(modality: AnalysisModality): BaselineFeatureName {
  return REQUIRED_FEATURES[modality];
}
