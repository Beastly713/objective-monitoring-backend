import assert from "node:assert/strict";
import test from "node:test";

import { validateSchemaV1Packet } from "./packetValidator.js";

function validPacket(): Record<string, unknown> {
  return {
    schema: 1,
    session_id: "session-a",
    seq: 42,
    timebase: "esp_timer_us",
    created_us: 200_000,
    t0_us: 100_000,
    t1_us: 200_000,
    truncated: 0,
    n: [2, 1, 1, 1, 1],
    ecg: [
      [0, 2048, 0, 0],
      [100_000, 2049, 1, 0],
    ],
    ppg: [[10, 123_456, 234_567]],
    gsr: [[20, 3200]],
    imu: [[30, -1, 2, -3, 4, -5, 6]],
    temp: [[40, -120]],
  };
}

test("accepts the established raw Schema V1 representation without replacing it", () => {
  const packet = validPacket();
  const result = validateSchemaV1Packet(packet);

  assert.equal(result.valid, true);
  if (result.valid) {
    assert.strictEqual(result.packet, packet);
  }
});

test("accepts truncated packets and equal adjacent dt_us values", () => {
  const packet = validPacket();
  packet.truncated = 1;
  packet.ecg = [
    [10, 100, 0, 0],
    [10, 101, 0, 0],
  ];

  assert.equal(validateSchemaV1Packet(packet).valid, true);
});

test("rejects invalid envelope and timestamp fields", () => {
  const cases: Array<[string, unknown]> = [
    ["empty session", { ...validPacket(), session_id: " " }],
    ["negative sequence", { ...validPacket(), seq: -1 }],
    ["large sequence", { ...validPacket(), seq: 0x1_0000_0000 }],
    ["wrong timebase", { ...validPacket(), timebase: "unix_us" }],
    ["unsafe timestamp", { ...validPacket(), created_us: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative timestamp", { ...validPacket(), t0_us: -1 }],
    ["timestamp ordering", { ...validPacket(), t0_us: 200_001 }],
    ["packet span", { ...validPacket(), t0_us: 0, t1_us: 150_001, created_us: 150_001 }],
    ["truncated value", { ...validPacket(), truncated: false }],
  ];

  for (const [name, packet] of cases) {
    assert.equal(validateSchemaV1Packet(packet).valid, false, name);
  }
});

test("rejects count, capacity, tuple, numeric, dt_us bound, and ordering violations", () => {
  const countMismatch = validPacket();
  countMismatch.n = [1, 1, 1, 1, 1];

  const tooManyEcg = validPacket();
  tooManyEcg.ecg = Array.from({ length: 65 }, () => [0, 1, 0, 0]);
  tooManyEcg.n = [65, 1, 1, 1, 1];

  const badTuple = validPacket();
  badTuple.imu = [[0, 1, 2]];

  const badPpgCount = validPacket();
  badPpgCount.ppg = [[0, -1, 2]];

  const badLeadOff = validPacket();
  badLeadOff.ecg = [[0, 1, 2, 0]];
  badLeadOff.n = [1, 1, 1, 1, 1];

  const dtOutsideSpan = validPacket();
  dtOutsideSpan.temp = [[100_001, 1]];

  const backwards = validPacket();
  backwards.ecg = [
    [20, 1, 0, 0],
    [10, 1, 0, 0],
  ];

  for (const packet of [countMismatch, tooManyEcg, badTuple, badPpgCount, badLeadOff, dtOutsideSpan, backwards]) {
    assert.equal(validateSchemaV1Packet(packet).valid, false);
  }
});
