import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import type { Pool } from "pg";

import { ANALYSIS_VERSION } from "./analysis/versions.js";
import type { AnalysisResult } from "./analysis/types.js";
import { handleObjectiveAnalysisRequest, type ObjectiveAnalysisRouteDependencies } from "./analysisRoutes.js";
import {
  MAX_ANALYSIS_RESULTS,
  ObjectiveAnalysisHistoryRepository,
  type HistoricalAnalysisResultWindow,
} from "./history/analysisHistoryRepository.js";
import {
  DEFAULT_REPLAY_DURATION_MS,
  MAX_REPLAY_DURATION_MS,
} from "./history/historyRepository.js";
import type { ObjectiveSession } from "./sessionManager.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const session: ObjectiveSession = {
  session_id: SESSION_ID,
  device_id: "device-a",
  status: "COMPLETED",
  created_at_ms: 1_000,
  updated_at_ms: 5_000,
  completed_at_ms: 5_000,
};

const analysisResult = {
  type: "analysis_update",
  session_id: SESSION_ID,
  device_id: "device-a",
  boot_id: "boot-a",
  epoch_id: "epoch-a",
  analysis_version: ANALYSIS_VERSION,
  conversion_version: "conversion-1.0",
  feature_version: "feature-1.0",
  rule_version: "rules-1.0",
  created_at_ms: 12_000,
  window: {
    start_us: 1_000_000,
    end_us: 11_000_000,
    start_ms: 1_000,
    end_ms: 11_000,
    duration_ms: 10_000,
  },
  source: {
    first_packet_seq: 1,
    last_packet_seq: 2,
    packet_count: 2,
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
} as AnalysisResult;

function resultRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    replay_start_ms: "1.5",
    replay_end_ms: "11.5",
    result: analysisResult,
    ...overrides,
  };
}

async function withAnalysisServer(
  dependencies: ObjectiveAnalysisRouteDependencies,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handleObjectiveAnalysisRequest(request, response, dependencies)
      .then((handled) => {
        if (!handled) response.writeHead(404).end("Not Found\n");
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function emptyWindow(fromMs: number, durationMs: number): HistoricalAnalysisResultWindow {
  return {
    window: {
      from_ms: fromMs,
      duration_ms: durationMs,
      to_ms: fromMs + durationMs,
      result_count: 0,
      result_cap: MAX_ANALYSIS_RESULTS,
      capped: false,
    },
    results: [],
  };
}

test("analysis history maps persisted absolute windows onto replay time", async () => {
  let queryValues: unknown[] | undefined;
  let queryText = "";
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      queryText = sql;
      queryValues = values;
      return { rows: [resultRow()] };
    },
  } as unknown as Pick<Pool, "query">;

  const window = await new ObjectiveAnalysisHistoryRepository(pool).getAnalysisWindow(
    SESSION_ID,
    500,
    2_000,
    ANALYSIS_VERSION,
  );

  assert.deepEqual(queryValues, [SESSION_ID, 500, 2_000, ANALYSIS_VERSION]);
  assert.match(queryText, /MIN\(esp_anchor_us\)/);
  assert.match(queryText, /MIN\(backend_anchor_ms\)/);
  assert.match(queryText, /r\.window_start_us - a\.esp_anchor_us/);
  assert.match(queryText, /r\.window_end_us - a\.esp_anchor_us/);
  assert.match(queryText, /replay_end_ms > \$2/);
  assert.match(queryText, /replay_start_ms < \$2 \+ \$3/);
  assert.match(queryText, /ORDER BY replay_start_ms, epoch_id, window_start_us/);
  assert.match(queryText, /LIMIT 1001/);
  assert.equal(window.window.result_count, 1);
  assert.deepEqual(window.results[0], {
    replay_start_ms: 1.5,
    replay_end_ms: 11.5,
    result: analysisResult,
  });
});

test("analysis history returns at most 1000 results and reports capping", async () => {
  const rows = Array.from({ length: MAX_ANALYSIS_RESULTS + 1 }, (_, index) => resultRow({
    replay_start_ms: index,
    replay_end_ms: index + 10,
  }));
  const pool = {
    query: async () => ({ rows }),
  } as unknown as Pick<Pool, "query">;

  const window = await new ObjectiveAnalysisHistoryRepository(pool).getAnalysisWindow(
    SESSION_ID,
    0,
    MAX_REPLAY_DURATION_MS,
    ANALYSIS_VERSION,
  );

  assert.equal(window.results.length, MAX_ANALYSIS_RESULTS);
  assert.equal(window.window.result_count, MAX_ANALYSIS_RESULTS);
  assert.equal(window.window.result_cap, MAX_ANALYSIS_RESULTS);
  assert.equal(window.window.capped, true);
});

test("analysis route returns the current version with default bounded replay coordinates", async () => {
  const calls: Array<[string, number, number, string]> = [];
  await withAnalysisServer({
    sessionRepository: { getSession: async () => session },
    analysisHistoryRepository: {
      getAnalysisWindow: async (id, fromMs, durationMs, version) => {
        calls.push([id, fromMs, durationMs, version]);
        return emptyWindow(fromMs, durationMs);
      },
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/analysis`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).window, emptyWindow(0, DEFAULT_REPLAY_DURATION_MS).window);
    assert.deepEqual(calls, [[SESSION_ID, 0, DEFAULT_REPLAY_DURATION_MS, ANALYSIS_VERSION]]);
  });
});

test("analysis route validates bounds/version and does not read invalid requests", async () => {
  let sessionReads = 0;
  const dependencies: ObjectiveAnalysisRouteDependencies = {
    sessionRepository: { getSession: async () => { sessionReads += 1; return session; } },
    analysisHistoryRepository: {
      getAnalysisWindow: async (_id, fromMs, durationMs) => emptyWindow(fromMs, durationMs),
    },
  };

  await withAnalysisServer(dependencies, async (origin) => {
    const invalidQueries = [
      "from_ms=-1",
      "from_ms=nope",
      "from_ms=Infinity",
      "duration_ms=0",
      "duration_ms=60000.1",
      "analysis_version=",
      `analysis_version=${"x".repeat(65)}`,
    ];
    for (const query of invalidQueries) {
      const response = await fetch(
        `${origin}/api/objective/sessions/${SESSION_ID}/analysis?${query}`,
      );
      assert.equal(response.status, 400, query);
    }
    assert.equal(sessionReads, 0);
  });
});

test("unknown analysis session returns 404 without reading persisted results", async () => {
  let analysisReads = 0;
  await withAnalysisServer({
    sessionRepository: { getSession: async () => undefined },
    analysisHistoryRepository: {
      getAnalysisWindow: async () => {
        analysisReads += 1;
        return emptyWindow(0, DEFAULT_REPLAY_DURATION_MS);
      },
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/analysis`);
    assert.equal(response.status, 404);
    assert.equal(analysisReads, 0);
  });
});

test("analysis history database failures map to objective persistence unavailable", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await withAnalysisServer({
      sessionRepository: { getSession: async () => session },
      analysisHistoryRepository: {
        getAnalysisWindow: async () => { throw new Error("database unavailable"); },
      },
    }, async (origin) => {
      const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/analysis`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "objective persistence unavailable" });
    });
  } finally {
    console.error = originalConsoleError;
  }
});
