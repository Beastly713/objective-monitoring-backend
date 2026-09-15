import type { IncomingMessage, ServerResponse } from "node:http";

import { ANALYSIS_VERSION } from "../analysis/versions.js";
import { MAX_REPLAY_DURATION_MS } from "../history/historyRepository.js";
import { DemoRuntime } from "./demoRuntime.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RangeError("request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQueryNumber(url: URL, name: string, defaultValue: number): number | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return defaultValue;
  if (values.length !== 1 || values[0].trim().length === 0) return undefined;
  const value = Number(values[0]);
  return Number.isFinite(value) ? value : undefined;
}

function decodeSessionId(value: string): string | undefined {
  try {
    const sessionId = decodeURIComponent(value);
    return sessionId.length === 0 ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

export interface ObjectiveDemoRouteDependencies {
  runtime: DemoRuntime;
  enabled?: boolean;
}

export async function handleObjectiveDemoRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ObjectiveDemoRouteDependencies,
): Promise<boolean> {
  if (dependencies.enabled === false) return false;
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/api/objective/demo/scenarios") {
    sendJson(response, 200, {
      scenarios: dependencies.runtime.listScenarios(),
      banner: "SIMULATED DEMONSTRATION — Deterministic synthetic sensor data — not live hardware or patient data.",
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/objective/demo/status") {
    sendJson(response, 200, dependencies.runtime.getStatus());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/objective/demo/sessions") {
    sendJson(response, 200, { sessions: dependencies.runtime.listSessions() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/objective/demo/start") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error instanceof RangeError ? 413 : 400, {
        error: error instanceof RangeError ? "request body too large" : "invalid JSON body",
      });
      return true;
    }
    if (!isRecord(body) || typeof body.scenario_id !== "string" || body.scenario_id.trim().length === 0) {
      sendJson(response, 400, { error: "scenario_id must be a non-empty string" });
      return true;
    }
    try {
      const session = dependencies.runtime.startScenario(body.scenario_id);
      sendJson(response, 202, {
        session,
        demo: dependencies.runtime.getStatus().demo,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unable to start demonstration";
      sendJson(response, message === "unknown demonstration scenario" ? 400 : 500, { error: message });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/objective/demo/stop") {
    let body: unknown = {};
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, error instanceof RangeError ? 413 : 400, {
        error: error instanceof RangeError ? "request body too large" : "invalid JSON body",
      });
      return true;
    }
    const sessionId = isRecord(body) && typeof body.session_id === "string" ? body.session_id : undefined;
    sendJson(response, 202, {
      session: dependencies.runtime.requestStop(sessionId),
      demo: dependencies.runtime.getStatus().demo,
    });
    return true;
  }

  const finalMatch = /^\/api\/objective\/demo\/sessions\/([^/]+)\/final-analysis$/.exec(url.pathname);
  if (request.method === "GET" && finalMatch !== null) {
    const sessionId = decodeSessionId(finalMatch[1]);
    if (sessionId === undefined) {
      sendJson(response, 400, { error: "invalid session id" });
      return true;
    }
    const result = dependencies.runtime.getFinalAnalysis(sessionId);
    if (result === undefined) {
      sendJson(response, 404, { error: "demonstration session not found" });
    } else {
      sendJson(response, 200, result);
    }
    return true;
  }

  const packetsMatch = /^\/api\/objective\/demo\/sessions\/([^/]+)\/replay\/packets$/.exec(url.pathname);
  if (request.method === "GET" && packetsMatch !== null) {
    const sessionId = decodeSessionId(packetsMatch[1]);
    if (sessionId === undefined) {
      sendJson(response, 400, { error: "invalid session id" });
      return true;
    }
    const fromMs = parseQueryNumber(url, "from_ms", 0);
    const durationMs = parseQueryNumber(url, "duration_ms", 30_000);
    if (fromMs === undefined || fromMs < 0 || durationMs === undefined || durationMs <= 0 || durationMs > MAX_REPLAY_DURATION_MS) {
      sendJson(response, 400, { error: "from_ms and duration_ms must be finite and within replay limits" });
      return true;
    }
    const result = dependencies.runtime.getReplayPackets(sessionId, fromMs, durationMs);
    if (result === undefined) {
      sendJson(response, 404, { error: "demonstration session not found" });
    } else {
      sendJson(response, 200, { session: dependencies.runtime.getSession(sessionId), ...result });
    }
    return true;
  }

  const analysisMatch = /^\/api\/objective\/demo\/sessions\/([^/]+)\/analysis$/.exec(url.pathname);
  if (request.method === "GET" && analysisMatch !== null) {
    const sessionId = decodeSessionId(analysisMatch[1]);
    if (sessionId === undefined) {
      sendJson(response, 400, { error: "invalid session id" });
      return true;
    }
    const fromMs = parseQueryNumber(url, "from_ms", 0);
    const durationMs = parseQueryNumber(url, "duration_ms", 30_000);
    const analysisVersion = url.searchParams.get("analysis_version") ?? ANALYSIS_VERSION;
    if (fromMs === undefined || fromMs < 0 || durationMs === undefined || durationMs <= 0 || durationMs > MAX_REPLAY_DURATION_MS || analysisVersion.length > 64) {
      sendJson(response, 400, { error: "analysis replay parameters are invalid" });
      return true;
    }
    const result = dependencies.runtime.getAnalysisWindow(sessionId, fromMs, durationMs);
    if (result === undefined) {
      sendJson(response, 404, { error: "demonstration session not found" });
    } else {
      sendJson(response, 200, { session: dependencies.runtime.getSession(sessionId), ...result });
    }
    return true;
  }

  const replayMatch = /^\/api\/objective\/demo\/sessions\/([^/]+)\/replay$/.exec(url.pathname);
  if (request.method === "GET" && replayMatch !== null) {
    const sessionId = decodeSessionId(replayMatch[1]);
    if (sessionId === undefined) {
      sendJson(response, 400, { error: "invalid session id" });
      return true;
    }
    const timeline = dependencies.runtime.getReplayManifest(sessionId);
    if (timeline === undefined) {
      sendJson(response, 404, { error: "demonstration session not found" });
    } else {
      sendJson(response, 200, { session: dependencies.runtime.getSession(sessionId), timeline });
    }
    return true;
  }

  return false;
}

