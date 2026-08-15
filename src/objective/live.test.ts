import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import { AcceptedPacketBus, type AcceptedObjectivePacket } from "./acceptedPacketBus.js";
import { createObjectiveDeviceGateway, type DeviceGateway } from "./deviceGateway.js";
import { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import { createObjectiveLiveGateway, type LiveGateway } from "./live/liveGateway.js";
import { attachObjectiveWebSocketRouter } from "./objectiveWebSocketRouter.js";
import type { ObjectivePacketStore } from "./persistence/packetStore.js";
import type { SchemaV1Packet } from "./packetValidator.js";
import { SequenceTracker } from "./sequenceTracker.js";
import { ObjectiveSessionManager } from "./sessionManager.js";
import { handleObjectiveStatusRequest } from "./statusRoutes.js";
import { ObjectiveTimeMapper } from "./timeMapper.js";

function acceptedPacket(sessionId: string, sequence: number): AcceptedObjectivePacket {
  const rawPacket: SchemaV1Packet = {
    schema: 1,
    session_id: sessionId,
    seq: sequence,
    timebase: "esp_timer_us",
    created_us: 1_100,
    t0_us: 1_000,
    t1_us: 1_100,
    truncated: 0,
    n: [0, 0, 0, 0, 0],
    ecg: [],
    ppg: [],
    gsr: [],
    imu: [],
    temp: [],
  };
  return {
    device_id: "device-a",
    boot_id: "boot-a",
    session_id: sessionId,
    received_at_ms: 5_000,
    sequence_status: "normal",
    gap_before: 0,
    epoch_id: "00000000-0000-4000-8000-000000000002",
    esp_anchor_us: 1_000,
    backend_anchor_ms: 5_000,
    plot_t0_ms: 0,
    raw_packet: rawPacket,
  };
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
  server.close();
  await once(server, "close");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for live WebSocket state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function connect(url: string): Promise<{ webSocket: WebSocket; messages: unknown[] }> {
  const webSocket = new WebSocket(url);
  const messages: unknown[] = [];
  webSocket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(webSocket, "open");
  await waitUntil(() => messages.length > 0);
  return { webSocket, messages };
}

async function closeWebSocket(webSocket: WebSocket): Promise<void> {
  webSocket.close();
  await once(webSocket, "close");
}

async function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const webSocket = new WebSocket(url);
    webSocket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    webSocket.once("error", reject);
  });
}

function rejectingDeviceGateway(onUpgrade: () => void): DeviceGateway {
  return {
    handleUpgrade: (_request, socket) => {
      onUpgrade();
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    },
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

test("the sole router dispatches device/live paths and live delivery stays session scoped", async () => {
  const bus = new AcceptedPacketBus();
  const liveGateway = createObjectiveLiveGateway(bus);
  let deviceUpgrades = 0;
  const deviceGateway = rejectingDeviceGateway(() => {
    deviceUpgrades += 1;
  });
  const server = createServer();
  const router = attachObjectiveWebSocketRouter(server, { deviceGateway, liveGateway });
  const port = await listen(server);

  try {
    assert.equal(server.listenerCount("upgrade"), 1);
    bus.publish(acceptedPacket("session-a", 1));

    const client = await connect(`ws://127.0.0.1:${port}/ws/objective/live/session-a`);
    assert.deepEqual(client.messages, [{ type: "ready", session_id: "session-a" }]);

    bus.publish(acceptedPacket("session-b", 2));
    const matchingPacket = acceptedPacket("session-a", 3);
    bus.publish(matchingPacket);
    await waitUntil(() => client.messages.length === 2);
    assert.deepEqual(client.messages[1], { type: "packet", packet: matchingPacket });
    assert.deepEqual(liveGateway.getSnapshot(), {
      connectedClients: 1,
      deliveredPackets: 1,
      droppedPackets: 0,
    });

    assert.equal(await rejectedUpgradeStatus(`ws://127.0.0.1:${port}/ws/objective/device`), 403);
    assert.equal(deviceUpgrades, 1);
    assert.equal(await rejectedUpgradeStatus(`ws://127.0.0.1:${port}/ws/unknown`), 404);
    await closeWebSocket(client.webSocket);
    assert.equal(liveGateway.getSnapshot().connectedClients, 0);
  } finally {
    router.close();
    liveGateway.close();
    await closeServer(server);
  }
});

test("a live client over the buffer threshold drops current frames without a queue", async () => {
  const bus = new AcceptedPacketBus();
  const liveGateway = createObjectiveLiveGateway(bus, { maxBufferedBytes: 0 });
  const server = createServer();
  const router = attachObjectiveWebSocketRouter(server, {
    deviceGateway: rejectingDeviceGateway(() => undefined),
    liveGateway,
  });
  const port = await listen(server);

  try {
    const client = await connect(`ws://127.0.0.1:${port}/ws/objective/live/session-a`);
    bus.publish(acceptedPacket("session-a", 1));
    assert.deepEqual(liveGateway.getSnapshot(), {
      connectedClients: 1,
      deliveredPackets: 0,
      droppedPackets: 1,
    });
    assert.equal(client.messages.length, 1);
    await closeWebSocket(client.webSocket);
  } finally {
    router.close();
    liveGateway.close();
    await closeServer(server);
  }
});

test("routed device upgrades preserve HELLO, READY, START, publish, and ACK behavior", async () => {
  const bus = new AcceptedPacketBus();
  const liveGateway = createObjectiveLiveGateway(bus);
  const deviceRegistry = new ObjectiveDeviceRegistry();
  const sessionManager = new ObjectiveSessionManager(new Set(["device-a"]));
  const session = sessionManager.registerSession({
    session_id: "00000000-0000-4000-8000-000000000001",
    device_id: "device-a",
    status: "WAITING",
    created_at_ms: 1,
    updated_at_ms: 1,
    completed_at_ms: null,
  });
  const deviceGateway = createObjectiveDeviceGateway({
    credential: { deviceId: "device-a", token: "test-token" },
    deviceRegistry,
    sessionManager,
    sequenceTracker: new SequenceTracker(),
    timeMapper: new ObjectiveTimeMapper(),
    acceptedPacketBus: bus,
  });
  const accepted: AcceptedObjectivePacket[] = [];
  bus.subscribe((packet) => accepted.push(packet));
  const server = createServer();
  const router = attachObjectiveWebSocketRouter(server, { deviceGateway, liveGateway });
  const port = await listen(server);
  const webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/objective/device`);
  const messages: string[] = [];
  webSocket.on("message", (data) => messages.push(data.toString()));

  try {
    await once(webSocket, "open");
    webSocket.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      device_id: "device-a",
      boot_id: "boot-a",
      firmware: "test",
      token: "test-token",
    }));
    await waitUntil(() => messages.length === 2);
    assert.deepEqual(messages, ["READY", `START:${session.session_id}`]);

    const rawPacket = acceptedPacket(session.session_id, 4).raw_packet;
    webSocket.send(JSON.stringify(rawPacket));
    await waitUntil(() => messages.includes("ACK:4"));
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0].raw_packet, rawPacket);

    webSocket.send(JSON.stringify(rawPacket));
    await waitUntil(() => messages.filter((message) => message === "ACK:4").length === 2);
    assert.equal(accepted.length, 1);
    assert.equal(deviceGateway.getSnapshot().duplicatePackets, 1);
    assert.equal(deviceGateway.getSnapshot().acknowledgements, 2);
  } finally {
    await closeWebSocket(webSocket);
    router.close();
    deviceGateway.close();
    liveGateway.close();
    await closeServer(server);
  }
});

test("status route composes existing snapshots without exposing secrets", async () => {
  const deviceRegistry = new ObjectiveDeviceRegistry();
  const sessionManager = new ObjectiveSessionManager(new Set(["device-a"]));
  sessionManager.registerSession({
    session_id: "00000000-0000-4000-8000-000000000001",
    device_id: "device-a",
    status: "WAITING",
    created_at_ms: 1,
    updated_at_ms: 1,
    completed_at_ms: null,
  });
  const deviceGateway = {
    getSnapshot: () => ({
      connectedClients: 1,
      authenticatedDevices: 1,
      acceptedPackets: 12,
      invalidPackets: 2,
      receivedBytes: 345,
      latestSequence: 9,
      sequenceGaps: 3,
      duplicatePackets: 4,
      acknowledgements: 11,
      reconnects: 5,
    }),
  } as DeviceGateway;
  const liveGateway = {
    getSnapshot: () => ({ connectedClients: 2, deliveredPackets: 8, droppedPackets: 1 }),
  } as LiveGateway;
  const packetStore = {
    getSnapshot: () => ({
      queueDepth: 6,
      persistedPackets: 7,
      storageErrors: 1,
      storageDrops: 2,
      suppressedDuplicates: 3,
      storageHealthy: false,
      degraded: true,
    }),
  } as ObjectivePacketStore;
  const server = createServer((request, response) => {
    if (
      !handleObjectiveStatusRequest(request, response, {
        configuredDeviceId: "device-a",
        deviceRegistry,
        deviceGateway,
        sessionManager,
        liveGateway,
        packetStore,
      })
    ) {
      response.writeHead(404).end();
    }
  });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/objective/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.configured_device_id, "device-a");
    assert.deepEqual(body.live, {
      connected_clients: 2,
      delivered_packets: 8,
      dropped_packets: 1,
    });
    assert.deepEqual(body.storage, {
      queue_depth: 6,
      persisted_packets: 7,
      storage_errors: 1,
      storage_drops: 2,
      suppressed_duplicates: 3,
      healthy: false,
      degraded: true,
    });
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /token|database_url|credential/i);
  } finally {
    await closeServer(server);
  }
});
