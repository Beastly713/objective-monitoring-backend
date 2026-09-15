import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";

import WebSocket from "ws";

import { handleObjectiveDashboardRequest } from "./dashboard/dashboardRoutes.js";
import { DEMO_SCENARIOS, getDemoScenario } from "./demo/demoCatalog.js";
import { handleObjectiveDemoRequest } from "./demo/demoRoutes.js";
import { DemoRuntime } from "./demo/demoRuntime.js";
import {
  generateDemoAcceptedPacket,
  generateDemoRawPacket,
} from "./demo/demoSignalGenerator.js";
import {
  DEMO_BASELINE_DURATION_MS,
  DEMO_PACKET_PERIOD_MS,
  DEMO_VISIBLE_DURATION_MS,
} from "./demo/demoTypes.js";
import type { AnalysisModality, AnalysisResult } from "./analysis/types.js";
import type { DeviceGateway } from "./deviceGateway.js";
import type { LiveGateway } from "./live/liveGateway.js";
import { attachObjectiveWebSocketRouter } from "./objectiveWebSocketRouter.js";
import { validateSchemaV1Packet } from "./packetValidator.js";

const FIXED_CONTEXT = {
  session_id: "00000000-0000-4000-8000-000000000001",
  boot_id: "00000000-0000-4000-8000-000000000002",
  epoch_id: "00000000-0000-4000-8000-000000000003",
  wall_start_ms: 1_700_000_000_000,
};

function responseCapture(): ServerResponseCapture {
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
  return capture as unknown as ServerResponseCapture;
}

type ServerResponseCapture = import("node:http").ServerResponse & {
  statusCode: number;
  body: unknown;
};

function request(method: string, url: string, body?: unknown): import("node:http").IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(stream, { method, url });
  return stream as unknown as import("node:http").IncomingMessage;
}

function idFactory(): () => string {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for demonstration state");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

async function waitForTerminal(runtime: DemoRuntime): Promise<void> {
  await waitUntil(() => ["COMPLETE", "ERROR"].includes(runtime.getStatus().phase));
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function closeWebSocket(webSocket: WebSocket): Promise<void> {
  if (webSocket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    webSocket.once("close", () => resolve());
    webSocket.close();
  });
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain in the demo script`);
  const nextFunction = source.indexOf("\n  function ", start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

function deviceGateway(): DeviceGateway {
  return {
    handleUpgrade: (_request, socket) => socket.end(),
    getSnapshot: () => ({
      connectedClients: 0,
      authenticatedDevices: 0,
      acceptedPackets: 0,
      invalidPackets: 0,
      receivedBytes: 0,
      latestSequence: null,
      sequenceGaps: 0,
      duplicatePackets: 0,
      acknowledgements: 0,
      reconnects: 0,
    }),
    close: () => undefined,
  };
}

function gateway(name: string, calls: string[]): LiveGateway {
  return {
    handleUpgrade: (_request, socket) => {
      calls.push(name);
      socket.end();
    },
    getSnapshot: () => ({ connectedClients: 0, deliveredPackets: 0, droppedPackets: 0 }),
    close: () => undefined,
  };
}

function firedRuleIds(result: AnalysisResult): string[] {
  const ids = new Set(result.rules_triggered);
  result.multimodal_result.rule_ids.forEach((ruleId) => ids.add(ruleId));
  for (const modality of ["ecg", "ppg", "gsr", "imu", "temperature"] as const) {
    for (const rule of result.modality_results[modality].rule_evaluations) {
      if (rule.status === "fired") ids.add(rule.rule_id);
    }
  }
  return [...ids];
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
  assert.equal(DEMO_SCENARIOS[0].expected_pattern, "No material change from session baseline observed");
  assert.deepEqual(DEMO_SCENARIOS[1].expected_rule_ids, ["ECG-01", "PPG-01", "MM-03"]);
  assert.deepEqual(DEMO_SCENARIOS[4].expected_rule_ids, ["ECG-01", "PPG-01", "GSR-01", "MM-02"]);
});

test("demo packets are valid Schema V1 packets at the requested raw sample rates", () => {
  const scenario = getDemoScenario("stable_baseline")!;
  const first = generateDemoRawPacket(FIXED_CONTEXT, scenario, 1, 0, DEMO_BASELINE_DURATION_MS);
  assert.equal(validateSchemaV1Packet(first).valid, true);
  assert.deepEqual(first.n, [25, 10, 13, 10, 1]);
  assert.equal(first.t1_us - first.t0_us, DEMO_PACKET_PERIOD_MS * 1_000);
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
      assert.equal(validateSchemaV1Packet(packet).valid, true, scenarioDefinition.id);
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

test("preparation is isolated, waits for a five-modality baseline, and publishes no visible packet", async () => {
  const runtime = new DemoRuntime({
    visiblePacketDelayMs: 0,
    now: () => FIXED_CONTEXT.wall_start_ms,
    createId: idFactory(),
  });
  let visiblePackets = 0;
  const unsubscribe = runtime.packetBus.subscribe(() => { visiblePackets += 1; });
  try {
    const prepared = await runtime.prepareScenario("stable_baseline");
    assert.equal(prepared.phase, "READY");
    assert.equal(prepared.visible_packet_count, 0);
    assert.equal(visiblePackets, 0);
    assert.equal(prepared.baseline_ready, true);
    assert.deepEqual(prepared.baseline_ready_modalities, ["ecg", "ppg", "gsr", "imu", "temperature"]);

    runtime.startVisibleRun(prepared.session_id!);
    assert.ok(visiblePackets > 0);
    await waitForTerminal(runtime);
    assert.equal(runtime.getStatus().phase, "COMPLETE");
    assert.equal(visiblePackets, 300);
  } finally {
    unsubscribe();
    runtime.close();
  }
});

test("each scenario runs through the real pipeline with its actual visible contract", { timeout: 180_000 }, async () => {
  const expected = {
    stable_baseline: { pattern: "No material change from session baseline observed", rules: ["MM-08"], tier: "moderate" },
    isolated_cardiovascular_change: { pattern: "Isolated cardiovascular change observed", rules: ["ECG-01", "PPG-01", "MM-03"], tier: "limited" },
    isolated_electrodermal_change: { pattern: "Isolated electrodermal change observed", rules: ["GSR-01", "MM-04"], tier: "limited" },
    isolated_temperature_change: { pattern: "Isolated local skin-temperature change observed", rules: ["TEMP-01", "MM-05"], tier: "limited" },
    corroborated_multimodal_change: { pattern: "Multi-modality physiological change observed", rules: ["ECG-01", "PPG-01", "GSR-01", "MM-02"], tier: "corroborated" },
  } as const;

  for (const scenario of DEMO_SCENARIOS) {
    const runtime = new DemoRuntime({
      visiblePacketDelayMs: 0,
      now: () => FIXED_CONTEXT.wall_start_ms,
      createId: idFactory(),
    });
    try {
      const prepared = await runtime.prepareScenario(scenario.id);
      assert.equal(prepared.phase, "READY", scenario.id);
      assert.equal(prepared.baseline_ready, true, scenario.id);
      runtime.startVisibleRun(prepared.session_id!);
      await waitForTerminal(runtime);
      const status = runtime.getStatus();
      const response = runtime.getResult(prepared.session_id!);
      assert.equal(status.phase, "COMPLETE", scenario.id);
      assert.equal(status.validation.state, "passed", scenario.id);
      assert.ok(response);
      assert.equal(response.completed_results.length, 3, scenario.id);
      assert.deepEqual(response.completed_results.map((result) => result.window.start_ms), [0, 10_000, 20_000], scenario.id);
      assert.deepEqual(response.completed_results.map((result) => result.window.end_ms), [10_000, 20_000, 30_000], scenario.id);
      assert.ok(response.completed_results.every((result) =>
        Object.values(result.modality_results).every((modality) => modality.quality.state === "good"),
      ), scenario.id);
      assert.equal(response.completed_results.some((result) =>
        result.multimodal_result.pattern === "Insufficient evidence for multimodal interpretation" ||
        result.multimodal_result.rule_ids.includes("MM-07"),
      ), false, scenario.id);
      assert.equal(response.completed_results.some((result) =>
        result.multimodal_result.rule_ids.includes("PPG-02") ||
        result.modality_results.ppg.rule_evaluations.some((rule) => rule.rule_id === "PPG-02" && rule.status === "fired"),
      ), false, scenario.id);
      assert.ok(response.completed_results.every((result) => result.multimodal_result.pattern === expected[scenario.id].pattern), scenario.id);
      assert.ok(response.completed_results.every((result) => result.multimodal_result.evidence_tier === expected[scenario.id].tier), scenario.id);
      const actualRules = new Set(response.completed_results.flatMap(firedRuleIds));
      for (const ruleId of expected[scenario.id].rules) assert.equal(actualRules.has(ruleId), true, `${scenario.id} ${ruleId}`);

      const first = response.completed_results[0];
      assert.deepEqual(
        Object.fromEntries(Object.entries(first.modality_results).map(([modality, result]) => [modality, result.quality.sample_count])),
        { ecg: 2_500, ppg: 1_000, gsr: 1_280, imu: 1_000, temperature: 20 },
        scenario.id,
      );
      if (!["isolated_cardiovascular_change", "corroborated_multimodal_change"].includes(scenario.id)) {
        assert.ok(Math.abs((first.modality_results.ecg.features.heart_rate_bpm ?? 0) - 75) < 1, scenario.id);
        assert.ok(Math.abs((first.modality_results.ppg.features.pulse_rate_bpm ?? 0) - 75) < 1, scenario.id);
      }
      assert.equal(first.modality_results.imu.features.movement_level, "low", scenario.id);
      if (scenario.id === "isolated_cardiovascular_change") {
        assert.ok(first.modality_results.ecg.features.heart_rate_bpm! > first.baseline.modality_states.ecg.features.heart_rate_bpm.median! * 1.15);
        assert.ok(first.modality_results.ppg.features.pulse_rate_bpm! > first.baseline.modality_states.ppg.features.pulse_rate_bpm.median! * 1.15);
        assert.ok(Math.abs(first.modality_results.ecg.features.heart_rate_bpm! - first.modality_results.ppg.features.pulse_rate_bpm!) < 10);
      }
      if (scenario.id === "isolated_electrodermal_change") {
        assert.ok(first.modality_results.gsr.features.gsr_robust_z! >= 2);
        assert.ok(first.modality_results.gsr.features.gsr_raw_slope_raw_per_s! > 0);
      }
      if (scenario.id === "isolated_temperature_change") {
        assert.ok(Math.abs(first.modality_results.temperature.features.temperature_delta_c!) >= 0.5);
      }
      if (scenario.id === "corroborated_multimodal_change") {
        const supporting = new Set(response.completed_results.flatMap((result) => result.multimodal_result.supporting_modalities));
        assert.deepEqual(([
          "ecg",
          "ppg",
          "gsr",
        ] as AnalysisModality[]).every((modality) => supporting.has(modality)), true);
      }

      assert.ok(response.final_analysis);
      assert.equal(response.final_analysis.session.duration_ms, 30_000, scenario.id);
      assert.equal(response.final_analysis.session.completed_window_count, 3, scenario.id);
      assert.deepEqual(response.final_analysis.window_coverage.missing_windows, [], scenario.id);
      assert.deepEqual(response.final_analysis.window_coverage.incomplete_tails, [], scenario.id);
      assert.deepEqual(response.final_analysis.baseline.ready_modalities, ["ecg", "ppg", "gsr", "imu", "temperature"], scenario.id);
    } finally {
      runtime.close();
    }
  }
});

test("demo HTTP API enforces the two-stage flow and removes replay/history routes", async () => {
  const runtime = new DemoRuntime({ visiblePacketDelayMs: 0 });
  try {
    const scenarios = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(request("GET", "/api/objective/demo/scenarios"), scenarios, { runtime }), true);
    assert.equal(scenarios.statusCode, 200);
    assert.equal((scenarios.body as { scenarios: unknown[] }).scenarios.length, 5);

    const unknown = responseCapture();
    await handleObjectiveDemoRequest(request("POST", "/api/objective/demo/start", { scenario_id: "unknown" }), unknown, { runtime });
    assert.equal(unknown.statusCode, 400);

    const start = responseCapture();
    await handleObjectiveDemoRequest(request("POST", "/api/objective/demo/start", { scenario_id: "stable_baseline" }), start, { runtime });
    assert.equal(start.statusCode, 200);
    const prepared = start.body as { session_id: string; phase: string; status: { baseline_ready: boolean } };
    assert.equal(prepared.phase, "READY");
    assert.equal(prepared.status.baseline_ready, true);

    const overlapping = responseCapture();
    await handleObjectiveDemoRequest(request("POST", "/api/objective/demo/start", { scenario_id: "stable_baseline" }), overlapping, { runtime });
    assert.equal(overlapping.statusCode, 409);

    const run = responseCapture();
    await handleObjectiveDemoRequest(request("POST", "/api/objective/demo/run", { session_id: prepared.session_id }), run, { runtime });
    assert.equal(run.statusCode, 202);
    const duplicate = responseCapture();
    await handleObjectiveDemoRequest(request("POST", "/api/objective/demo/run", { session_id: prepared.session_id }), duplicate, { runtime });
    assert.equal(duplicate.statusCode, 409);
    await waitForTerminal(runtime);

    const status = responseCapture();
    await handleObjectiveDemoRequest(request("GET", "/api/objective/demo/status"), status, { runtime });
    assert.equal(status.statusCode, 200);
    assert.equal("device" in (status.body as object), false);
    assert.equal("storage" in (status.body as object), false);
    assert.equal("session" in (status.body as object), false);

    const result = responseCapture();
    await handleObjectiveDemoRequest(request("GET", "/api/objective/demo/result"), result, { runtime });
    assert.equal(result.statusCode, 200);
    assert.equal((result.body as { final_analysis: unknown }).final_analysis !== null, true);

    for (const path of [
      "/api/objective/demo/sessions",
      `/api/objective/demo/sessions/${encodeURIComponent(prepared.session_id)}/replay`,
      `/api/objective/demo/sessions/${encodeURIComponent(prepared.session_id)}/analysis`,
    ]) {
      const removed = responseCapture();
      assert.equal(await handleObjectiveDemoRequest(request("GET", path), removed, { runtime }), false, path);
    }

    const disabled = responseCapture();
    assert.equal(await handleObjectiveDemoRequest(request("GET", "/api/objective/demo/status"), disabled, { runtime, enabled: false }), false);
  } finally {
    runtime.close();
  }
});

test("the real demo WebSocket receives ready, first rebased packets, and W1/W2/W3 updates", { timeout: 120_000 }, async () => {
  const runtime = new DemoRuntime({ visiblePacketDelayMs: 0, createId: idFactory() });
  const server = createServer((requestObject, response) => {
    void handleObjectiveDemoRequest(requestObject, response, { runtime }).catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : "route error");
    });
  });
  const router = attachObjectiveWebSocketRouter(server, {
    deviceGateway: deviceGateway(),
    liveGateway: gateway("production", []),
    demoLiveGateway: runtime.liveGateway,
  });
  const port = await listen(server);
  const prepared = await runtime.prepareScenario("stable_baseline");
  const messages: Array<Record<string, any>> = [];
  const webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/objective/demo/live/${encodeURIComponent(prepared.session_id!)}`);
  webSocket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, any>));

  try {
    await once(webSocket, "open");
    await waitUntil(() => messages.some((message) => message.type === "ready"));
    assert.deepEqual(messages.find((message) => message.type === "ready"), {
      type: "ready",
      session_id: prepared.session_id,
    });

    const runResponse = await fetch(`http://127.0.0.1:${port}/api/objective/demo/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: prepared.session_id }),
    });
    assert.equal(runResponse.status, 202);
    await waitUntil(() => messages.filter((message) => message.type === "analysis_update").length === 3);
    await waitForTerminal(runtime);

    const packetMessages = messages.filter((message) => message.type === "packet");
    assert.equal(packetMessages.length, 300);
    const firstPacket = packetMessages[0].packet;
    assert.equal(firstPacket.plot_t0_ms, 0);
    assert.ok(firstPacket.raw_packet.ecg.length > 0);
    assert.ok(firstPacket.raw_packet.ppg.length > 0);
    assert.ok(firstPacket.raw_packet.gsr.length > 0);
    assert.ok(firstPacket.raw_packet.imu.length > 0);
    assert.ok(firstPacket.raw_packet.temp.length > 0);
    const analysisMessages = messages
      .filter((message) => message.type === "analysis_update")
      .map((message) => message.result as AnalysisResult);
    assert.deepEqual(analysisMessages.map((result) => result.window.start_ms), [0, 10_000, 20_000]);
    assert.deepEqual(analysisMessages.map((result) => result.window.end_ms), [10_000, 20_000, 30_000]);
  } finally {
    await closeWebSocket(webSocket);
    router.close();
    runtime.close();
    await closeServer(server);
  }
});

test("demo and production WebSocket paths cannot fall through into one another", () => {
  const server = new EventEmitter() as unknown as Server;
  const calls: string[] = [];
  const router = attachObjectiveWebSocketRouter(server, {
    deviceGateway: {
      handleUpgrade: () => calls.push("device"),
    } as unknown as DeviceGateway,
    liveGateway: gateway("live", calls),
    demoLiveGateway: gateway("demo", calls),
  });
  const fakeSocket = { end: () => undefined } as unknown as import("node:stream").Duplex;
  server.emit("upgrade", { url: "/ws/objective/device" }, fakeSocket, Buffer.alloc(0));
  server.emit("upgrade", { url: "/ws/objective/live/live-session" }, fakeSocket, Buffer.alloc(0));
  server.emit("upgrade", { url: "/ws/objective/demo/live/demo-session" }, fakeSocket, Buffer.alloc(0));
  assert.deepEqual(calls, ["device", "live", "demo"]);
  router.close();
});

test("demo and production pages/assets are separate and the demo has no production workflow controls", async () => {
  const demoHtml = await readFile("public/objective/demo.html", "utf8");
  const productionHtml = await readFile("public/objective/index.html", "utf8");
  const productionScript = await readFile("public/objective/objective.js", "utf8");
  const demoScript = await readFile("public/objective/demo.js", "utf8");

  for (const text of ["SIMULATED DEMONSTRATION", "Back to live monitoring", "scenario-container", "completed-window-analysis", "latest-features", "final-scenario-summary"]) {
    assert.match(demoHtml, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const chartId of ["ecg-chart", "ppg-chart", "gsr-chart", "imu-chart", "temperature-chart"]) {
    assert.match(demoHtml, new RegExp(`id="${chartId}"`));
  }
  assert.match(demoHtml, /objective-assets\/demo\.js/);
  assert.doesNotMatch(demoHtml, /objective-assets\/objective\.js/);
  for (const forbidden of [
    />LIVE</,
    />REVIEW</,
    /Historical session/i,
    /replay-speed/i,
    /replay-seek/i,
    /Start monitoring/i,
    /Stop monitoring/i,
    /Persisted packets/i,
    /ACKs/i,
    /reconnects/i,
    /Storage queue/i,
  ]) assert.doesNotMatch(demoHtml, forbidden);

  assert.doesNotMatch(productionHtml, /demo-scenario-panel|demo-runtime-status|demo-validation-status|demo-stop-button/);
  assert.match(productionHtml, /href="\/clinician\/objective\/demo"[^>]*>Demonstration</);
  assert.doesNotMatch(productionScript, /DEMO_MODE|\/api\/objective\/demo|\/ws\/objective\/demo/);
  assert.match(demoScript, /plotT0Ms \+ sample\[0\] \/ 1_000/);
  assert.match(demoScript, /sample\[1\] \/ 16_384/);
  assert.match(demoScript, /sample\[1\] \* 0\.0078125/);
  assert.doesNotMatch(demoScript, /requestAnimationFrame/);
});

test("demo renderers own their empty states and tolerate repeated rendering", async () => {
  const demoHtml = await readFile("public/objective/demo.html", "utf8");
  const demoScript = await readFile("public/objective/demo.js", "utf8");
  const renderScenarios = extractFunction(demoScript, "renderScenarios");
  const renderWindows = extractFunction(demoScript, "renderWindows");

  assert.doesNotMatch(demoHtml, /id="scenario-empty"/);
  assert.doesNotMatch(demoHtml, /id="window-empty"/);
  assert.doesNotMatch(renderScenarios, /scenario-empty|empty\.hidden/);
  assert.doesNotMatch(renderWindows, /window-empty|empty\.hidden/);
  assert.match(renderScenarios, /container\.replaceChildren\(\)/);
  assert.match(renderScenarios, /state\.scenarios\.length === 0/);
  assert.match(renderScenarios, /document\.createElement\("p"\)/);
  assert.match(renderScenarios, /Loading scenarios…/);
  assert.match(renderWindows, /container\.replaceChildren\(\)/);
  assert.match(renderWindows, /rows\.length === 0/);
  assert.match(renderWindows, /document\.createElement\("p"\)/);
  assert.match(renderWindows, /No completed analysis windows yet\./);
  assert.doesNotMatch(
    `${renderScenarios}\n${renderWindows}`,
    /replaceChildren\(\)[\s\S]*?empty\.hidden/,
  );
});

test("dashboard routes serve the dedicated demo assets and respect the demo feature flag", async () => {
  const demoPage = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(request("GET", "/clinician/objective/demo"), demoPage), true);
  assert.equal(demoPage.statusCode, 200);
  assert.match(String(demoPage.body), /Simulated Demonstration/);

  const demoAsset = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(request("GET", "/objective-assets/demo.js"), demoAsset), true);
  assert.equal(demoAsset.statusCode, 200);
  assert.match(String(demoAsset.body), /API_BASE = "\/api\/objective\/demo"/);

  const productionPage = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(request("GET", "/clinician/objective"), productionPage), true);
  assert.match(String(productionPage.body), /Clinician monitoring/);

  const disabledPage = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(
    request("GET", "/clinician/objective/demo"),
    disabledPage,
    { objectiveDemoEnabled: false },
  ), false);
  const disabledAsset = responseCapture();
  assert.equal(await handleObjectiveDashboardRequest(
    request("GET", "/objective-assets/demo.js"),
    disabledAsset,
    { objectiveDemoEnabled: false },
  ), false);
});
