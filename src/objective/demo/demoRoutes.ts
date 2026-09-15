import type { IncomingMessage, ServerResponse } from "node:http";

import { DemoRuntime, DemoRuntimeError } from "./demoRuntime.js";

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
    if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new RangeError("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorStatus(error: unknown): number {
  if (!(error instanceof DemoRuntimeError)) return 500;
  switch (error.code) {
    case "unknown_scenario":
      return 400;
    case "invalid_session":
    case "no_run":
    case "not_ready":
    case "already_started":
    case "run_in_progress":
      return error.code === "invalid_session" ? 400 : 409;
    case "closed":
      return 503;
  }
}

function sendBodyError(response: ServerResponse, error: unknown): void {
  sendJson(response, error instanceof RangeError ? 413 : 400, {
    error: error instanceof RangeError ? "request body too large" : "invalid JSON body",
  });
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
    sendJson(response, 200, { scenarios: dependencies.runtime.listScenarios() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/objective/demo/status") {
    sendJson(response, 200, dependencies.runtime.getStatus());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/objective/demo/result") {
    const status = dependencies.runtime.getStatus();
    if (status.session_id === null) {
      sendJson(response, 404, { error: "no demonstration scenario has been prepared" });
    } else if (!["COMPLETE", "ERROR"].includes(status.phase)) {
      sendJson(response, 409, { error: "demonstration result is not ready", status });
    } else {
      const result = dependencies.runtime.getResult(status.session_id);
      if (result === undefined) {
        sendJson(response, 404, { error: "demonstration result is no longer available" });
      } else {
        sendJson(response, 200, result);
      }
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/objective/demo/start") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendBodyError(response, error);
      return true;
    }
    if (!isRecord(body) || typeof body.scenario_id !== "string" || body.scenario_id.trim().length === 0) {
      sendJson(response, 400, { error: "scenario_id must be a non-empty string" });
      return true;
    }
    try {
      const status = await dependencies.runtime.prepareScenario(body.scenario_id);
      sendJson(response, 200, {
        session_id: status.session_id,
        phase: status.phase,
        status,
      });
    } catch (error) {
      sendJson(response, errorStatus(error), {
        error: error instanceof Error ? error.message : "unable to prepare demonstration",
        status: dependencies.runtime.getStatus(),
      });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/objective/demo/run") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendBodyError(response, error);
      return true;
    }
    if (!isRecord(body) || typeof body.session_id !== "string" || body.session_id.trim().length === 0) {
      sendJson(response, 400, { error: "session_id must be a non-empty string" });
      return true;
    }
    try {
      const status = dependencies.runtime.startVisibleRun(body.session_id);
      sendJson(response, 202, {
        session_id: status.session_id,
        phase: status.phase,
        status,
      });
    } catch (error) {
      sendJson(response, errorStatus(error), {
        error: error instanceof Error ? error.message : "unable to run demonstration",
        status: dependencies.runtime.getStatus(),
      });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/objective/demo/abort") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendBodyError(response, error);
      return true;
    }
    if (!isRecord(body) || typeof body.session_id !== "string" || body.session_id.trim().length === 0) {
      sendJson(response, 400, { error: "session_id must be a non-empty string" });
      return true;
    }
    try {
      const status = dependencies.runtime.abortPreparedRun(body.session_id);
      sendJson(response, 202, { session_id: status.session_id, phase: status.phase, status });
    } catch (error) {
      sendJson(response, errorStatus(error), {
        error: error instanceof Error ? error.message : "unable to abort demonstration preparation",
        status: dependencies.runtime.getStatus(),
      });
    }
    return true;
  }

  return false;
}
