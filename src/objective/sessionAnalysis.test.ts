import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import type { Pool } from "pg";

import { ANALYSIS_VERSION } from "./analysis/versions.js";
import type { FinalSessionAnalysis } from "./analysis/sessionSynthesis.js";
import { FinalSessionAnalysisBus } from "./analysis/sessionSynthesis.js";
import { handleObjectiveAnalysisRequest } from "./analysisRoutes.js";
import { ObjectiveSessionAnalysisStore } from "./sessionAnalysisStore.js";
import type { ObjectiveSession } from "./sessionManager.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const session: ObjectiveSession = {
  session_id: SESSION_ID,
  device_id: "device-a",
  status: "COMPLETED",
  created_at_ms: 1_000,
  updated_at_ms: 30_000,
  completed_at_ms: 30_000,
};

const finalAnalysis = {
  type: "final_session_analysis",
  session_id: SESSION_ID,
  device_id: "device-a",
  analysis_version: ANALYSIS_VERSION,
  created_at_ms: 31_000,
  session: {
    duration_ms: 27_300,
    start_ms: 0,
    end_ms: 27_300,
    epoch_count: 1,
    epoch_ids: ["epoch-a"],
    completed_window_count: 2,
    incomplete_tail_present: true,
    incomplete_tail_duration_ms: 7_300,
    finalization_timestamp_ms: 31_000,
  },
} as unknown as FinalSessionAnalysis;

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for final analysis persistence");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

test("final session analysis persistence is asynchronous and idempotent", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  let insertAttempts = 0;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO objective_session_analysis")) {
        insertAttempts += 1;
        return { rowCount: insertAttempts === 1 ? 1 : 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pick<Pool, "query">;
  const bus = new FinalSessionAnalysisBus();
  const store = new ObjectiveSessionAnalysisStore(bus, pool, { retryDelayMs: 0 });

  bus.publish(finalAnalysis);
  bus.publish(finalAnalysis);
  assert.equal(store.getSnapshot().queueDepth, 2);
  await waitUntil(() => store.getSnapshot().persistedResults === 1);
  assert.equal(store.getSnapshot().suppressedDuplicates, 1);
  assert.match(calls[0].sql, /objective_session_analysis/);
  assert.equal(calls[0].values[0], SESSION_ID);
  assert.equal(calls[0].values[1], ANALYSIS_VERSION);
  store.close();
});

async function requestFinalAnalysis(
  store: { getFinalAnalysis: (sessionId: string, version: string) => Promise<FinalSessionAnalysis | undefined> } | undefined,
  pipeline: { getFinalAnalysisState: (sessionId: string) => "pending" | "complete" | "unavailable" | "error" } | undefined,
  requestedSessionId = SESSION_ID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((request, response) => {
    void handleObjectiveAnalysisRequest(request, response, {
      sessionRepository: { getSession: async (sessionId) => sessionId === SESSION_ID ? session : undefined },
      analysisHistoryRepository: { getAnalysisWindow: async () => {
        throw new Error("history route should not be selected");
      } },
      sessionAnalysisStore: store,
      analysisPipeline: pipeline,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/objective/sessions/${requestedSessionId}/final-analysis`,
    );
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("final-analysis API exposes complete and pending states and unknown sessions return 404", async () => {
  const complete = await requestFinalAnalysis({
    getFinalAnalysis: async () => finalAnalysis,
  }, undefined);
  assert.equal(complete.status, 200);
  assert.equal((complete.body.final_analysis as Record<string, unknown>).state, "complete");
  assert.deepEqual(
    (complete.body.final_analysis as Record<string, unknown>).result,
    finalAnalysis,
  );

  const pending = await requestFinalAnalysis(undefined, {
    getFinalAnalysisState: () => "pending",
  });
  assert.equal(pending.status, 200);
  assert.equal((pending.body.final_analysis as Record<string, unknown>).state, "pending");

  const awaitingPersistence = await requestFinalAnalysis(undefined, {
    getFinalAnalysisState: () => "complete",
  });
  assert.equal(awaitingPersistence.status, 200);
  assert.equal(
    (awaitingPersistence.body.final_analysis as Record<string, unknown>).state,
    "pending",
  );

  const unknown = await requestFinalAnalysis({
    getFinalAnalysis: async () => finalAnalysis,
  }, undefined, "00000000-0000-4000-8000-000000000099");
  assert.equal(unknown.status, 404);
});
