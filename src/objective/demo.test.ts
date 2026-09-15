import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { handleObjectiveDemoRequest } from "./demo/demoRoutes.js";
import { DEMO_SCENARIOS } from "./demo/demoCatalog.js";
import { DemoRuntime } from "./demo/demoRuntime.js";
import {
  generateDemoRawPacket,
  generateDemoAcceptedPacket,
} from "./demo/demoSignalGenerator.js";
import { getDemoScenario } from "./demo/demoCatalog.js";
import {
  DEMO_BASELINE_DURATION_MS,
  DEMO_PACKET_PERIOD_MS,
  DEMO_VISIBLE_DURATION_MS,
} from "./demo/demoTypes.js";
import { validateSchemaV1Packet } from "./packetValidator.js";
import { handleObjectiveDashboardRequest } from "./dashboard/dashboardRoutes.js";
import { attachObjectiveWebSocketRouter } from "./objectiveWebSocketRouter.js";
import type { LiveGateway } from "./live/liveGateway.js";
import type { DeviceGateway } from "./deviceGateway.js";

const FIXED_CONTEXT = {
  session_id: "00000000-0000-4000-8000-000000000001",
  boot_id: "00000000-0000-4000-8000-000000000002",
  epoch_id: "00000000-0000-4000-8000-000000000003",
  wall_start_ms: 1_700_000_000_000,
};

function responseCapture(): ServerResponse & { statusCode: number; body: unknown } {
  const capture = {
    statusCode: 0,
    body: null as unknown,
    writeHead(statusCode: number) {
      capture.statusCode = statusCode;
      return capture;
    },
    end(body?: string | Buffer) {
      if (body === undefined) {
        capture.body = null;
      } else {
        const text = body.toString();
        try {
          capture.body = JSON.parse(text);
        } catch {
          capture.body = text;
        }
      }
    },
  };
  return capture as unknown as ServerResponse & { statusCode: number; body: unknown };
}

function request(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(stream, { method, url });
  return stream as unknown as IncomingMessage;
}

function idFactory(): () => string {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}

async function waitForTerminal(runtime: DemoRuntime, sessionId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    const phase = runtime.getStatus().demo.phase;
    if (phase === "COMPLETE" || phase === "ERROR") return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for demo session ${sessionId}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

test("the catalog exposes exactly the five deterministic scenarios", () => {
  assert.deepEqual(DEMO_SCENARIOS.map((scenario) => scenario.id), [
    "stable_baseline",
    "isolated_cardiovascular_change",
    "isolated_electrodermal_change",
    "isolated_temperature_change",
    "corroborated_multimodal_change",
  ]);
  assert.equal(DEMO_SCENARIOS.length, 5);
  assert.equal(DEMO_SCENARIOS[0].expected_rule_ids[0], "MM-08");
  assert.equal(DEMO_SCENARIOS[4].expected_evidence_tier, "corroborated");
});

test("demo packets are valid Schema V1 packets at the requested raw sample rates", () => {
  const scenario = getDemoScenario("stable_baseline")!;
  const first = generateDemoRawPacket(FIXED_CONTEXT, scenario, 1, 0, DEMO_BASELINE_DURATION_MS);
  const validation = validateSchemaV1Packet(first);
  assert.equal(validation.valid, true);
  assert.deepEqual(first.n, [25, 10, 13, 10, 1]);
  assert.equal(first.t1_us - first.t0_us, 100_000);
  assert.equal(first.ecg.at(-1)![0], 96_000);

  for (const scenarioDefinition of DEMO_SCENARIOS) {
    const totals = [0, 0, 0, 0, 0];
    let previousT1Us = 0;
    for (let index = 0; index < 100; index += 1) {
      const packet = generateDemoRawPacket(
        FIXED_CONTEXT,
        scenarioDefinition,
        index + 1,
        index * DEMO_PACKET_PERIOD_MS,
        DEMO_BASELINE_DURATION_MS,
      );
      const result = validateSchemaV1Packet(packet);
      assert.equal(result.valid, true, scenarioDefinition.id);
      assert.ok(packet.t0_us >= previousT1Us, scenarioDefinition.id);
      previousT1Us = packet.t1_us;
      packet.n.forEach((count, sensorIndex) => { totals[sensorIndex] += count; });
    }
    assert.deepEqual(totals, [2_500, 1_000, 1_280, 1_000, 20], scenarioDefinition.id);
  }
});

test("the deterministic generator repeats exactly for the same context", () => {
  const scenario = getDemoScenario("corroborated_multimodal_change")!;
  const left = generateDemoAcceptedPacket(FIXED_CONTEXT, scenario, 901, 90_000, 90_000);
  const right = generateDemoAcceptedPacket(FIXED_CONTEXT, scenario, 901, 90_000, 90_000);
  assert.deepEqual(left, right);
});

test("each scenario runs through the real pipeline with clean visible outputs", { timeout: 120_000 }, async () => {
  const expected = {
    stable_baseline: { pattern: "No material change from session baseline observed", rule: "MM-08", tier: "moderate" },
    isolated_cardiovascular_change: { pattern: "Isolated cardiovascular change observed", rule: "MM-03", tier: "limited" },
    isolated_electrodermal_change: { pattern: "Isolated electrodermal change observed", rule: "MM-04", tier: "limited" },
    isolated_temperature_change: { pattern: "Isolated local skin-temperature change observed", rule: "MM-05", tier: "limited" },
    corroborated_multimodal_change: { pattern: "Multi-modality physiological change observed", rule: "MM-02", tier: "corroborated" },
  } as const;

  for (const scenario of DEMO_SCENARIOS) {
    const runtime = new DemoRuntime({
      visiblePacketDelayMs: 0,
      now: () => FIXED_CONTEXT.wall_start_ms,
      createId: idFactory(),
    });
    try {
      const session = runtime.startScenario(scenario.id);
      await waitForTerminal(runtime, session.session_id);
      const status = runtime.getStatus();
      const record = runtime.getSessionRecord(session.session_id);
      assert.ok(record);
      assert.equal(status.demo.phase, "COMPLETE", scenario.id);
      assert.equal(status.demo.validation_state, "passed", scenario.id);
      assert.equal(record.analysis_results.length, 3, scenario.id);
      assert.equal(status.demo.baseline_ready, true, scenario.id);
      assert.equal(record.final_analysis?.session.duration_ms, DEMO_VISIBLE_DURATION_MS, scenario.id);
      assert.equal(record.final_analysis?.session.completed_window_count, 3, scenario.id);
      assert.equal(record.final_analysis?.baseline.collection_complete, true, scenario.id);
      assert.deepEqual(record.final_analysis?.baseline.ready_modalities, ["ecg", "ppg", "gsr", "imu", "temperature"], scenario.id);
      assert.deepEqual(record.final_analysis?.window_coverage.missing_windows, [], scenario.id);
      assert.deepEqual(record.final_analysis?.window_coverage.incomplete_tails, [], scenario.id);
      assert.deepEqual(record.final_analysis?.epoch_coverage[0], {
        epoch_id: record.epoch_id,
        first_sample_ms: 0,
        last_sample_ms: DEMO_VISIBLE_DURATION_MS,
      });
      assert.deepEqual(record.analysis_results.map((result) => result.window.start_ms), [0, 10_000, 20_000]);
      assert.ok(record.analysis_results.every((result) =>
        Object.values(result.modality_results).every((modality) => modality.quality.state === "good"),
      ));
      const firstResult = record.analysis_results[0];
      assert.equal(firstResult.baseline_ready, true, scenario.id);
      assert.deepEqual(
        Object.fromEntries(Object.entries(firstResult.modality_results).map(([modality, result]) => [
          modality,
          result.quality.sample_count,
        ])),
        { ecg: 2_500, ppg: 1_000, gsr: 1_280, imu: 1_000, temperature: 20 },
        scenario.id,
      );
      if (!["isolated_cardiovascular_change", "corroborated_multimodal_change"].includes(scenario.id)) {
        assert.ok(Math.abs((firstResult.modality_results.ecg.features.heart_rate_bpm ?? 0) - 75) < 1, scenario.id);
        assert.ok(Math.abs((firstResult.modality_results.ppg.features.pulse_rate_bpm ?? 0) - 75) < 1, scenario.id);
      }
      assert.equal(firstResult.modality_results.imu.features.movement_level, "low", scenario.id);
      assert.ok(record.analysis_results.every((result) => result.multimodal_result.pattern === expected[scenario.id].pattern));
      assert.ok(record.analysis_results.every((result) => result.multimodal_result.rule_ids.includes(expected[scenario.id].rule)));
      assert.ok(record.analysis_results.every((result) => result.multimodal_result.evidence_tier === expected[scenario.id].tier));
      assert.equal(JSON.stringify(record.analysis_results).includes("MM-07"), false, scenario.id);
      assert.equal(JSON.stringify(record.analysis_results).includes("Insufficient evidence"), false, scenario.id);
      if (scenario.id === "isolated_cardiovascular_change") {
        const ecgBaseline = firstResult.baseline.modality_states.ecg.features.heart_rate_bpm.median!;
        const ppgBaseline = firstResult.baseline.modality_states.ppg.features.pulse_rate_bpm.median!;
        assert.ok(firstResult.modality_results.ecg.features.heart_rate_bpm! > ecgBaseline * 1.15);
        assert.ok(firstResult.modality_results.ppg.features.pulse_rate_bpm! > ppgBaseline * 1.15);
        assert.ok(Math.abs(firstResult.modality_results.ecg.features.heart_rate_bpm! - firstResult.modality_results.ppg.features.pulse_rate_bpm!) < 10);
        assert.equal(record.analysis_results.some((result) => result.multimodal_result.rule_ids.includes("PPG-02")), false);
        assert.equal(record.analysis_results.some((result) =>
          result.modality_results.ppg.rule_evaluations.some((rule) => rule.rule_id === "PPG-02" && rule.status === "fired"),
        ), false);
      }
      if (scenario.id === "isolated_electrodermal_change") {
        assert.ok(firstResult.modality_results.gsr.features.gsr_robust_z! >= 2);
        assert.ok(firstResult.modality_results.gsr.features.gsr_raw_slope_raw_per_s! > 0);
        assert.ok(record.analysis_results.every((result) => result.modality_results.gsr.quality.state === "good"));
      }
      if (scenario.id === "isolated_temperature_change") {
        assert.ok(Math.abs(firstResult.modality_results.temperature.features.temperature_delta_c!) >= 0.5);
        assert.ok(record.analysis_results.every((result) => result.modality_results.temperature.rule_evaluations.some((rule) => rule.rule_id === "TEMP-01" && rule.status === "fired")));
      }
      if (scenario.id === "corroborated_multimodal_change") {
        assert.ok(record.analysis_results.every((result) =>
          result.multimodal_result.supporting_modalities.includes("ecg") &&
          result.multimodal_result.supporting_modalities.includes("ppg") &&
          result.multimodal_result.supporting_modalities.includes("gsr"),
        ));
      }
      assert.equal(status.storage.persisted_packets, 0);
      assert.equal(status.storage.queue_depth, 0);
      assert.equal(record.packets.length, 300);
      assert.ok(record.analysis_results[0].source.first_packet_seq! > 1);
    } finally {
      runtime.close();
    }
  }
});

test("demo HTTP routes and assets are isolated from the production prefixes", async () => {
  const runtime = new DemoRuntime({ visiblePacketDelayMs: 0 });
  try {
    const scenariosResponse = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(
      request("GET", "/api/objective/demo/scenarios"),
      scenariosResponse,
      { runtime },
    ), true);
    assert.equal(scenariosResponse.statusCode, 200);
    assert.equal((scenariosResponse.body as { scenarios: unknown[] }).scenarios.length, 5);

    const startResponse = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(
      request("POST", "/api/objective/demo/start", { scenario_id: "stable_baseline" }),
      startResponse,
      { runtime },
    ), true);
    assert.equal(startResponse.statusCode, 202);
    const sessionId = (startResponse.body as { session: { session_id: string } }).session.session_id;

    const statusResponse = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(
      request("GET", "/api/objective/demo/status"),
      statusResponse,
      { runtime },
    ), true);
    assert.equal((statusResponse.body as { configured_device_id: string }).configured_device_id, "DEMO-ESP32");

    const sessionsResponse = responseCapture();
    await handleObjectiveDemoRequest(request("GET", "/api/objective/demo/sessions"), sessionsResponse, { runtime });
    assert.ok((sessionsResponse.body as { sessions: Array<{ session_id: string }> }).sessions.some((session) => session.session_id === sessionId));

    await waitForTerminal(runtime, sessionId);
    const replayResponse = responseCapture();
    await handleObjectiveDemoRequest(
      request("GET", `/api/objective/demo/sessions/${encodeURIComponent(sessionId)}/replay`),
      replayResponse,
      { runtime },
    );
    assert.equal((replayResponse.body as { timeline: { packet_count: number } }).timeline.packet_count, 300);
    const packetsResponse = responseCapture();
    await handleObjectiveDemoRequest(
      request("GET", `/api/objective/demo/sessions/${encodeURIComponent(sessionId)}/replay/packets?from_ms=0&duration_ms=1000`),
      packetsResponse,
      { runtime },
    );
    assert.equal((packetsResponse.body as { packets: unknown[] }).packets.length, 10);
    const analysisResponse = responseCapture();
    await handleObjectiveDemoRequest(
      request("GET", `/api/objective/demo/sessions/${encodeURIComponent(sessionId)}/analysis?from_ms=0&duration_ms=30000`),
      analysisResponse,
      { runtime },
    );
    assert.equal((analysisResponse.body as { results: unknown[] }).results.length, 3);
    const finalResponse = responseCapture();
    await handleObjectiveDemoRequest(
      request("GET", `/api/objective/demo/sessions/${encodeURIComponent(sessionId)}/final-analysis`),
      finalResponse,
      { runtime },
    );
    assert.equal((finalResponse.body as { final_analysis: { state: string } }).final_analysis.state, "complete");

    const disabledResponse = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(
      request("GET", "/api/objective/demo/status"),
      disabledResponse,
      { runtime, enabled: false },
    ), false);
  } finally {
    runtime.close();
  }

  const htmlResponse = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(request("GET", "/clinician/objective/demo"), htmlResponse), true);
  assert.equal(htmlResponse.statusCode, 200);
  const disabledDashboardResponse = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(
    request("GET", "/clinician/objective/demo"),
    disabledDashboardResponse,
    { objectiveDemoEnabled: false },
  ), false);
});

test("the WebSocket router keeps demo live traffic on its separate path", () => {
  const server = new EventEmitter() as EventEmitter & { on: EventEmitter["on"]; off: EventEmitter["off"] };
  const calls: string[] = [];
  const gateway = (name: string): LiveGateway => ({
    handleUpgrade: (_request, socket) => {
      calls.push(name);
      (socket as { end: () => void }).end();
    },
    getSnapshot: () => ({ connectedClients: 0, deliveredPackets: 0, droppedPackets: 0 }),
    close: () => undefined,
  });
  const deviceGateway = {
    handleUpgrade: () => calls.push("device"),
  } as unknown as DeviceGateway;
  const router = attachObjectiveWebSocketRouter(server as never, {
    deviceGateway,
    liveGateway: gateway("live"),
    demoLiveGateway: gateway("demo"),
  });
  const fakeSocket = { end: () => undefined };
  server.emit("upgrade", { url: "/ws/objective/demo/live/demo-session" }, fakeSocket, Buffer.alloc(0));
  server.emit("upgrade", { url: "/ws/objective/live/live-session" }, fakeSocket, Buffer.alloc(0));
  assert.deepEqual(calls, ["demo", "live"]);
  router.close();
});

test("the shared frontend explicitly labels and configures the simulated view", async () => {
  const html = await readFile("public/objective/index.html", "utf8");
  const script = await readFile("public/objective/objective.js", "utf8");
  assert.match(html, /SIMULATED DEMONSTRATION/);
  assert.match(html, /Return to live monitoring/);
  assert.match(script, /\/api\/objective\/demo/);
  assert.match(script, /\/ws\/objective\/demo\/live/);
  assert.match(script, /Insufficient evidence for multimodal interpretation/);
});
