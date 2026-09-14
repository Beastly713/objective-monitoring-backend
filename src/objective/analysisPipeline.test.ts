import assert from "node:assert/strict";
import test from "node:test";

import { AcceptedPacketBus } from "./acceptedPacketBus.js";
import { AnalysisResultBus } from "./analysis/resultBus.js";
import { ObjectiveAnalysisPipeline, SerializedAnalysisQueue } from "./analysis/pipeline.js";
import type { AnalysisResult } from "./analysis/types.js";
import { acceptedPacket } from "./analysisTestHelpers.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for analysis pipeline state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("analysis pipeline emits complete deterministic results asynchronously", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const results: AnalysisResult[] = [];
  resultBus.subscribe((result) => results.push(result));
  const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);

  packetBus.publish(acceptedPacket({
    seq: 1,
    plotT0Ms: 0,
    t0Us: 1_000_000,
    ecg: [[0, 1_000, 0, 0]],
  }));
  assert.equal(results.length, 0);
  packetBus.publish(acceptedPacket({
    seq: 2,
    plotT0Ms: 10_000,
    t0Us: 10_999_000,
    ecg: [[0, 1_001, 0, 0]],
  }));

  await waitUntil(() => results.length === 1);
  assert.deepEqual([results[0].window.start_ms, results[0].window.end_ms], [0, 10_000]);
  assert.equal(results[0].type, "analysis_update");
  assert.equal(results[0].source.packet_count, 1);
  assert.equal(results[0].source.analysis_input_gap_count, 0);
  assert.equal(results[0].baseline_ready, false);
  assert.doesNotMatch(JSON.stringify(results[0]), /NaN|Infinity/);
  assert.deepEqual(pipeline.getSnapshot().lastWindow, {
    session_id: results[0].session_id,
    epoch_id: results[0].epoch_id,
    end_ms: 10_000,
  });
  assert.equal(pipeline.getSnapshot().windowsEmitted, 1);
  pipeline.close();
});

test("full analysis queue drops newest work and preserves an analysis-input gap", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const results: AnalysisResult[] = [];
  resultBus.subscribe((result) => results.push(result));
  const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus, { queueCapacity: 1 });

  packetBus.publish(acceptedPacket({
    seq: 1,
    plotT0Ms: 0,
    t0Us: 1_000_000,
    ecg: [[0, 1_000, 0, 0]],
  }));
  packetBus.publish(acceptedPacket({
    seq: 2,
    plotT0Ms: 5_000,
    t0Us: 6_000_000,
    ecg: [[0, 1_001, 0, 0]],
  }));
  assert.equal(pipeline.getSnapshot().queueDrops, 1);
  await waitUntil(() => pipeline.getSnapshot().queueDepth === 0);

  packetBus.publish(acceptedPacket({
    seq: 3,
    plotT0Ms: 10_000,
    t0Us: 10_999_000,
    ecg: [[0, 1_002, 0, 0]],
  }));
  await waitUntil(() => results.length === 1);
  assert.equal(results[0].source.analysis_input_gap_count, 1);
  assert.equal(pipeline.getSnapshot().queueDrops, 1);
  assert.equal(pipeline.getSnapshot().pipelineHealthy, true);
  pipeline.close();
});

test("session stop drains admitted packets and rejects later deliveries", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);
  const sessionId = "00000000-0000-4000-8000-000000000001";

  for (let sequence = 1; sequence <= 3; sequence += 1) {
    packetBus.publish(acceptedPacket({
      seq: sequence,
      plotT0Ms: sequence * 100,
      t0Us: 1_000_000 + sequence * 100_000,
      ecg: [[0, 1_000 + sequence, 0, 0]],
    }));
  }
  pipeline.requestSessionStop(sessionId);
  await waitUntil(() => pipeline.getSnapshot().queueDepth === 0);
  assert.deepEqual(pipeline.getSnapshot().baseline, {
    collection_complete: false,
    ready_modalities: [],
  });

  packetBus.publish(acceptedPacket({
    seq: 4,
    plotT0Ms: 10_000,
    t0Us: 2_000_000,
    ecg: [[0, 1_004, 0, 0]],
  }));
  assert.equal(pipeline.getSnapshot().queueDepth, 0);
  assert.equal(pipeline.getSnapshot().queueDrops, 1);
  pipeline.close();
});

test("serialized queue is FIFO, bounded, and closeable", () => {
  const queue = new SerializedAnalysisQueue(2);
  const first = acceptedPacket({ seq: 1 });
  const second = acceptedPacket({ seq: 2 });
  assert.equal(queue.enqueue(first), true);
  assert.equal(queue.enqueue(second), true);
  assert.equal(queue.enqueue(acceptedPacket({ seq: 3 })), false);
  assert.equal(queue.getDepth(), 2);
  assert.equal(queue.shift()?.packet.raw_packet.seq, 1);
  assert.equal(queue.shift()?.packet.raw_packet.seq, 2);
  assert.equal(queue.shift(), undefined);
  queue.close();
  assert.equal(queue.enqueue(first), false);
});

test("one queued packet can emit multiple ordered complete windows", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const results: AnalysisResult[] = [];
  resultBus.subscribe((result) => results.push(result));
  const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);

  packetBus.publish(acceptedPacket({ seq: 1, plotT0Ms: 0, t0Us: 1_000_000, ecg: [[0, 1_000, 0, 0]] }));
  packetBus.publish(acceptedPacket({
    seq: 2,
    plotT0Ms: 12_300,
    t0Us: 13_300_000,
    ecg: [[0, 1_001, 0, 0]],
  }));

  await waitUntil(() => results.length === 3);
  assert.deepEqual(results.map((result) => [result.window.start_ms, result.window.end_ms]), [
    [0, 10_000],
    [1_000, 11_000],
    [2_000, 12_000],
  ]);
  pipeline.close();
});

test("epoch transition resets detector, baseline, and window coordinates", async () => {
  const packetBus = new AcceptedPacketBus();
  const resultBus = new AnalysisResultBus();
  const results: AnalysisResult[] = [];
  resultBus.subscribe((result) => results.push(result));
  const pipeline = new ObjectiveAnalysisPipeline(packetBus, resultBus);
  const nextEpoch = "00000000-0000-4000-8000-000000000003";

  packetBus.publish(acceptedPacket({ seq: 1, plotT0Ms: 0, t0Us: 1_000_000, ecg: [[0, 1_000, 0, 0]] }));
  packetBus.publish(acceptedPacket({
    seq: 2,
    plotT0Ms: 10_000,
    t0Us: 11_000_000,
    ecg: [[0, 1_001, 0, 0]],
  }));
  packetBus.publish(acceptedPacket({
    seq: 1,
    epochId: nextEpoch,
    plotT0Ms: 0,
    t0Us: 2_000_000,
    ecg: [[0, 1_100, 0, 0]],
  }));
  packetBus.publish(acceptedPacket({
    seq: 2,
    epochId: nextEpoch,
    plotT0Ms: 10_000,
    t0Us: 12_000_000,
    ecg: [[0, 1_101, 0, 0]],
  }));

  await waitUntil(() => results.length === 2);
  assert.deepEqual(results.map((result) => result.epoch_id), [
    "00000000-0000-4000-8000-000000000002",
    nextEpoch,
  ]);
  assert.deepEqual([results[1].window.start_ms, results[1].window.end_ms], [0, 10_000]);
  assert.equal(pipeline.getSnapshot().baseline.collection_complete, false);
  pipeline.close();
});
