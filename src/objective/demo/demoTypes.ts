import type { AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import type { AnalysisResult, AnalysisModality, EvidenceTier, MultimodalPattern } from "../analysis/types.js";
import type { FinalSessionAnalysis } from "../analysis/sessionSynthesis.js";

export const DEMO_DEVICE_ID = "DEMO-ESP32";
export const DEMO_PACKET_PERIOD_MS = 100;
export const DEMO_BASELINE_DURATION_MS = 60_000;
export const DEMO_VISIBLE_DURATION_MS = 30_000;
export const DEMO_MAX_RETAINED_SESSIONS = 5;
export const DEMO_SESSION_TTL_MS = 45 * 60_000;

export const DEMO_PHASES = [
  "IDLE",
  "PREPARING",
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

export interface DemoSessionSummary {
  session_id: string;
  device_id: string;
  boot_id: string;
  epoch_id: string;
  scenario_id: DemoScenarioId;
  scenario_title: string;
  status: "WAITING" | "LIVE" | "COMPLETED" | "ERROR";
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  duration_ms: number;
  packet_count: number;
  analysis_window_count: number;
  error: string | null;
}

export interface DemoPacketEnvelope extends AcceptedObjectivePacket {
  replay_t0_ms: number;
}

export interface DemoAnalysisEnvelope {
  replay_start_ms: number;
  replay_end_ms: number;
  result: AnalysisResult;
}

export interface DemoSessionRecord extends DemoSessionSummary {
  packets: DemoPacketEnvelope[];
  analysis_results: AnalysisResult[];
  final_analysis: FinalSessionAnalysis | null;
  expected_result_pattern: MultimodalPattern | null;
  actual_rule_ids: string[];
}

export interface DemoRuntimeStatus {
  enabled: boolean;
  phase: DemoPhase;
  scenario: DemoScenarioDefinition | null;
  session_id: string | null;
  visible_elapsed_ms: number;
  visible_duration_ms: number;
  hidden_pre_roll_duration_ms: number;
  hidden_pre_roll_packet_count: number;
  visible_packet_count: number;
  visible_analysis_window_count: number;
  baseline_ready: boolean;
  validation_state: "pending" | "passed" | "failed";
  validation_message: string | null;
  latest_pattern: MultimodalPattern | null;
  latest_evidence_tier: EvidenceTier | null;
  latest_rule_ids: string[];
  error: string | null;
}

export interface DemoStatusResponse {
  configured_device_id: typeof DEMO_DEVICE_ID;
  device: {
    connected: boolean;
    connected_clients: number;
    authenticated_devices: number;
  };
  session: DemoSessionSummary | null;
  ingestion: {
    accepted_packets: number;
    invalid_packets: number;
    received_bytes: number;
    latest_sequence: number | null;
    sequence_gaps: number;
    duplicate_packets: number;
    acknowledgements: number;
    reconnects: number;
  };
  live: {
    connected_clients: number;
    delivered_packets: number;
    dropped_packets: number;
    delivered_analysis: number;
    dropped_analysis: number;
  };
  storage: {
    queue_depth: number;
    persisted_packets: number;
    storage_errors: number;
    storage_drops: number;
    suppressed_duplicates: number;
    healthy: boolean;
    degraded: boolean;
  };
  analysis: Record<string, unknown>;
  demo: DemoRuntimeStatus;
}

