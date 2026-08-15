import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { AcceptedPacketBus, type AcceptedObjectivePacket } from "./acceptedPacketBus.js";
import { ObjectivePacketStore } from "./persistence/packetStore.js";
import type { SchemaV1Packet } from "./packetValidator.js";

function packet(sequence: number): AcceptedObjectivePacket {
  const rawPacket: SchemaV1Packet = {
    schema: 1,
    session_id: "00000000-0000-4000-8000-000000000001",
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
    session_id: rawPacket.session_id,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for packet store state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("packet persistence subscriber only enqueues synchronously and preserves raw packet", async () => {
  const bus = new AcceptedPacketBus();
  const calls: unknown[][] = [];
  const database = {
    query: async (_sql: string, values: unknown[]) => {
      calls.push(values);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;
  const store = new ObjectivePacketStore(bus, database, { retryDelayMs: 0 });
  const accepted = packet(7);

  bus.publish(accepted);
  assert.equal(calls.length, 0);
  assert.equal(store.getSnapshot().queueDepth, 1);

  await waitUntil(() => store.getSnapshot().persistedPackets === 1);
  assert.strictEqual(calls[0][10], accepted.raw_packet);
  assert.deepEqual(store.getSnapshot(), {
    queueDepth: 0,
    persistedPackets: 1,
    storageErrors: 0,
    storageDrops: 0,
    suppressedDuplicates: 0,
    storageHealthy: true,
    degraded: false,
  });
  store.close();
});

test("packet persistence retains failures for retry and bounds queued storage", async () => {
  const bus = new AcceptedPacketBus();
  let attempts = 0;
  let allowSuccess = false;
  const database = {
    query: async () => {
      attempts += 1;
      if (!allowSuccess) {
        throw new Error("database unavailable");
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;
  const store = new ObjectivePacketStore(bus, database, { queueCapacity: 2, retryDelayMs: 1 });

  bus.publish(packet(1));
  bus.publish(packet(2));
  bus.publish(packet(3));
  assert.equal(store.getSnapshot().queueDepth, 2);
  assert.equal(store.getSnapshot().storageDrops, 1);
  assert.equal(store.getSnapshot().degraded, true);

  await waitUntil(() => attempts > 0);
  assert.equal(store.getSnapshot().queueDepth, 2);
  assert.ok(store.getSnapshot().storageErrors > 0);

  allowSuccess = true;
  await waitUntil(() => store.getSnapshot().persistedPackets === 2);
  assert.equal(store.getSnapshot().queueDepth, 0);
  assert.equal(store.getSnapshot().storageDrops, 1);
  assert.equal(store.getSnapshot().storageHealthy, true);
  store.close();
});
