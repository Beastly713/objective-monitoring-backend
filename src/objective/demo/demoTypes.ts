import type { AnalysisModality, AnalysisResult, EvidenceTier } from "../analysis/types.js";
import type { FinalSessionAnalysis } from "../analysis/sessionSynthesis.js";

export const DEMO_DEVICE_ID = "DEMO-ESP32";
export const DEMO_PACKET_PERIOD_MS = 100;
export const DEMO_BASELINE_DURATION_MS = 60_000;
export const DEMO_VISIBLE_DURATION_MS = 30_000;

export const DEMO_PHASES = [
  "IDLE",
  "PREPARING",
  "READY",
  "STREAMING",
  "FINALIZING",
  "COMPLETE",
  "ERROR",
] as const;

export type DemoPhase = (typeof DEMO_PHASES)[number];

export const DEMO_SCENARIO_IDS = [
  "stable_baseline",
  "isolated_cardiovascular_change",
  "isolated_electrodermal_change",
  "isolated_temperature_change",
  "corroborated_multimodal_change",
] as const;

export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

export interface DemoScenarioDefinition {
  id: DemoScenarioId;
  title: string;
  description: string;
  expected_pattern: string;
  expected_rule_ids: string[];
  expected_evidence_tier: EvidenceTier;
  hidden_prime_duration_ms: number;
  visible_duration_ms: number;
}

export type DemoValidationState = "pending" | "passed" | "failed";

export interface DemoValidation {
  state: DemoValidationState;
  message: string | null;
}

export type DemoFinalAnalysisState = "pending" | "complete" | "error" | "unavailable";

export interface DemoFinalAnalysisStatus {
  session_id: string | null;
  state: DemoFinalAnalysisState;
  available: boolean;
}

export interface DemoRuntimeStatus {
  phase: DemoPhase;
  scenario: DemoScenarioDefinition | null;
  session_id: string | null;
  visible_elapsed_ms: number;
  visible_duration_ms: number;
  visible_packet_count: number;
  completed_window_count: number;
  baseline_ready: boolean;
  baseline_ready_modalities: AnalysisModality[];
  latest_result: AnalysisResult | null;
  validation: DemoValidation;
  final_analysis: DemoFinalAnalysisStatus;
  error: string | null;
}

export interface DemoResultResponse {
  session_id: string;
  scenario: DemoScenarioDefinition;
  completed_results: AnalysisResult[];
  latest_result: AnalysisResult | null;
  final_analysis: FinalSessionAnalysis | null;
  baseline_ready: boolean;
  baseline_ready_modalities: AnalysisModality[];
  validation: DemoValidation;
}
