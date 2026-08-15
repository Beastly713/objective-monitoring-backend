import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import {
  ActiveObjectiveSessionConflictError,
  type ObjectiveSession,
  type ObjectiveSessionManager,
  UnknownObjectiveDeviceError,
} from "./sessionManager.js";

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

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ObjectiveSessionRouteDependencies {
  sessionManager: ObjectiveSessionManager;
  deviceRegistry: ObjectiveDeviceRegistry;
}

function sendSession(response: ServerResponse, session: ObjectiveSession, statusCode = 200): void {
  sendJson(response, statusCode, session);
}

export async function handleObjectiveSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ObjectiveSessionRouteDependencies,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "POST" && url.pathname === "/api/objective/sessions") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const statusCode = error instanceof RangeError ? 413 : 400;
      sendJson(response, statusCode, { error: statusCode === 413 ? "request body too large" : "invalid JSON body" });
      return true;
    }

    if (!isRecord(body) || typeof body.device_id !== "string" || body.device_id.trim().length === 0) {
      sendJson(response, 400, { error: "device_id must be a non-empty string" });
      return true;
    }

    try {
      let session = dependencies.sessionManager.createSession(
        body.device_id,
        dependencies.deviceRegistry.isConnected(body.device_id),
      );

      if (session.status === "LIVE") {
        const sent = dependencies.deviceRegistry.send(session.device_id, `START:${session.session_id}`);
        if (!sent) {
          session = dependencies.sessionManager.handleDeviceDisconnected(session.device_id) ?? session;
        }
      }

      sendSession(response, session, 201);
    } catch (error) {
      if (error instanceof UnknownObjectiveDeviceError) {
        sendJson(response, 404, { error: "unknown objective device" });
      } else if (error instanceof ActiveObjectiveSessionConflictError) {
        sendJson(response, 409, { error: "device already has a non-completed session" });
      } else {
        throw error;
      }
    }

    return true;
  }

  const sessionMatch = /^\/api\/objective\/sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && sessionMatch !== null) {
    const session = dependencies.sessionManager.getSession(decodeURIComponent(sessionMatch[1]));
    if (session === undefined) {
      sendJson(response, 404, { error: "objective session not found" });
    } else {
      sendSession(response, session);
    }
    return true;
  }

  const stopMatch = /^\/api\/objective\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
  if (request.method === "POST" && stopMatch !== null) {
    const result = dependencies.sessionManager.stopSession(decodeURIComponent(stopMatch[1]));
    if (result === undefined) {
      sendJson(response, 404, { error: "objective session not found" });
      return true;
    }

    if (result.changed && dependencies.deviceRegistry.isConnected(result.session.device_id)) {
      dependencies.deviceRegistry.send(result.session.device_id, `STOP:${result.session.session_id}`);
    }
    sendSession(response, result.session);
    return true;
  }

  return false;
}
