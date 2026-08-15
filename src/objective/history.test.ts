import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import type { Pool } from "pg";

import {
  DEFAULT_REPLAY_DURATION_MS,
  MAX_REPLAY_PACKETS,
  ObjectiveHistoryRepository,
  type ReplayPacketWindow,
  type ReplayTimelineManifest,
} from "./history/historyRepository.js";
import {
  handleObjectiveHistoryRequest,
  type ObjectiveHistoryRouteDependencies,
} from "./history/historyRoutes.js";
import type { SchemaV1Packet } from "./packetValidator.js";
import type { ObjectiveSession } from "./sessionManager.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const EPOCH_A = "00000000-0000-4000-8000-000000000002";
const EPOCH_B = "00000000-0000-4000-8000-000000000003";

const session: ObjectiveSession = {
  session_id: SESSION_ID,
  device_id: "device-a",
  status: "COMPLETED",
  created_at_ms: 1_000,
  updated_at_ms: 5_000,
  completed_at_ms: 5_000,
};

function rawPacket(seq: number, overrides: Partial<SchemaV1Packet> = {}): SchemaV1Packet {
  return {
    schema: 1,
    session_id: SESSION_ID,
    seq,
    timebase: "esp_timer_us",
    created_us: 100_000,
    t0_us: 0,
    t1_us: 100_000,
    truncated: 0,
    n: [1, 0, 0, 0, 0],
    ecg: [[0, 123, 0, 0]],
    ppg: [],
    gsr: [],
    imu: [],
    temp: [],
    ...overrides,
  };
}

function annotatedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    boot_id: "boot-a",
    seq: 1,
    received_at_ms: 10_050,
    sequence_status: "normal",
    gap_before: 0,
    history_gap_before: 0,
    epoch_id: EPOCH_A,
    esp_anchor_us: 1_000,
    backend_anchor_ms: 10_000,
    plot_t0_ms: 0,
    packet_effective_wall_ms: 10_000,
    timeline_origin_wall_ms: 10_000,
    replay_t0_ms: 0,
    packet_end_replay_ms: 100,
    truncated: 0,
    raw_packet: rawPacket(1),
    available_packet_count: 1,
    ...overrides,
  };
}

function repositoryWithRows(rows: Record<string, unknown>[], sqlCalls: string[] = []): ObjectiveHistoryRepository {
  const pool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Pick<Pool, "query">;
  return new ObjectiveHistoryRepository(pool);
}

function emptyTimeline(): ReplayTimelineManifest {
  return {
    origin_wall_ms: null,
    duration_ms: 0,
    packet_count: 0,
    ingestion_gap_events: 0,
    ingestion_missing_packets: 0,
    history_gap_events: 0,
    history_missing_packets: 0,
    truncated_packets: 0,
    boot_count: 0,
    epoch_count: 0,
    first_received_at_ms: null,
    last_received_at_ms: null,
    gaps: [],
    segments: [],
  };
}

function emptyWindow(fromMs: number, durationMs: number): ReplayPacketWindow {
  return {
    window: {
      from_ms: fromMs,
      duration_ms: durationMs,
      to_ms: fromMs + durationMs,
      packet_count: 0,
      available_packet_count: 0,
      packet_cap: MAX_REPLAY_PACKETS,
      capped: false,
    },
    packets: [],
  };
}

async function withHistoryServer(
  dependencies: ObjectiveHistoryRouteDependencies,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handleObjectiveHistoryRequest(request, response, dependencies)
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

test("manifest reports timing span, distinct gaps, truncation, and reboot/epoch segments", async () => {
  const repository = repositoryWithRows([
    annotatedRow({ sequence_status: "first" }),
    annotatedRow({
      seq: 4,
      received_at_ms: 10_250,
      sequence_status: "gap",
      gap_before: 1,
      history_gap_before: 1,
      plot_t0_ms: 200,
      packet_effective_wall_ms: 10_200,
      replay_t0_ms: 200,
      packet_end_replay_ms: 350,
      truncated: 1,
    }),
    annotatedRow({
      seq: 5,
      received_at_ms: 10_450,
      epoch_id: EPOCH_B,
      plot_t0_ms: 400,
      packet_effective_wall_ms: 10_400,
      replay_t0_ms: 400,
      packet_end_replay_ms: 500,
    }),
    annotatedRow({
      boot_id: "boot-b",
      seq: 99,
      received_at_ms: 10_650,
      sequence_status: "first",
      epoch_id: EPOCH_B,
      plot_t0_ms: 600,
      packet_effective_wall_ms: 10_600,
      replay_t0_ms: 600,
      packet_end_replay_ms: 725,
    }),
  ]);

  const manifest = await repository.getManifest(SESSION_ID);
  assert.equal(manifest.origin_wall_ms, 10_000);
  assert.equal(manifest.duration_ms, 725);
  assert.equal(manifest.packet_count, 4);
  assert.equal(manifest.ingestion_gap_events, 1);
  assert.equal(manifest.ingestion_missing_packets, 1);
  assert.equal(manifest.history_gap_events, 1);
  assert.equal(manifest.history_missing_packets, 1);
  assert.equal(manifest.truncated_packets, 1);
  assert.equal(manifest.boot_count, 2);
  assert.equal(manifest.epoch_count, 2);
  assert.deepEqual(manifest.gaps.map(({ type, replay_ms, missing_packets, seq }) => ({
    type,
    replay_ms,
    missing_packets,
    seq,
  })), [
    { type: "ingestion", replay_ms: 200, missing_packets: 1, seq: 4 },
    { type: "history", replay_ms: 200, missing_packets: 1, seq: 4 },
  ]);
  assert.deepEqual(manifest.segments.map((segment) => segment.boundary_type), [
    "session_start",
    "time_epoch",
    "device_reboot",
  ]);
});

test("known session with no packets has a valid empty manifest", async () => {
  assert.deepEqual(await repositoryWithRows([]).getManifest(SESSION_ID), emptyTimeline());
});

test("same-boot epoch transition resets history-gap inference but remains a time boundary", async () => {
  const sqlCalls: string[] = [];
  const repository = repositoryWithRows([
    annotatedRow({
      seq: 100,
      sequence_status: "normal",
      raw_packet: rawPacket(100),
    }),
    annotatedRow({
      seq: 105,
      sequence_status: "first",
      epoch_id: EPOCH_B,
      history_gap_before: 0,
      plot_t0_ms: 200,
      packet_effective_wall_ms: 10_200,
      replay_t0_ms: 200,
      packet_end_replay_ms: 300,
      raw_packet: rawPacket(105),
    }),
  ], sqlCalls);

  const manifest = await repository.getManifest(SESSION_ID);
  assert.equal(manifest.history_gap_events, 0);
  assert.equal(manifest.history_missing_packets, 0);
  assert.deepEqual(manifest.gaps.filter((gap) => gap.type === "history"), []);
  assert.deepEqual(manifest.segments.map((segment) => segment.boundary_type), [
    "session_start",
    "time_epoch",
  ]);
  assert.match(
    sqlCalls[0],
    /lag\(seq\)[\s\S]*PARTITION BY session_id, boot_id, epoch_id[\s\S]*ORDER BY seq/i,
  );
});

test("same-boot same-epoch packet query retains history gaps before window filtering", async () => {
  const sourcePacket = rawPacket(8, { ecg: [[25_000, 456, 1, 0]] });
  const sqlCalls: string[] = [];
  const repository = repositoryWithRows([
    annotatedRow({
      seq: 8,
      history_gap_before: 2,
      replay_t0_ms: 9_950,
      packet_end_replay_ms: 10_050,
      raw_packet: sourcePacket,
    }),
  ], sqlCalls);

  const result = await repository.getPacketWindow(SESSION_ID, 10_000.5, 2_000);
  assert.equal(result.packets[0].history_gap_before, 2);
  assert.strictEqual(result.packets[0].raw_packet, sourcePacket);
  assert.match(
    sqlCalls[0],
    /lag\(seq\)[\s\S]*PARTITION BY session_id, boot_id, epoch_id[\s\S]*ORDER BY seq/i,
  );
  assert.match(
    sqlCalls[0],
    /greatest\(0, seq - previous_persisted_seq - 1 - gap_before\)/,
  );
  assert.ok(sqlCalls[0].indexOf("lag(seq)") < sqlCalls[0].indexOf("WHERE packet_end_replay_ms"));
  assert.match(sqlCalls[0], /packet_end_replay_ms >= \$2[\s\S]*replay_t0_ms < \$2 \+ \$3/);
});

test("packet response remains hard-capped at 1000 rows", async () => {
  const rows = Array.from({ length: MAX_REPLAY_PACKETS + 1 }, (_, index) => annotatedRow({
    seq: index,
    raw_packet: rawPacket(index),
    available_packet_count: MAX_REPLAY_PACKETS + 1,
  }));
  const result = await repositoryWithRows(rows).getPacketWindow(SESSION_ID, 0, 60_000);
  assert.equal(result.packets.length, MAX_REPLAY_PACKETS);
  assert.equal(result.window.packet_count, MAX_REPLAY_PACKETS);
  assert.equal(result.window.available_packet_count, MAX_REPLAY_PACKETS + 1);
  assert.equal(result.window.capped, true);
});

test("unknown replay session returns 404 without querying packet history", async () => {
  let historyRead = false;
  await withHistoryServer({
    sessionRepository: { getSession: async () => undefined },
    historyRepository: {
      getManifest: async () => { historyRead = true; return emptyTimeline(); },
      getPacketWindow: async (_id, from, duration) => emptyWindow(from, duration),
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/replay`);
    assert.equal(response.status, 404);
    assert.equal(historyRead, false);
  });
});

test("manifest route returns durable session metadata and empty history", async () => {
  await withHistoryServer({
    sessionRepository: { getSession: async () => session },
    historyRepository: {
      getManifest: async () => emptyTimeline(),
      getPacketWindow: async (_id, from, duration) => emptyWindow(from, duration),
    },
  }, async (origin) => {
    const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/replay`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { session, timeline: emptyTimeline() });
  });
});

test("packet route applies default bounds and accepts a fractional direct seek", async () => {
  const calls: Array<[string, number, number]> = [];
  await withHistoryServer({
    sessionRepository: { getSession: async () => session },
    historyRepository: {
      getManifest: async () => emptyTimeline(),
      getPacketWindow: async (id, from, duration) => {
        calls.push([id, from, duration]);
        return emptyWindow(from, duration);
      },
    },
  }, async (origin) => {
    const defaultResponse = await fetch(
      `${origin}/api/objective/sessions/${SESSION_ID}/replay/packets`,
    );
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual((await defaultResponse.json()).window, emptyWindow(0, DEFAULT_REPLAY_DURATION_MS).window);

    const seekResponse = await fetch(
      `${origin}/api/objective/sessions/${SESSION_ID}/replay/packets?from_ms=1250.5&duration_ms=2000`,
    );
    assert.equal(seekResponse.status, 200);
    assert.deepEqual(calls, [
      [SESSION_ID, 0, DEFAULT_REPLAY_DURATION_MS],
      [SESSION_ID, 1250.5, 2_000],
    ]);
  });
});

test("packet route rejects invalid replay bounds before database lookup", async () => {
  let sessionReads = 0;
  const dependencies: ObjectiveHistoryRouteDependencies = {
    sessionRepository: { getSession: async () => { sessionReads += 1; return session; } },
    historyRepository: {
      getManifest: async () => emptyTimeline(),
      getPacketWindow: async (_id, from, duration) => emptyWindow(from, duration),
    },
  };
  await withHistoryServer(dependencies, async (origin) => {
    const invalidQueries = [
      "from_ms=-1",
      "from_ms=nope",
      "from_ms=Infinity",
      "duration_ms=0",
      "duration_ms=-1",
      "duration_ms=nope",
      "duration_ms=Infinity",
      "duration_ms=60000.1",
    ];
    for (const query of invalidQueries) {
      const response = await fetch(
        `${origin}/api/objective/sessions/${SESSION_ID}/replay/packets?${query}`,
      );
      assert.equal(response.status, 400, query);
    }
    assert.equal(sessionReads, 0);
  });
});

test("database failures map to objective persistence unavailable", async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await withHistoryServer({
      sessionRepository: { getSession: async () => session },
      historyRepository: {
        getManifest: async () => { throw new Error("database unavailable"); },
        getPacketWindow: async (_id, from, duration) => emptyWindow(from, duration),
      },
    }, async (origin) => {
      const response = await fetch(`${origin}/api/objective/sessions/${SESSION_ID}/replay`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "objective persistence unavailable" });
    });
  } finally {
    console.error = originalConsoleError;
  }
});
