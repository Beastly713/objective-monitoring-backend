import { randomUUID } from "node:crypto";

import { AcceptedPacketBus, type AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import { ObjectiveAnalysisPipeline, type AnalysisPipelineSnapshot } from "../analysis/pipeline.js";
import {
  synthesizeFinalSessionAnalysis,
  type FinalSessionAnalysis,
} from "../analysis/sessionSynthesis.js";
import { AnalysisResultBus } from "../analysis/resultBus.js";
import type {
  AnalysisModality,
  AnalysisResult,
  BaselineSummary,
  MultimodalPattern,
} from "../analysis/types.js";
import { createObjectiveLiveGateway } from "../live/liveGateway.js";
import { validateSchemaV1Packet } from "../packetValidator.js";
import { DEMO_SCENARIOS, getDemoScenario } from "./demoCatalog.js";
import {
  DEMO_BASELINE_DURATION_MS,
  DEMO_DEVICE_ID,
  DEMO_MAX_RETAINED_SESSIONS,
  DEMO_PACKET_PERIOD_MS,
  DEMO_SESSION_TTL_MS,
  DEMO_VISIBLE_DURATION_MS,
  type DemoAnalysisEnvelope,
  type DemoPacketEnvelope,
  type DemoPhase,
  type DemoRuntimeStatus,
  type DemoScenarioDefinition,
  type DemoScenarioId,
  type DemoSessionRecord,
  type DemoSessionSummary,
  type DemoStatusResponse,
} from "./demoTypes.js";
import { generateDemoAcceptedPacket, type DemoPacketContext } from "./demoSignalGenerator.js";

const MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];
const FORBIDDEN_PATTERN = "Insufficient evidence for multimodal interpretation";
const MAX_REQUESTED_STOP_WAIT_MS = 5_000;

export interface DemoRuntimeOptions {
  now?: () => number;
  createId?: () => string;
  visiblePacketDelayMs?: number;
  preRollYieldEveryPackets?: number;
  maxRetainedSessions?: number;
  sessionTtlMs?: number;
}

interface ActiveDemoRun {
  session: DemoSessionRecord;
  scenario: DemoScenarioDefinition;
  context: DemoPacketContext;
  visibleStartMs: number;
  visibleEndMs: number;
  phase: DemoPhase;
  visibleElapsedMs: number;
  internalPacketCount: number;
  visiblePacketCount: number;
  nextSequence: number;
  visibleResults: AnalysisResult[];
  latestResult: AnalysisResult | null;
  baselineSummary: BaselineSummary | null;
  latestPattern: MultimodalPattern | null;
  latestEvidenceTier: AnalysisResult["multimodal_result"]["evidence_tier"] | null;
  latestRuleIds: string[];
  validationState: DemoRuntimeStatus["validation_state"];
  validationMessage: string | null;
  error: string | null;
  stopRequested: boolean;
  fullRun: boolean;
  packetBus: AcceptedPacketBus;
  resultBus: AnalysisResultBus;
  pipeline: ObjectiveAnalysisPipeline;
  unsubscribeResults: () => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return immediate();
  }
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isForbiddenVisibleResult(result: AnalysisResult): boolean {
  return result.multimodal_result.pattern === FORBIDDEN_PATTERN ||
    result.multimodal_result.explanation.includes(FORBIDDEN_PATTERN) ||
    result.multimodal_result.rule_ids.includes("MM-07");
}

function rebaseResult(result: AnalysisResult, visibleStartMs: number): AnalysisResult {
  const rebased = clone(result);
  const offsetUs = visibleStartMs * 1_000;
  rebased.window = {
    ...rebased.window,
    start_us: rebased.window.start_us - offsetUs,
    end_us: rebased.window.end_us - offsetUs,
    start_ms: rebased.window.start_ms - visibleStartMs,
    end_ms: rebased.window.end_ms - visibleStartMs,
  };
  return rebased;
}

function rebasePacket(packet: AcceptedObjectivePacket, visibleStartMs: number): AcceptedObjectivePacket {
  const rebased = clone(packet);
  rebased.plot_t0_ms -= visibleStartMs;
  return rebased;
}

function summaryOf(session: DemoSessionRecord): DemoSessionSummary {
  return {
    session_id: session.session_id,
    device_id: session.device_id,
    boot_id: session.boot_id,
    epoch_id: session.epoch_id,
    scenario_id: session.scenario_id,
    scenario_title: session.scenario_title,
    status: session.status,
    created_at_ms: session.created_at_ms,
    updated_at_ms: session.updated_at_ms,
    completed_at_ms: session.completed_at_ms,
    duration_ms: session.duration_ms,
    packet_count: session.packet_count,
    analysis_window_count: session.analysis_window_count,
    error: session.error,
  };
}

function emptyPipelineSnapshot(): AnalysisPipelineSnapshot {
  return {
    windowsEmitted: 0,
    windowsFailed: 0,
    packetProcessingFailures: 0,
    queueDepth: 0,
    queueDrops: 0,
    pendingAnalysisWindows: 0,
    lastAnalysisQueueWaitMs: null,
    lastAnalysisDurationMs: null,
    collection: null,
    lastWindow: { session_id: null, epoch_id: null, start_ms: null, end_ms: null },
    baseline: { collection_complete: false, ready_modalities: [] },
    finalAnalysis: { session_id: null, state: "unavailable", available: false },
    pipelineHealthy: true,
    degraded: false,
  };
}

export class DemoRuntime {
  readonly packetBus = new AcceptedPacketBus();
  readonly resultBus = new AnalysisResultBus();
  readonly liveGateway = createObjectiveLiveGateway(this.packetBus, this.resultBus);

  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly visiblePacketDelayMs: number;
  private readonly preRollYieldEveryPackets: number;
  private readonly maxRetainedSessions: number;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, DemoSessionRecord>();
  private activeRun: ActiveDemoRun | null = null;
  private runGeneration = 0;
  private closed = false;

  constructor(options: DemoRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.visiblePacketDelayMs = options.visiblePacketDelayMs ?? DEMO_PACKET_PERIOD_MS;
    this.preRollYieldEveryPackets = Math.max(1, options.preRollYieldEveryPackets ?? 50);
    this.maxRetainedSessions = Math.max(1, options.maxRetainedSessions ?? DEMO_MAX_RETAINED_SESSIONS);
    this.sessionTtlMs = Math.max(1, options.sessionTtlMs ?? DEMO_SESSION_TTL_MS);
  }

  listScenarios(): DemoScenarioDefinition[] {
    return DEMO_SCENARIOS.map((scenario) => ({
      ...scenario,
      expected_rule_ids: [...scenario.expected_rule_ids],
    }));
  }

  startScenario(scenarioId: string): DemoSessionSummary {
    if (this.closed) {
      throw new Error("demo runtime is closed");
    }
    const scenario = getDemoScenario(scenarioId);
    if (scenario === undefined) {
      throw new Error("unknown demonstration scenario");
    }

    this.cancelActiveRun();
    this.pruneSessions(this.now());
    const sessionId = this.createId();
    const bootId = this.createId();
    const epochId = this.createId();
    const createdAtMs = this.now();
    const session: DemoSessionRecord = {
      session_id: sessionId,
      device_id: DEMO_DEVICE_ID,
      boot_id: bootId,
      epoch_id: epochId,
      scenario_id: scenario.id,
      scenario_title: scenario.title,
      status: "WAITING",
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      completed_at_ms: null,
      duration_ms: DEMO_VISIBLE_DURATION_MS,
      packet_count: 0,
      analysis_window_count: 0,
      error: null,
      packets: [],
      analysis_results: [],
      final_analysis: null,
      expected_result_pattern: null,
      actual_rule_ids: [],
    };
    this.sessions.set(sessionId, session);
    this.trimHistory(createdAtMs);

    const packetBus = new AcceptedPacketBus();
    const resultBus = new AnalysisResultBus();
    const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);
    const run: ActiveDemoRun = {
      session,
      scenario,
      context: {
        session_id: sessionId,
        boot_id: bootId,
        epoch_id: epochId,
        wall_start_ms: createdAtMs,
      },
      visibleStartMs: DEMO_BASELINE_DURATION_MS + scenario.hidden_prime_duration_ms,
      visibleEndMs: DEMO_BASELINE_DURATION_MS + scenario.hidden_prime_duration_ms + scenario.visible_duration_ms,
      phase: "PREPARING",
      visibleElapsedMs: 0,
      internalPacketCount: 0,
      visiblePacketCount: 0,
      nextSequence: 1,
      visibleResults: [],
      latestResult: null,
      baselineSummary: null,
      latestPattern: null,
      latestEvidenceTier: null,
      latestRuleIds: [],
      validationState: "pending",
      validationMessage: null,
      error: null,
      stopRequested: false,
      fullRun: false,
      packetBus,
      resultBus,
      pipeline,
      unsubscribeResults: () => undefined,
    };
    run.unsubscribeResults = resultBus.subscribe((result) => this.handleInternalResult(run, result));
    this.activeRun = run;
    const generation = ++this.runGeneration;
    void this.runScenario(run, generation);
    return summaryOf(session);
  }

  requestStop(sessionId?: string): DemoSessionSummary | null {
    const run = this.activeRun;
    if (run === null || (sessionId !== undefined && run.session.session_id !== sessionId)) {
      return this.latestSessionSummary();
    }
    run.stopRequested = true;
    if (run.phase === "PREPARING" || run.phase === "STREAMING") {
      run.phase = "FINALIZING";
      run.session.updated_at_ms = this.now();
    }
    return summaryOf(run.session);
  }

  getSession(sessionId: string): DemoSessionSummary | undefined {
    this.pruneSessions(this.now());
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : summaryOf(session);
  }

  getSessionRecord(sessionId: string): DemoSessionRecord | undefined {
    this.pruneSessions(this.now());
    return this.sessions.get(sessionId);
  }

  listSessions(): DemoSessionSummary[] {
    this.pruneSessions(this.now());
    return [...this.sessions.values()]
      .sort((left, right) => right.created_at_ms - left.created_at_ms)
      .map(summaryOf);
  }

  getStatus(): DemoStatusResponse {
    this.pruneSessions(this.now());
    const run = this.activeRun;
    const session = run?.session ?? null;
    const pipeline = run?.pipeline.getSnapshot() ?? emptyPipelineSnapshot();
    const demo = this.demoStatus(run);
    const finalAnalysis = run?.session.final_analysis === null || run?.session.final_analysis === undefined
      ? {
        session_id: session?.session_id ?? null,
        state: run?.phase === "ERROR" ? "error" : run === null ? "unavailable" : "pending",
        available: false,
        result: null,
      }
      : {
        session_id: session?.session_id ?? null,
        state: "complete",
        available: true,
        result: clone(run.session.final_analysis),
      };

    const visiblePipeline = this.visiblePipelineSnapshot(run, pipeline);
    const visibleResults = run?.visibleResults ?? [];
    const latestResult = visibleResults.at(-1) ?? run?.latestResult ?? null;
    const baseline = run?.baselineSummary ?? latestResult?.baseline_update?.baseline_after ?? latestResult?.baseline ?? null;
    const analysis = {
      windows_emitted: visibleResults.length,
      windows_failed: pipeline.windowsFailed,
      packet_processing_failures: pipeline.packetProcessingFailures,
      queue_depth: pipeline.queueDepth,
      queue_drops: pipeline.queueDrops,
      completed_windows_emitted: visibleResults.length,
      pending_analysis_windows: pipeline.pendingAnalysisWindows,
      analysis_queue_depth: pipeline.queueDepth,
      analysis_queue_drops: pipeline.queueDrops,
      last_analysis_queue_wait_ms: pipeline.lastAnalysisQueueWaitMs,
      last_analysis_duration_ms: pipeline.lastAnalysisDurationMs,
      collection: visiblePipeline.collection,
      storage_queue_depth: 0,
      analysis_result_storage_queue_depth: 0,
      storage_errors: 0,
      analysis_result_storage_errors: 0,
      storage_drops: 0,
      analysis_result_storage_drops: 0,
      last_window: visiblePipeline.lastWindow,
      final_analysis: {
        ...finalAnalysis,
        persisted_results: 0,
        persistence_queue_depth: 0,
        persistence_errors: 0,
        persistence_drops: 0,
        persistence_healthy: true,
      },
      baseline: baseline === null
        ? pipeline.baseline
        : {
          collection_complete: baseline.collection_complete,
          ready_modalities: [...baseline.ready_modalities],
        },
      pipeline_healthy: pipeline.pipelineHealthy && demo.validation_state !== "failed",
      storage_healthy: true,
      degraded: pipeline.degraded || demo.validation_state === "failed",
    } satisfies Record<string, unknown>;
    const liveSnapshot = this.liveGateway.getSnapshot();
    const acceptedPackets = run?.visiblePacketCount ?? 0;
    const lastPacket = run?.session.packets.at(-1);
    return {
      configured_device_id: DEMO_DEVICE_ID,
      device: {
        connected: run !== null && run.phase !== "IDLE" && run.phase !== "ERROR",
        connected_clients: liveSnapshot.connectedClients,
        authenticated_devices: run === null ? 0 : 1,
      },
      session,
      ingestion: {
        accepted_packets: acceptedPackets,
        invalid_packets: 0,
        received_bytes: acceptedPackets * 1_024,
        latest_sequence: lastPacket?.raw_packet.seq ?? null,
        sequence_gaps: 0,
        duplicate_packets: 0,
        acknowledgements: acceptedPackets,
        reconnects: 0,
      },
      live: {
        connected_clients: liveSnapshot.connectedClients,
        delivered_packets: liveSnapshot.deliveredPackets,
        dropped_packets: liveSnapshot.droppedPackets,
        delivered_analysis: liveSnapshot.deliveredAnalysis ?? 0,
        dropped_analysis: liveSnapshot.droppedAnalysis ?? 0,
      },
      storage: {
        queue_depth: 0,
        persisted_packets: 0,
        storage_errors: 0,
        storage_drops: 0,
        suppressed_duplicates: 0,
        healthy: true,
        degraded: false,
      },
      analysis,
      demo,
    };
  }

  getReplayManifest(sessionId: string): Record<string, unknown> | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    const packets = session.packets;
    const first = packets[0];
    const last = packets.at(-1);
    const duration = session.duration_ms;
    return {
      origin_wall_ms: session.created_at_ms,
      duration_ms: duration,
      packet_count: packets.length,
      ingestion_gap_events: 0,
      ingestion_missing_packets: 0,
      history_gap_events: 0,
      history_missing_packets: 0,
      truncated_packets: 0,
      boot_count: 1,
      epoch_count: 1,
      first_received_at_ms: first?.received_at_ms ?? null,
      last_received_at_ms: last?.received_at_ms ?? null,
      gaps: [],
      segments: packets.length === 0 ? [] : [{
        boot_id: session.boot_id,
        epoch_id: session.epoch_id,
        boundary_type: "session_start",
        start_replay_ms: 0,
        end_replay_ms: duration,
        packet_count: packets.length,
        first_seq: first!.raw_packet.seq,
        last_seq: last!.raw_packet.seq,
      }],
    };
  }

  getReplayPackets(
    sessionId: string,
    fromMs: number,
    durationMs: number,
  ): { window: Record<string, unknown>; packets: DemoPacketEnvelope[] } | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    const toMs = fromMs + durationMs;
    const available = session.packets.filter((packet) => {
      const packetEnd = packet.replay_t0_ms + (packet.raw_packet.t1_us - packet.raw_packet.t0_us) / 1_000;
      return packetEnd > fromMs && packet.replay_t0_ms < toMs;
    });
    const packets = available.slice(0, 1_000).map(clone);
    return {
      window: {
        from_ms: fromMs,
        duration_ms: durationMs,
        to_ms: toMs,
        packet_count: packets.length,
        available_packet_count: available.length,
        packet_cap: 1_000,
        capped: available.length > packets.length,
      },
      packets,
    };
  }

  getAnalysisWindow(
    sessionId: string,
    fromMs: number,
    durationMs: number,
  ): { window: Record<string, unknown>; results: DemoAnalysisEnvelope[] } | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    const toMs = fromMs + durationMs;
    const results = session.analysis_results
      .map((result) => ({
        replay_start_ms: result.window.start_ms,
        replay_end_ms: result.window.end_ms,
        result: clone(result),
      }))
      .filter((envelope) => envelope.replay_end_ms > fromMs && envelope.replay_start_ms < toMs);
    return {
      window: {
        from_ms: fromMs,
        duration_ms: durationMs,
        to_ms: toMs,
        result_count: results.length,
        available_result_count: session.analysis_results.length,
        result_cap: 1_000,
        capped: false,
      },
      results,
    };
  }

  getFinalAnalysis(sessionId: string): {
    session: DemoSessionSummary;
    final_analysis: Record<string, unknown>;
  } | undefined {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      return undefined;
    }
    return {
      session: summaryOf(record),
      final_analysis: record.final_analysis === null
        ? {
          state: record.status === "ERROR" ? "error" : "pending",
          available: false,
          analysis_version: "analysis-2.0",
          result: null,
        }
        : {
          state: "complete",
          available: true,
          analysis_version: record.final_analysis.analysis_version,
          result: clone(record.final_analysis),
        },
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelActiveRun();
    this.liveGateway.close();
    this.sessions.clear();
  }

  private demoStatus(run: ActiveDemoRun | null): DemoRuntimeStatus {
    if (run === null) {
      return {
        enabled: true,
        phase: "IDLE",
        scenario: null,
        session_id: null,
        visible_elapsed_ms: 0,
        visible_duration_ms: DEMO_VISIBLE_DURATION_MS,
        hidden_pre_roll_duration_ms: DEMO_BASELINE_DURATION_MS,
        hidden_pre_roll_packet_count: 0,
        visible_packet_count: 0,
        visible_analysis_window_count: 0,
        baseline_ready: false,
        validation_state: "pending",
        validation_message: null,
        latest_pattern: null,
        latest_evidence_tier: null,
        latest_rule_ids: [],
        error: null,
      };
    }
    return {
      enabled: true,
      phase: run.phase,
      scenario: clone(run.scenario),
      session_id: run.session.session_id,
      visible_elapsed_ms: run.visibleElapsedMs,
      visible_duration_ms: run.scenario.visible_duration_ms,
      hidden_pre_roll_duration_ms: run.visibleStartMs,
      hidden_pre_roll_packet_count: Math.floor(run.visibleStartMs / DEMO_PACKET_PERIOD_MS),
      visible_packet_count: run.visiblePacketCount,
      visible_analysis_window_count: run.visibleResults.length,
      baseline_ready: run.baselineSummary?.ready_modalities.length === MODALITIES.length ||
        run.latestResult?.baseline_ready === true,
      validation_state: run.validationState,
      validation_message: run.validationMessage,
      latest_pattern: run.latestPattern,
      latest_evidence_tier: run.latestEvidenceTier,
      latest_rule_ids: [...run.latestRuleIds],
      error: run.error,
    };
  }

  private visiblePipelineSnapshot(
    run: ActiveDemoRun | null,
    pipeline: AnalysisPipelineSnapshot,
  ): AnalysisPipelineSnapshot {
    if (run === null) {
      return pipeline;
    }
    const collection = pipeline.collection === null
      ? null
      : {
        ...pipeline.collection,
        latest_sample_ms: pipeline.collection.latest_sample_ms === null
          ? null
          : Math.max(0, pipeline.collection.latest_sample_ms - run.visibleStartMs),
        collecting_window_start_ms: Math.max(0, pipeline.collection.collecting_window_start_ms - run.visibleStartMs),
        collecting_window_end_ms: Math.max(0, pipeline.collection.collecting_window_end_ms - run.visibleStartMs),
      };
    const lastWindow = pipeline.lastWindow.start_ms === null || pipeline.lastWindow.end_ms === null
      ? { ...pipeline.lastWindow }
      : pipeline.lastWindow.start_ms < run.visibleStartMs
        ? { session_id: null, epoch_id: null, start_ms: null, end_ms: null }
        : {
          ...pipeline.lastWindow,
          start_ms: pipeline.lastWindow.start_ms - run.visibleStartMs,
          end_ms: pipeline.lastWindow.end_ms - run.visibleStartMs,
        };
    return { ...pipeline, collection, lastWindow };
  }

  private async runScenario(run: ActiveDemoRun, generation: number): Promise<void> {
    try {
      await this.emitRange(run, 0, run.visibleStartMs, false, generation);
      if (!this.isCurrent(run, generation)) return;
      if (!run.stopRequested) {
        const firstVisiblePacket = this.emitInternalPacket(run, run.visibleStartMs);
        await this.waitForPipelineDrain(run, generation);
        if (run.pipeline.getSnapshot().baseline.ready_modalities.length !== MODALITIES.length) {
          throw new Error("demo baseline did not become ready for all five modalities before streaming");
        }
        if (run.stopRequested) {
          run.fullRun = false;
        } else {
          run.phase = "STREAMING";
          run.session.status = "LIVE";
          run.session.updated_at_ms = this.now();
          this.publishPresentationPacket(run, firstVisiblePacket);
          run.visibleElapsedMs = DEMO_PACKET_PERIOD_MS;

          for (let internalStartMs = run.visibleStartMs + DEMO_PACKET_PERIOD_MS;
            internalStartMs < run.visibleEndMs;
            internalStartMs += DEMO_PACKET_PERIOD_MS) {
            if (!this.isCurrent(run, generation) || run.stopRequested) {
              break;
            }
            this.emitPacket(run, internalStartMs, true);
            run.visibleElapsedMs += DEMO_PACKET_PERIOD_MS;
            run.session.updated_at_ms = this.now();
            await sleep(this.visiblePacketDelayMs);
          }
        }
      }

      run.fullRun = !run.stopRequested && run.visibleElapsedMs >= run.scenario.visible_duration_ms;
      run.phase = "FINALIZING";
      run.session.updated_at_ms = this.now();

      if (run.fullRun) {
        // This boundary packet is intentionally analysis-only. Its first sample
        // is exactly at the next boundary, so the final visible [20s, 30s)
        // window closes without broadcasting a pre-roll or tail packet.
        this.emitInternalPacket(run, run.visibleEndMs);
      }
      await this.waitForPipelineDrain(run, generation);
      run.baselineSummary = run.latestResult?.baseline_update?.baseline_after ??
        run.latestResult?.baseline ?? run.baselineSummary;
      run.pipeline.requestSessionStop(run.session.session_id);
      await this.waitForFinalPipelineState(run, generation);
      run.baselineSummary = run.baselineSummary ?? run.latestResult?.baseline ?? null;

      const finalAnalysis = this.synthesizeVisibleFinal(run);
      run.session.final_analysis = finalAnalysis;
      run.session.analysis_window_count = run.visibleResults.length;
      run.session.packet_count = run.visiblePacketCount;
      run.session.duration_ms = run.fullRun ? run.scenario.visible_duration_ms : run.visibleElapsedMs;
      run.session.completed_at_ms = this.now();
      run.session.updated_at_ms = run.session.completed_at_ms;
      run.session.status = "COMPLETED";
      this.validateCompletedRun(run);
      run.phase = run.validationState === "failed" ? "ERROR" : "COMPLETE";
      if (run.phase === "ERROR") {
        run.session.status = "ERROR";
        run.session.error = run.validationMessage;
        run.error = run.validationMessage;
      }
    } catch (error) {
      if (!this.isCurrent(run, generation)) return;
      const message = error instanceof Error ? error.message : "unknown demonstration error";
      run.phase = "ERROR";
      run.validationState = "failed";
      run.validationMessage = message;
      run.error = message;
      run.session.status = "ERROR";
      run.session.error = message;
      run.session.updated_at_ms = this.now();
      run.unsubscribeResults();
      run.pipeline.close();
    }
  }

  private async emitRange(
    run: ActiveDemoRun,
    startMs: number,
    endMs: number,
    visible: boolean,
    generation: number,
  ): Promise<void> {
    let emitted = 0;
    for (let internalStartMs = startMs; internalStartMs < endMs; internalStartMs += DEMO_PACKET_PERIOD_MS) {
      if (!this.isCurrent(run, generation) || run.stopRequested) return;
      this.emitPacket(run, internalStartMs, visible);
      emitted += 1;
      if (emitted % this.preRollYieldEveryPackets === 0) {
        await immediate();
      }
    }
  }

  private emitPacket(run: ActiveDemoRun, internalStartMs: number, visible: boolean): void {
    const packet = this.emitInternalPacket(run, internalStartMs);
    if (!visible) return;
    this.publishPresentationPacket(run, packet);
  }

  private emitInternalPacket(run: ActiveDemoRun, internalStartMs: number): AcceptedObjectivePacket {
    const packet = generateDemoAcceptedPacket(
      run.context,
      run.scenario,
      run.nextSequence,
      internalStartMs,
      run.visibleStartMs,
      DEMO_BASELINE_DURATION_MS,
    );
    run.nextSequence += 1;
    run.internalPacketCount += 1;
    const validation = validateSchemaV1Packet(packet.raw_packet);
    if (!validation.valid) {
      throw new Error(`demo packet validation failed before acceptance: ${validation.reason}`);
    }
    run.packetBus.publish(packet);
    return packet;
  }

  private publishPresentationPacket(run: ActiveDemoRun, packet: AcceptedObjectivePacket): void {
    const presentationPacket = rebasePacket(packet, run.visibleStartMs);
    const envelope: DemoPacketEnvelope = {
      ...presentationPacket,
      replay_t0_ms: presentationPacket.plot_t0_ms,
    };
    run.session.packets.push(envelope);
    run.visiblePacketCount += 1;
    this.packetBus.publish(presentationPacket);
  }

  private handleInternalResult(run: ActiveDemoRun, result: AnalysisResult): void {
    if (this.activeRun !== run || result.session_id !== run.session.session_id) return;
    if (result.window.end_ms <= run.visibleStartMs) {
      run.baselineSummary = result.baseline_update?.baseline_after ?? run.baselineSummary;
      return;
    }
    if (
      result.window.start_ms < run.visibleStartMs ||
      result.window.end_ms > run.visibleEndMs
    ) {
      return;
    }
    const presentationResult = rebaseResult(result, run.visibleStartMs);
    if (run.visibleResults.some((existing) => existing.window.start_ms === presentationResult.window.start_ms)) {
      return;
    }
    run.latestResult = presentationResult;
    run.latestPattern = presentationResult.multimodal_result.pattern;
    run.latestEvidenceTier = presentationResult.multimodal_result.evidence_tier;
    run.latestRuleIds = [...presentationResult.multimodal_result.rule_ids];
    run.baselineSummary = presentationResult.baseline_update?.baseline_after ?? presentationResult.baseline;
    if (isForbiddenVisibleResult(presentationResult)) {
      run.validationState = "failed";
      run.validationMessage = "Demo guard stopped the scenario after a visible MM-07/insufficient-evidence result.";
      run.error = run.validationMessage;
      run.stopRequested = true;
      return;
    }
    run.visibleResults.push(presentationResult);
    run.visibleResults.sort((left, right) => left.window.start_ms - right.window.start_ms);
    run.session.analysis_results.push(clone(presentationResult));
    this.resultBus.publish(presentationResult);
  }

  private synthesizeVisibleFinal(run: ActiveDemoRun): FinalSessionAnalysis {
    const results = [...run.visibleResults].sort((left, right) => left.window.start_ms - right.window.start_ms);
    const last = results.at(-1);
    const baseline = run.baselineSummary ?? last?.baseline_update?.baseline_after ?? last?.baseline ?? null;
    return synthesizeFinalSessionAnalysis({
      session_id: run.session.session_id,
      device_id: DEMO_DEVICE_ID,
      completed_results: results,
      missing_windows: [],
      incomplete_tails: [],
      epoch_coverage: [{
        epoch_id: run.session.epoch_id,
        first_sample_ms: 0,
        last_sample_ms: run.fullRun ? run.scenario.visible_duration_ms : run.visibleElapsedMs,
      }],
      baseline_summary: baseline,
      created_at_ms: this.now(),
    });
  }

  private validateCompletedRun(run: ActiveDemoRun): void {
    if (run.validationState === "failed") return;
    const results = run.visibleResults;
    const expectedWindows = Math.floor(run.scenario.visible_duration_ms / 10_000);
    const qualityGood = results.every((result) => MODALITIES.every(
      (modality) => result.modality_results[modality].quality.state === "good",
    ));
    const forbidden = results.find(isForbiddenVisibleResult);
    const allRuleIds = [...new Set(results.flatMap((result) => [
      ...result.rules_triggered,
      ...result.multimodal_result.rule_ids,
    ]))];
    const hasPpgDisagreement = results.some((result) =>
      result.multimodal_result.rule_ids.includes("PPG-02") ||
      result.modality_results.ppg.rule_evaluations.some((rule) => rule.rule_id === "PPG-02" && rule.status === "fired"),
    );
    if (run.fullRun && results.length !== expectedWindows) {
      run.validationState = "failed";
      run.validationMessage = `Expected ${expectedWindows} visible analysis windows but received ${results.length}.`;
    } else if (!qualityGood && run.fullRun) {
      run.validationState = "failed";
      run.validationMessage = "Demo guard rejected a visible modality quality state below good.";
    } else if (forbidden !== undefined) {
      run.validationState = "failed";
      run.validationMessage = "Demo guard rejected a visible insufficient-evidence result.";
    } else if (hasPpgDisagreement) {
      run.validationState = "failed";
      run.validationMessage = "Demo guard rejected a visible PPG-02 disagreement result.";
    } else {
      run.validationState = "passed";
      run.validationMessage = `Validated ${results.length} visible windows through the real analysis pipeline.`;
    }
    run.session.expected_result_pattern = results.at(-1)?.multimodal_result.pattern ?? null;
    run.session.actual_rule_ids = allRuleIds;
    run.session.error = run.validationState === "failed" ? run.validationMessage : null;
  }

  private async waitForPipelineDrain(run: ActiveDemoRun, generation: number): Promise<void> {
    const deadline = Date.now() + MAX_REQUESTED_STOP_WAIT_MS;
    while (run.pipeline.getSnapshot().pendingAnalysisWindows > 0) {
      if (!this.isCurrent(run, generation)) return;
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the isolated demo analysis worker");
      }
      await immediate();
    }
  }

  private async waitForFinalPipelineState(run: ActiveDemoRun, generation: number): Promise<void> {
    const deadline = Date.now() + MAX_REQUESTED_STOP_WAIT_MS;
    while (true) {
      if (!this.isCurrent(run, generation)) return;
      const state = run.pipeline.getFinalAnalysisState(run.session.session_id);
      if (state === "complete") return;
      if (state === "error") {
        throw new Error("isolated demo pipeline finalization failed");
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the isolated demo finalization");
      }
      await immediate();
    }
  }

  private isCurrent(run: ActiveDemoRun, generation: number): boolean {
    return !this.closed && this.activeRun === run && this.runGeneration === generation;
  }

  private cancelActiveRun(): void {
    this.runGeneration += 1;
    const run = this.activeRun;
    this.activeRun = null;
    if (run === null) return;
    run.stopRequested = true;
    run.unsubscribeResults();
    run.pipeline.close();
  }

  private latestSessionSummary(): DemoSessionSummary | null {
    const latest = [...this.sessions.values()].sort((left, right) => right.created_at_ms - left.created_at_ms)[0];
    return latest === undefined ? null : summaryOf(latest);
  }

  private pruneSessions(now: number): void {
    const active = this.activeRun;
    if (
      active !== null &&
      (active.phase === "COMPLETE" || active.phase === "ERROR") &&
      now - active.session.updated_at_ms > this.sessionTtlMs
    ) {
      this.activeRun = null;
      this.runGeneration += 1;
      active.unsubscribeResults();
      active.pipeline.close();
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.activeRun?.session.session_id === sessionId) continue;
      if (now - session.updated_at_ms > this.sessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }
    this.trimHistory(now);
  }

  private trimHistory(now: number): void {
    this.pruneExpiredWithoutRecursion(now);
    while (this.sessions.size > this.maxRetainedSessions) {
      const oldest = [...this.sessions.values()]
        .filter((session) => this.activeRun?.session.session_id !== session.session_id)
        .sort((left, right) => left.created_at_ms - right.created_at_ms)[0];
      if (oldest === undefined) return;
      this.sessions.delete(oldest.session_id);
    }
  }

  private pruneExpiredWithoutRecursion(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (this.activeRun?.session.session_id === sessionId) continue;
      if (now - session.updated_at_ms > this.sessionTtlMs) this.sessions.delete(sessionId);
    }
  }
}
