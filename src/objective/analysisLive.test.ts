import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { AcceptedPacketBus } from "./acceptedPacketBus.js";
import { AnalysisResultBus } from "./analysis/resultBus.js";
import type { AnalysisResult } from "./analysis/types.js";
import { createObjectiveLiveGateway } from "./live/liveGateway.js";
import { attachObjectiveWebSocketRouter } from "./objectiveWebSocketRouter.js";
import type { DeviceGateway } from "./deviceGateway.js";
import { acceptedPacket } from "./analysisTestHelpers.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for analysis live message");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
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

function analysisResult(sessionId: string): AnalysisResult {
  return {
    type: "analysis_update",
    session_id: sessionId,
    device_id: "device-a",
    boot_id: "boot-a",
    epoch_id: "00000000-0000-4000-8000-000000000002",
    analysis_version: "analysis-1.0",
    conversion_version: "conversion-1.0",
    feature_version: "feature-1.0",
    rule_version: "rules-1.0",
    created_at_ms: 5_000,
    window: {
      start_us: 1_000_000,
      end_us: 11_000_000,
      start_ms: 0,
      end_ms: 10_000,
      duration_ms: 10_000,
    },
    source: {} as AnalysisResult["source"],
    baseline_ready: false,
    baseline: {} as AnalysisResult["baseline"],
    modality_results: {} as AnalysisResult["modality_results"],
    multimodal_result: {} as AnalysisResult["multimodal_result"],
    rules_triggered: [],
  };
}

test("the existing live WebSocket delivers analysis_update on the shared session channel", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const liveGateway = createObjectiveLiveGateway(packetBus, resultBus);
  const server = createServer();
  const router = attachObjectiveWebSocketRouter(server, {
    deviceGateway: deviceGateway(),
    liveGateway,
  });
  const port = await listen(server);
  const webSocket = new WebSocket(
    "ws://127.0.0.1:" + port + "/ws/objective/live/session-a",
  );
  const messages: unknown[] = [];
  webSocket.on("message", (data) => messages.push(JSON.parse(data.toString())));

  try {
    await once(webSocket, "open");
    await waitUntil(() => messages.length === 1);
    resultBus.publish(analysisResult("session-a"));
    await waitUntil(() => messages.length === 2);
    assert.deepEqual(messages[1], {
      type: "analysis_update",
      result: analysisResult("session-a"),
    });
    assert.equal(liveGateway.getSnapshot().deliveredAnalysis, 1);
  } finally {
    webSocket.close();
    await once(webSocket, "close");
    router.close();
    liveGateway.close();
    await closeServer(server);
  }
});
