import assert from "node:assert/strict";
import test from "node:test";

import { expandAcceptedPacket } from "./analysis/converters.js";
import { acceptedPacket } from "./analysisTestHelpers.js";

test("expands raw packet samples onto the canonical ESP timestamp domain", () => {
  const packet = acceptedPacket({
    t0Us: 1_000_000,
    plotT0Ms: 25,
    ecg: [[4_000, 2048, 0, 1]],
    ppg: [[8_000, 100, 200]],
    gsr: [[12_000, -7]],
    imu: [[16_000, 16_384, 0, 16_384, 131, 0, -131]],
    temp: [[20_000, 128]],
  });

  const expanded = expandAcceptedPacket(packet);
  assert.deepEqual(expanded.ecg[0], {
    sessionId: packet.session_id,
    bootId: packet.boot_id,
    epochId: packet.epoch_id,
    packetSeq: packet.raw_packet.seq,
    sampleTimeUs: 1_004_000,
    sampleTimeMs: 29,
    modality: "ecg",
    adc: 2048,
    loPlus: 0,
    loMinus: 1,
  });
  assert.equal(expanded.ppg[0].red, 100);
  assert.equal(expanded.ppg[0].ir, 200);
  assert.equal(expanded.gsr[0].raw, -7);
  assert.deepEqual(
    [expanded.imu[0].axG, expanded.imu[0].azG, expanded.imu[0].gxDps, expanded.imu[0].gzDps],
    [1, 1, 1, -1],
  );
  assert.equal(expanded.temperature[0].temperatureC, 1);
  assert.deepEqual(packet.raw_packet.ecg[0], [4_000, 2048, 0, 1]);
});
