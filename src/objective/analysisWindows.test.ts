import assert from "node:assert/strict";
import test from "node:test";

import { acceptedPacket } from "./analysisTestHelpers.js";
import { AnalysisWindowEngine, SampleBuffer } from "./analysis/windows.js";

test("sample buffer preserves monotonic order, uses half-open ranges, and prunes by head", () => {
  const buffer = new SampleBuffer<{ sampleTimeMs: number; value: string }>();
  assert.equal(buffer.append({ sampleTimeMs: 0, value: "a" }), true);
  assert.equal(buffer.append({ sampleTimeMs: 1, value: "b" }), true);
  assert.equal(buffer.append({ sampleTimeMs: 0.5, value: "out-of-order" }), false);
  assert.deepEqual(buffer.range(0, 1), [{ sampleTimeMs: 0, value: "a" }]);
  buffer.pruneBefore(1);
  assert.deepEqual(buffer.range(0, 2), [{ sampleTimeMs: 1, value: "b" }]);
});

test("window scheduler emits complete non-overlapping 10 second windows", () => {
  const engine = new AnalysisWindowEngine();
  const first = acceptedPacket({
    seq: 1,
    ecg: [[0, 1000, 0, 0]],
  });
  const second = acceptedPacket({
    seq: 2,
    t0Us: 13_300_000,
    plotT0Ms: 12_300,
    ecg: [[0, 1001, 0, 0]],
  });

  assert.deepEqual(engine.ingestPacket(first), []);
  const windows = engine.ingestPacket(second);
  assert.deepEqual(windows.map((window) => [window.window.start_ms, window.window.end_ms]), [[0, 10_000]]);
  assert.equal(windows[0].window.start_us, 1_000_000);
  assert.equal(windows[0].window.end_us, 11_000_000);
  assert.equal(windows[0].samples.ecg.length, 1);
  assert.equal(engine.getNextWindowEndMs(), 20_000);
});

test("a sample exactly at the first window end is excluded then included in the next window", () => {
  const engine = new AnalysisWindowEngine();
  engine.ingestPacket(acceptedPacket({ seq: 1, ecg: [[0, 1000, 0, 0]] }));
  const windows = engine.ingestPacket(acceptedPacket({
    seq: 2,
    t0Us: 11_000_000,
    plotT0Ms: 10_000,
    ecg: [[0, 2000, 0, 0]],
  }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].samples.ecg.some((sample) => sample.adc === 2000), false);

  const next = engine.ingestPacket(acceptedPacket({
    seq: 3,
    t0Us: 21_000_000,
    plotT0Ms: 20_000,
    ecg: [[0, 2001, 0, 0]],
  }));
  assert.equal(next[0].window.start_ms, 10_000);
  assert.equal(next[0].samples.ecg.some((sample) => sample.adc === 2000), true);
});

test("window metadata records packet gaps, sample gaps, and out-of-order samples", () => {
  const engine = new AnalysisWindowEngine();
  engine.ingestPacket(acceptedPacket({ seq: 1, ecg: [[0, 1000, 0, 0]] }));
  engine.ingestPacket(acceptedPacket({
    seq: 2,
    plotT0Ms: 0.1,
    t0Us: 1_000_100,
    ecg: [[0, 1001, 0, 0]],
  }));
  const windows = engine.ingestPacket(acceptedPacket({
    seq: 4,
    sequenceStatus: "gap",
    gapBefore: 1,
    plotT0Ms: 12_300,
    t0Us: 13_300_000,
    ecg: [[0, 1002, 0, 0]],
  }));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].metadata.packetGapEvents.length, 1);
  assert.equal(windows[0].metadata.sampleGapEvents.some((event) => event.modality === "ecg"), true);

  const outOfOrderEngine = new AnalysisWindowEngine();
  outOfOrderEngine.ingestPacket(acceptedPacket({ seq: 1, ecg: [[0, 1000, 0, 0]] }));
  outOfOrderEngine.ingestPacket(acceptedPacket({
    seq: 2,
    plotT0Ms: 0.1,
    t0Us: 1_000_100,
    ecg: [[0, 1001, 0, 0]],
  }));
  outOfOrderEngine.ingestPacket(acceptedPacket({
    seq: 3,
    plotT0Ms: 0.05,
    t0Us: 1_000_050,
    ecg: [[0, 1002, 0, 0]],
  }));
  const outOfOrderWindows = outOfOrderEngine.ingestPacket(acceptedPacket({
    seq: 4,
    plotT0Ms: 10_000,
    t0Us: 11_000_000,
    ecg: [[0, 1003, 0, 0]],
  }));
  assert.equal(outOfOrderWindows.length, 1);
  assert.equal(outOfOrderWindows[0].metadata.discardedOutOfOrderSamples.length, 1);
  assert.equal(outOfOrderWindows[0].samples.ecg.length, 2);
});

test("1,055 packets spanning 105 seconds produce ten complete windows and a five second tail", () => {
  const engine = new AnalysisWindowEngine();
  const windows = [];
  const packetCount = 1_055;
  for (let index = 0; index < packetCount; index += 1) {
    const timeMs = index * 105_000 / (packetCount - 1);
    windows.push(...engine.ingestPacket(acceptedPacket({
      seq: index + 1,
      plotT0Ms: timeMs,
      t0Us: 1_000_000 + Math.round(timeMs * 1_000),
      ecg: [[0, 1_000, 0, 0]],
    })));
  }
  assert.equal(windows.length, 10);
  assert.deepEqual(windows.map((window) => [window.window.start_ms, window.window.end_ms]), [
    [0, 10_000],
    [10_000, 20_000],
    [20_000, 30_000],
    [30_000, 40_000],
    [40_000, 50_000],
    [50_000, 60_000],
    [60_000, 70_000],
    [70_000, 80_000],
    [80_000, 90_000],
    [90_000, 100_000],
  ]);
  assert.deepEqual(engine.getIncompleteTail(), {
    session_id: windows[0].sessionId,
    epoch_id: windows[0].epochId,
    start_ms: 100_000,
    end_ms: 105_000,
    duration_ms: 5_000,
  });
});

test("epoch transition discards a partial prior window and starts a fresh grid", () => {
  const engine = new AnalysisWindowEngine();
  engine.ingestPacket(acceptedPacket({ seq: 1, plotT0Ms: 5_000, ecg: [[0, 1000, 0, 0]] }));
  const windows = engine.ingestPacket(acceptedPacket({
    seq: 1,
    epochId: "00000000-0000-4000-8000-000000000003",
    plotT0Ms: 0,
    t0Us: 2_000_000,
    ecg: [[0, 1001, 0, 0]],
  }));
  assert.deepEqual(windows, []);
  assert.equal(engine.getNextWindowEndMs(), 10_000);
});
