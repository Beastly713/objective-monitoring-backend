import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { AnalysisResultBus } from "./analysis/resultBus.js";
import type { AnalysisResult } from "./analysis/types.js";
import { ObjectiveAnalysisResultStore } from "./analysisResultStore.js";

function result(windowStartUs = 1_000_000): AnalysisResult {
  return {
    type: "analysis_update",
    session_id: "00000000-0000-4000-8000-000000000001",
    device_id: "device-a",
    boot_id: "boot-a",
    epoch_id: "00000000-0000-4000-8000-000000000002",
    analysis_version: "analysis-1.0",
    conversion_version: "conversion-1.0",
    feature_version: "feature-1.0",
    rule_version: "rules-1.0",
    created_at_ms: 5_000,
    window: {
      start_us: windowStartUs,
      end_us: windowStartUs + 10_000_000,
      start_ms: 0,
      end_ms: 10_000,
      duration_ms: 10_000,
    },
    source: {
      first_packet_seq: 1,
      last_packet_seq: 1,
      packet_count: 1,
      packet_gap_count: 0,
      truncated_packet_count: 0,
      modalities_present: [],
      discarded_out_of_order_samples: 0,
      analysis_input_gap_count: 0,
    },
    baseline_ready: false,
    baseline: {} as AnalysisResult["baseline"],
    modality_results: {} as AnalysisResult["modality_results"],
    multimodal_result: {} as AnalysisResult["multimodal_result"],
    rules_triggered: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for analysis result store state");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("analysis result persistence is asynchronous and idempotent", async () => {
  const bus = new AnalysisResultBus();
  const calls: { sql: string; values: unknown[] }[] = [];
  let attempt = 0;
  const database = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      attempt += 1;
      return { rowCount: attempt === 1 ? 1 : 0, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;
  const store = new ObjectiveAnalysisResultStore(bus, database, { retryDelayMs: 0 });
  const first = result();

  bus.publish(first);
  bus.publish(first);
  assert.equal(calls.length, 0);
  assert.equal(store.getSnapshot().queueDepth, 2);
  await waitUntil(() => store.getSnapshot().persistedResults === 1);
  assert.equal(store.getSnapshot().suppressedDuplicates, 1);
  assert.match(calls[0].sql, /ON CONFLICT/);
  assert.equal(calls[0].values[0], first.session_id);
  assert.equal(calls[0].values[3], first.window.start_us);
  assert.strictEqual(calls[0].values[10], first);
  assert.equal(store.getSnapshot().storageHealthy, true);
  store.close();
});

test("analysis result persistence drops newest results when full", () => {
  const bus = new AnalysisResultBus();
  const database = {
    query: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as Pick<Pool, "query">;
  const store = new ObjectiveAnalysisResultStore(bus, database, {
    queueCapacity: 1,
    retryDelayMs: 1,
  });

  bus.publish(result(1_000_000));
  bus.publish(result(2_000_000));
  assert.equal(store.getSnapshot().queueDepth, 1);
  assert.equal(store.getSnapshot().storageDrops, 1);
  assert.equal(store.getSnapshot().degraded, true);
  store.close();
});

test("analysis result persistence retries database failures without blocking publication", async () => {
  const bus = new AnalysisResultBus();
  let allowSuccess = false;
  let attempts = 0;
  const database = {
    query: async () => {
      attempts += 1;
      if (!allowSuccess) {
        throw new Error("database unavailable");
      }
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;
  const store = new ObjectiveAnalysisResultStore(bus, database, { retryDelayMs: 1 });

  bus.publish(result());
  assert.equal(store.getSnapshot().queueDepth, 1);
  await waitUntil(() => attempts > 0);
  assert.equal(store.getSnapshot().storageErrors > 0, true);
  allowSuccess = true;
  await waitUntil(() => store.getSnapshot().persistedResults === 1);
  assert.equal(store.getSnapshot().queueDepth, 0);
  assert.equal(store.getSnapshot().storageHealthy, true);
  store.close();
});
