import { randomUUID } from "node:crypto";

import { AcceptedPacketBus, type AcceptedObjectivePacket } from "../acceptedPacketBus.js";
import { ObjectiveAnalysisPipeline } from "../analysis/pipeline.js";
import {
  synthesizeFinalSessionAnalysis,
  type FinalSessionAnalysis,
} from "../analysis/sessionSynthesis.js";
import type {
  AnalysisModality,
  AnalysisResult,
  BaselineSummary,
} from "../analysis/types.js";
import { AnalysisResultBus } from "../analysis/resultBus.js";
import { createObjectiveLiveGateway } from "../live/liveGateway.js";
import { validateSchemaV1Packet } from "../packetValidator.js";
import { DEMO_SCENARIOS, getDemoScenario } from "./demoCatalog.js";
import {
  DEMO_BASELINE_DURATION_MS,
  DEMO_DEVICE_ID,
  DEMO_PACKET_PERIOD_MS,
  DEMO_VISIBLE_DURATION_MS,
  type DemoFinalAnalysisState,
  type DemoPhase,
  type DemoResultResponse,
  type DemoRuntimeStatus,
  type DemoScenarioDefinition,
  type DemoValidation,
} from "./demoTypes.js";
import { generateDemoAcceptedPacket, type DemoPacketContext } from "./demoSignalGenerator.js";

const MODALITIES: AnalysisModality[] = ["ecg", "ppg", "gsr", "imu", "temperature"];
const FORBIDDEN_PATTERN = "Insufficient evidence for multimodal interpretation";
const MAX_PIPELINE_WAIT_MS = 5_000;
const BUSY_PHASES: DemoPhase[] = ["PREPARING", "READY", "STREAMING", "FINALIZING"];

export type DemoRuntimeErrorCode =
  | "closed"
  | "unknown_scenario"
  | "run_in_progress"
  | "no_run"
  | "invalid_session"
  | "not_ready"
  | "already_started";

export class DemoRuntimeError extends Error {
  constructor(
    readonly code: DemoRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DemoRuntimeError";
  }
}

export interface DemoRuntimeOptions {
  now?: () => number;
  createId?: () => string;
  visiblePacketDelayMs?: number;
  preRollYieldEveryPackets?: number;
}

interface ActiveDemoRun {
  sessionId: string;
  scenario: DemoScenarioDefinition;
  context: DemoPacketContext;
  visibleStartMs: number;
  visibleEndMs: number;
  phase: DemoPhase;
  visibleElapsedMs: number;
  visiblePacketCount: number;
  nextSequence: number;
  firstVisiblePacket: AcceptedObjectivePacket | null;
  visibleResults: AnalysisResult[];
  latestResult: AnalysisResult | null;
  baselineSummary: BaselineSummary | null;
  finalAnalysis: FinalSessionAnalysis | null;
  validation: DemoValidation;
  error: string | null;
  stopRequested: boolean;
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

function emptyValidation(): DemoValidation {
  return { state: "pending", message: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown demonstration error";
}

function allRuleIds(results: readonly AnalysisResult[]): Set<string> {
  const ids = new Set<string>();
  for (const result of results) {
    result.rules_triggered.forEach((ruleId) => ids.add(ruleId));
    result.multimodal_result.rule_ids.forEach((ruleId) => ids.add(ruleId));
    for (const modality of MODALITIES) {
      for (const evaluation of result.modality_results[modality].rule_evaluations) {
        if (evaluation.status === "fired") ids.add(evaluation.rule_id);
      }
    }
  }
  return ids;
}

function finalAnalysisState(run: ActiveDemoRun | null): DemoFinalAnalysisState {
  if (run === null) return "unavailable";
  if (run.finalAnalysis !== null) return "complete";
  return run.phase === "ERROR" ? "error" : "pending";
}

export class DemoRuntime {
  /** Presentation-only buses. The production buses are never passed here. */
  readonly packetBus = new AcceptedPacketBus();
  readonly resultBus = new AnalysisResultBus();
  readonly liveGateway = createObjectiveLiveGateway(this.packetBus, this.resultBus);

  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly visiblePacketDelayMs: number;
  private readonly preRollYieldEveryPackets: number;
  private activeRun: ActiveDemoRun | null = null;
  private runGeneration = 0;
  private closed = false;

  constructor(options: DemoRuntimeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.visiblePacketDelayMs = Math.max(0, options.visiblePacketDelayMs ?? DEMO_PACKET_PERIOD_MS);
    this.preRollYieldEveryPackets = Math.max(1, options.preRollYieldEveryPackets ?? 50);
  }

  listScenarios(): DemoScenarioDefinition[] {
    return DEMO_SCENARIOS.map((scenario) => ({
      ...scenario,
      expected_rule_ids: [...scenario.expected_rule_ids],
    }));
  }

  async prepareScenario(scenarioId: string): Promise<DemoRuntimeStatus> {
    if (this.closed) {
      throw new DemoRuntimeError("closed", "demo runtime is closed");
    }
    const scenario = getDemoScenario(scenarioId);
    if (scenario === undefined) {
      throw new DemoRuntimeError("unknown_scenario", "unknown demonstration scenario");
    }
    if (this.activeRun !== null && BUSY_PHASES.includes(this.activeRun.phase)) {
      throw new DemoRuntimeError(
        "run_in_progress",
        "another demonstration scenario is already preparing or running",
      );
    }

    this.disposeActiveRun();
    const sessionId = this.createId();
    const packetBus = new AcceptedPacketBus();
    const resultBus = new AnalysisResultBus();
    const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);
    const run: ActiveDemoRun = {
      sessionId,
      scenario,
      context: {
        session_id: sessionId,
        boot_id: this.createId(),
        epoch_id: this.createId(),
        wall_start_ms: this.now(),
      },
      visibleStartMs: DEMO_BASELINE_DURATION_MS + scenario.hidden_prime_duration_ms,
      visibleEndMs: DEMO_BASELINE_DURATION_MS + scenario.hidden_prime_duration_ms + scenario.visible_duration_ms,
      phase: "PREPARING",
      visibleElapsedMs: 0,
      visiblePacketCount: 0,
      nextSequence: 1,
      firstVisiblePacket: null,
      visibleResults: [],
      latestResult: null,
      baselineSummary: null,
      finalAnalysis: null,
      validation: emptyValidation(),
      error: null,
      stopRequested: false,
      packetBus,
      resultBus,
      pipeline,
      unsubscribeResults: () => undefined,
    };
    run.unsubscribeResults = run.resultBus.subscribe((result) => this.handleInternalResult(run, result));
    this.activeRun = run;
    const generation = ++this.runGeneration;

    try {
      await this.emitRange(run, 0, run.visibleStartMs, generation);
      if (!this.isCurrent(run, generation)) {
        throw new DemoRuntimeError("closed", "demo runtime was closed during preparation");
      }
      // This packet closes the hidden baseline boundary. Hold it until the
      // browser WebSocket handshake completes; it is never published here.
      run.firstVisiblePacket = this.emitInternalPacket(run, run.visibleStartMs);
      await this.waitForPipelineDrain(run, generation);
      const snapshot = run.pipeline.getSnapshot();
      const readyModalities = run.baselineSummary?.ready_modalities ?? snapshot.baseline.ready_modalities;
      if (!snapshot.baseline.collection_complete || readyModalities.length !== MODALITIES.length) {
        throw new Error("demo baseline did not become ready for all five modalities before streaming");
      }
      run.baselineSummary = run.baselineSummary ?? this.baselineFromSnapshot(run);
      run.phase = "READY";
      return this.getStatus();
    } catch (error) {
      if (this.isCurrent(run, generation)) {
        this.failRun(run, errorMessage(error));
      }
      throw error;
    }
  }

  startVisibleRun(sessionId: string): DemoRuntimeStatus {
    if (this.closed) {
      throw new DemoRuntimeError("closed", "demo runtime is closed");
    }
    const run = this.activeRun;
    if (run === null) {
      throw new DemoRuntimeError("no_run", "no demonstration scenario is prepared");
    }
    if (run.sessionId !== sessionId) {
      throw new DemoRuntimeError("invalid_session", "session_id does not match the prepared scenario");
    }
    if (run.phase !== "READY") {
      throw new DemoRuntimeError(
        run.phase === "STREAMING" || run.phase === "FINALIZING" || run.phase === "COMPLETE"
          ? "already_started"
          : "not_ready",
        run.phase === "ERROR"
          ? "the prepared demonstration is in an error state"
          : "demonstration is not ready to stream",
      );
    }
    if (!run.baselineSummary || run.baselineSummary.ready_modalities.length !== MODALITIES.length) {
      throw new DemoRuntimeError("not_ready", "demo baseline is not ready for all five modalities");
    }

    run.phase = "STREAMING";
    run.validation = emptyValidation();
    run.stopRequested = false;
    const generation = this.runGeneration;
    void this.streamVisible(run, generation);
    return this.getStatus();
  }

  abortPreparedRun(sessionId: string): DemoRuntimeStatus {
    if (this.closed) {
      throw new DemoRuntimeError("closed", "demo runtime is closed");
    }
    const run = this.activeRun;
    if (run === null) {
      throw new DemoRuntimeError("no_run", "no demonstration scenario is prepared");
    }
    if (run.sessionId !== sessionId) {
      throw new DemoRuntimeError("invalid_session", "session_id does not match the prepared scenario");
    }
    if (run.phase !== "PREPARING" && run.phase !== "READY") {
      throw new DemoRuntimeError("already_started", "the demonstration is already streaming or finalized");
    }
    this.failRun(run, "Unable to start demonstration stream.");
    return this.getStatus();
  }

  getStatus(): DemoRuntimeStatus {
    const run = this.activeRun;
    if (run === null) {
      return {
        phase: "IDLE",
        scenario: null,
        session_id: null,
        visible_elapsed_ms: 0,
        visible_duration_ms: DEMO_VISIBLE_DURATION_MS,
        visible_packet_count: 0,
        completed_window_count: 0,
        baseline_ready: false,
        baseline_ready_modalities: [],
        latest_result: null,
        validation: emptyValidation(),
        final_analysis: { session_id: null, state: "unavailable", available: false },
        error: null,
      };
    }

    const snapshot = run.pipeline.getSnapshot();
    const readyModalities = run.baselineSummary?.ready_modalities ?? snapshot.baseline.ready_modalities;
    return {
      phase: run.phase,
      scenario: clone(run.scenario),
      session_id: run.sessionId,
      visible_elapsed_ms: run.visibleElapsedMs,
      visible_duration_ms: run.scenario.visible_duration_ms,
      visible_packet_count: run.visiblePacketCount,
      completed_window_count: run.visibleResults.length,
      baseline_ready: readyModalities.length === MODALITIES.length,
      baseline_ready_modalities: [...readyModalities],
      latest_result: run.latestResult === null ? null : clone(run.latestResult),
      validation: clone(run.validation),
      final_analysis: {
        session_id: run.sessionId,
        state: finalAnalysisState(run),
        available: run.finalAnalysis !== null,
      },
      error: run.error,
    };
  }

  getResult(sessionId: string): DemoResultResponse | undefined {
    const run = this.activeRun;
    if (run === null || run.sessionId !== sessionId) return undefined;
    const readyModalities = run.baselineSummary?.ready_modalities ?? [];
    return {
      session_id: run.sessionId,
      scenario: clone(run.scenario),
      completed_results: run.visibleResults.map(clone),
      latest_result: run.latestResult === null ? null : clone(run.latestResult),
      final_analysis: run.finalAnalysis === null ? null : clone(run.finalAnalysis),
      baseline_ready: readyModalities.length === MODALITIES.length,
      baseline_ready_modalities: [...readyModalities],
      validation: clone(run.validation),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposeActiveRun();
    this.liveGateway.close();
  }

  private async streamVisible(run: ActiveDemoRun, generation: number): Promise<void> {
    try {
      if (run.firstVisiblePacket !== null && !run.stopRequested) {
        this.publishPresentationPacket(run, run.firstVisiblePacket);
        run.visibleElapsedMs = DEMO_PACKET_PERIOD_MS;
        await sleep(this.visiblePacketDelayMs);
      }
      for (
        let internalStartMs = run.visibleStartMs + DEMO_PACKET_PERIOD_MS;
        internalStartMs < run.visibleEndMs;
        internalStartMs += DEMO_PACKET_PERIOD_MS
      ) {
        if (!this.isCurrent(run, generation) || run.stopRequested) break;
        const packet = this.emitInternalPacket(run, internalStartMs);
        this.publishPresentationPacket(run, packet);
        run.visibleElapsedMs = Math.min(
          run.scenario.visible_duration_ms,
          internalStartMs - run.visibleStartMs + DEMO_PACKET_PERIOD_MS,
        );
        await sleep(this.visiblePacketDelayMs);
      }

      if (!this.isCurrent(run, generation)) return;
      const fullRun = !run.stopRequested && run.visibleElapsedMs >= run.scenario.visible_duration_ms;
      run.phase = "FINALIZING";

      // The boundary packet closes W3 inside the isolated pipeline. It is not
      // published to the presentation bus, so it cannot create a fourth graph
      // packet or visible tail.
      if (fullRun) this.emitInternalPacket(run, run.visibleEndMs);
      await this.waitForPipelineDrain(run, generation);
      run.pipeline.requestSessionStop(run.sessionId);
      await this.waitForFinalPipelineState(run, generation);

      if (!this.isCurrent(run, generation)) return;
      run.finalAnalysis = this.synthesizeVisibleFinal(run, fullRun);
      this.validateCompletedRun(run, fullRun);
      if (run.validation.state === "failed") {
        run.phase = "ERROR";
        run.error = run.validation.message;
      } else {
        run.phase = "COMPLETE";
      }
    } catch (error) {
      if (!this.isCurrent(run, generation)) return;
      this.failRun(run, errorMessage(error));
    }
  }

  private async emitRange(
    run: ActiveDemoRun,
    startMs: number,
    endMs: number,
    generation: number,
  ): Promise<void> {
    let emitted = 0;
    for (let internalStartMs = startMs; internalStartMs < endMs; internalStartMs += DEMO_PACKET_PERIOD_MS) {
      if (!this.isCurrent(run, generation) || run.stopRequested) return;
      this.emitInternalPacket(run, internalStartMs);
      emitted += 1;
      if (emitted % this.preRollYieldEveryPackets === 0) await immediate();
    }
  }

  private emitInternalPacket(run: ActiveDemoRun, internalStartMs: number): AcceptedObjectivePacket {
    const packet = generateDemoAcceptedPacket(
      run.context,
      run.scenario,
      run.nextSequence,
      internalStartMs,
      run.visibleStartMs,
    );
    run.nextSequence += 1;
    const validation = validateSchemaV1Packet(packet.raw_packet);
    if (!validation.valid) {
      throw new Error(`demo packet validation failed before acceptance: ${validation.reason}`);
    }
    run.packetBus.publish(packet);
    return packet;
  }

  private publishPresentationPacket(run: ActiveDemoRun, packet: AcceptedObjectivePacket): void {
    const presentationPacket = rebasePacket(packet, run.visibleStartMs);
    this.packetBus.publish(presentationPacket);
    // The raw packet is intentionally not retained. The current browser owns
    // the bounded 30-second graph buffers and there is no demo history store.
    run.visiblePacketCount += 1;
  }

  private handleInternalResult(run: ActiveDemoRun, result: AnalysisResult): void {
    if (this.activeRun !== run || result.session_id !== run.sessionId) return;
    if (result.window.end_ms <= run.visibleStartMs) {
      run.baselineSummary = result.baseline_update?.baseline_after ?? run.baselineSummary;
      return;
    }
    if (result.window.start_ms < run.visibleStartMs || result.window.end_ms > run.visibleEndMs) return;

    const presentationResult = rebaseResult(result, run.visibleStartMs);
    if (run.visibleResults.some((existing) =>
      existing.epoch_id === presentationResult.epoch_id &&
      existing.window.start_ms === presentationResult.window.start_ms &&
      existing.window.end_ms === presentationResult.window.end_ms
    )) return;

    run.latestResult = presentationResult;
    run.baselineSummary = presentationResult.baseline_update?.baseline_after ?? presentationResult.baseline;
    run.visibleResults.push(presentationResult);
    run.visibleResults.sort((left, right) => left.window.start_ms - right.window.start_ms);
    this.resultBus.publish(clone(presentationResult));

    if (isForbiddenVisibleResult(presentationResult)) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: visible MM-07/insufficient-evidence result.",
      };
      run.stopRequested = true;
    }
  }

  private synthesizeVisibleFinal(run: ActiveDemoRun, fullRun: boolean): FinalSessionAnalysis {
    const results = [...run.visibleResults].sort((left, right) => left.window.start_ms - right.window.start_ms);
    const last = results.at(-1);
    const baseline = run.baselineSummary ?? last?.baseline_update?.baseline_after ?? last?.baseline ?? null;
    const durationMs = fullRun ? run.scenario.visible_duration_ms : run.visibleElapsedMs;
    return synthesizeFinalSessionAnalysis({
      session_id: run.sessionId,
      device_id: DEMO_DEVICE_ID,
      completed_results: results,
      missing_windows: [],
      incomplete_tails: [],
      epoch_coverage: [{
        epoch_id: run.context.epoch_id,
        first_sample_ms: 0,
        last_sample_ms: durationMs,
      }],
      baseline_summary: baseline,
      created_at_ms: this.now(),
    });
  }

  private validateCompletedRun(run: ActiveDemoRun, fullRun: boolean): void {
    if (run.validation.state === "failed") return;
    const results = run.visibleResults;
    const expectedStarts = [0, 10_000, 20_000];
    const expectedEnds = [10_000, 20_000, 30_000];
    const ready = run.baselineSummary?.ready_modalities ?? [];
    const expected = run.scenario;

    if (!fullRun || results.length !== 3) {
      run.validation = {
        state: "failed",
        message: `Demonstration validation failed: expected exactly 3 visible windows, received ${results.length}.`,
      };
      return;
    }
    if (results.some((result, index) =>
      result.window.start_ms !== expectedStarts[index] || result.window.end_ms !== expectedEnds[index]
    )) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: visible windows were not exactly [0,10), [10,20), [20,30).",
      };
      return;
    }
    if (ready.length !== MODALITIES.length || !MODALITIES.every((modality) => ready.includes(modality))) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: baseline was not ready for all five modalities.",
      };
      return;
    }
    if (results.some((result) => MODALITIES.some((modality) =>
      result.modality_results[modality].quality.state !== "good"
    ))) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: a visible modality quality state was below good.",
      };
      return;
    }
    if (results.some(isForbiddenVisibleResult)) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: visible insufficient-evidence output.",
      };
      return;
    }
    if (results.some((result) =>
      result.multimodal_result.rule_ids.includes("PPG-02") ||
      result.modality_results.ppg.rule_evaluations.some((rule) =>
        rule.rule_id === "PPG-02" && rule.status === "fired"
      )
    )) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: visible PPG-02 disagreement output.",
      };
      return;
    }
    if (results.some((result) =>
      result.multimodal_result.pattern !== expected.expected_pattern ||
      result.multimodal_result.evidence_tier !== expected.expected_evidence_tier
    )) {
      run.validation = {
        state: "failed",
        message: `Demonstration validation failed: actual pipeline output did not match the ${expected.id} contract.`,
      };
      return;
    }

    const actualRuleIds = allRuleIds(results);
    const missingRule = expected.expected_rule_ids.find((ruleId) => !actualRuleIds.has(ruleId));
    if (missingRule !== undefined) {
      run.validation = {
        state: "failed",
        message: `Demonstration validation failed: expected fired rule ${missingRule} was absent from the actual result.`,
      };
      return;
    }
    if (expected.id === "corroborated_multimodal_change") {
      const supporting = new Set<AnalysisModality>(results.flatMap((result) => result.multimodal_result.supporting_modalities));
      if ((["ecg", "ppg", "gsr"] as AnalysisModality[]).some((modality) => !supporting.has(modality))) {
        run.validation = {
          state: "failed",
          message: "Demonstration validation failed: corroborated scenario did not support ECG, PPG, and GSR.",
        };
        return;
      }
    }

    const final = run.finalAnalysis;
    if (
      final === null ||
      final.session.duration_ms !== DEMO_VISIBLE_DURATION_MS ||
      final.session.completed_window_count !== 3 ||
      final.window_coverage.missing_windows.length !== 0 ||
      final.window_coverage.incomplete_tails.length !== 0 ||
      final.baseline.ready_modalities.length !== MODALITIES.length
    ) {
      run.validation = {
        state: "failed",
        message: "Demonstration validation failed: final synthesis did not cover exactly the visible 30-second phase.",
      };
      return;
    }
    run.validation = {
      state: "passed",
      message: "Validated three visible completed windows through the real analysis pipeline.",
    };
  }

  private baselineFromSnapshot(run: ActiveDemoRun): BaselineSummary | null {
    const state = run.pipeline.getSnapshot().baseline;
    if (!state.collection_complete) return null;
    const last = run.latestResult;
    return last?.baseline_update?.baseline_after ?? last?.baseline ?? null;
  }

  private async waitForPipelineDrain(run: ActiveDemoRun, generation: number): Promise<void> {
    const deadline = Date.now() + MAX_PIPELINE_WAIT_MS;
    while (run.pipeline.getSnapshot().pendingAnalysisWindows > 0) {
      if (!this.isCurrent(run, generation)) return;
      if (Date.now() >= deadline) throw new Error("timed out waiting for the isolated demo analysis worker");
      await immediate();
    }
  }

  private async waitForFinalPipelineState(run: ActiveDemoRun, generation: number): Promise<void> {
    const deadline = Date.now() + MAX_PIPELINE_WAIT_MS;
    while (true) {
      if (!this.isCurrent(run, generation)) return;
      const state = run.pipeline.getFinalAnalysisState(run.sessionId);
      if (state === "complete") return;
      if (state === "error") throw new Error("isolated demo pipeline finalization failed");
      if (Date.now() >= deadline) throw new Error("timed out waiting for isolated demo finalization");
      await immediate();
    }
  }

  private failRun(run: ActiveDemoRun, message: string): void {
    run.phase = "ERROR";
    run.validation = { state: "failed", message: `Demonstration validation failed: ${message}` };
    run.error = message;
    run.stopRequested = true;
    run.unsubscribeResults();
    run.pipeline.close();
  }

  private isCurrent(run: ActiveDemoRun, generation: number): boolean {
    return !this.closed && this.activeRun === run && this.runGeneration === generation;
  }

  private disposeActiveRun(): void {
    this.runGeneration += 1;
    const run = this.activeRun;
    this.activeRun = null;
    if (run === null) return;
    run.stopRequested = true;
    run.unsubscribeResults();
    run.pipeline.close();
  }
}
