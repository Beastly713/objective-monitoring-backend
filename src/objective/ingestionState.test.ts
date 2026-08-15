import assert from "node:assert/strict";
import test from "node:test";

import { AcceptedPacketBus } from "./acceptedPacketBus.js";
import type { SchemaV1Packet } from "./packetValidator.js";
import { SequenceTracker } from "./sequenceTracker.js";
import {
  ActiveObjectiveSessionConflictError,
  ObjectiveSessionManager,
  UnknownObjectiveDeviceError,
} from "./sessionManager.js";
import { ObjectiveTimeMapper } from "./timeMapper.js";

test("preserves a monitoring session through disconnect and reconnect", () => {
  const sessions = new ObjectiveSessionManager(new Set(["device-a"]));
  const created = sessions.createSession("device-a", false);

  assert.equal(created.status, "WAITING");
  assert.equal(sessions.handleDeviceConnected("device-a")?.status, "LIVE");
  assert.equal(sessions.handleDeviceDisconnected("device-a")?.status, "DISCONNECTED");
  assert.equal(sessions.handleDeviceConnected("device-a")?.session_id, created.session_id);
  assert.equal(sessions.getSession(created.session_id)?.status, "LIVE");
  assert.throws(() => sessions.createSession("device-a", true), ActiveObjectiveSessionConflictError);

  const stopped = sessions.stopSession(created.session_id);
  assert.equal(stopped?.changed, true);
  assert.equal(stopped?.session.status, "COMPLETED");
  assert.equal(sessions.isRecentlyStoppedSessionPacket("device-a", created.session_id, Date.now()), true);
  assert.equal(
    sessions.isRecentlyStoppedSessionPacket("device-a", created.session_id, Date.now() + 5_001),
    false,
  );
  assert.equal(sessions.stopSession(created.session_id)?.changed, false);
  assert.notEqual(sessions.createSession("device-a", true).session_id, created.session_id);
  assert.throws(() => sessions.createSession("unknown", false), UnknownObjectiveDeviceError);
});

test("classifies forward progress per session and boot without advancing on duplicates", () => {
  const tracker = new SequenceTracker();

  assert.deepEqual(tracker.classify("session-a", "boot-a", 100), {
    status: "first",
    gapBefore: 0,
    shouldPublish: true,
  });
  assert.equal(tracker.classify("session-a", "boot-a", 101).status, "normal");
  assert.deepEqual(tracker.classify("session-a", "boot-a", 104), {
    status: "gap",
    gapBefore: 2,
    shouldPublish: true,
  });
  assert.equal(tracker.classify("session-a", "boot-a", 102).status, "duplicate_stale");
  assert.equal(tracker.classify("session-a", "boot-a", 105).status, "normal");
  assert.equal(tracker.classify("session-a", "boot-b", 0).status, "first");
});

test("creates stable per-boot time epochs and exposes the raw packet by reference", () => {
  const mapper = new ObjectiveTimeMapper();
  const first = mapper.map("session-a", "boot-a", 1_000_000, 5_000);
  const next = mapper.map("session-a", "boot-a", 1_050_000, 5_050);
  const reboot = mapper.map("session-a", "boot-b", 10_000, 6_000);

  assert.equal(first.plotT0Ms, 0);
  assert.equal(next.plotT0Ms, 50);
  assert.equal(next.epochId, first.epochId);
  assert.notEqual(reboot.epochId, first.epochId);

  const bus = new AcceptedPacketBus();
  const rawPacket = {} as SchemaV1Packet;
  let observedRawPacket: SchemaV1Packet | undefined;
  bus.subscribe((packet) => {
    observedRawPacket = packet.raw_packet;
  });
  bus.publish({
    device_id: "device-a",
    boot_id: "boot-a",
    session_id: "session-a",
    received_at_ms: 5_000,
    sequence_status: "first",
    gap_before: 0,
    epoch_id: first.epochId,
    esp_anchor_us: first.espAnchorUs,
    backend_anchor_ms: first.backendAnchorMs,
    plot_t0_ms: first.plotT0Ms,
    raw_packet: rawPacket,
  });

  assert.strictEqual(observedRawPacket, rawPacket);
});
