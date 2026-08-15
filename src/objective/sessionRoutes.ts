import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import type { ObjectiveSessionRepository } from "./persistence/sessionRepository.js";
import {
  ActiveObjectiveSessionConflictError,
  type ObjectiveSession,
  type ObjectiveSessionManager,
  UnknownObjectiveDeviceError,
} from "./sessionManager.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const SESSION_HISTORY_LIMIT = 100;

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

function logPersistenceFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown database error";
  console.error(`[objective-storage] session ${operation} failed message=${message}`);
}

export interface ObjectiveSessionRouteDependencies {
  sessionManager: ObjectiveSessionManager;
  sessionRepository: ObjectiveSessionRepository;
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
      dependencies.sessionManager.assertCanRegisterSession(body.device_id);
    } catch (error) {
      if (error instanceof UnknownObjectiveDeviceError) {
        sendJson(response, 404, { error: "unknown objective device" });
      } else if (error instanceof ActiveObjectiveSessionConflictError) {
        sendJson(response, 409, { error: "device already has a non-completed session" });
      } else {
        throw error;
      }
      return true;
    }

    let durableSession: ObjectiveSession;
    try {
      durableSession = await dependencies.sessionRepository.createSession(body.device_id);
    } catch (error) {
      if (error instanceof ActiveObjectiveSessionConflictError) {
        sendJson(response, 409, { error: "device already has a non-completed session" });
      } else {
        logPersistenceFailure("create", error);
        sendJson(response, 503, { error: "objective persistence unavailable" });
      }
      return true;
    }

    let session = dependencies.sessionManager.registerSession(durableSession);
    if (dependencies.deviceRegistry.isConnected(session.device_id)) {
      session = dependencies.sessionManager.handleDeviceConnected(session.device_id) ?? session;
      const sent = dependencies.deviceRegistry.send(session.device_id, `START:${session.session_id}`);
      if (!sent) {
        session = dependencies.sessionManager.handleDeviceDisconnected(session.device_id) ?? session;
      }
    }

    sendSession(response, session, 201);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/objective/sessions") {
    try {
      const sessions = await dependencies.sessionRepository.listRecentSessions(SESSION_HISTORY_LIMIT);
      sendJson(response, 200, { sessions });
    } catch (error) {
      logPersistenceFailure("history read", error);
      sendJson(response, 503, { error: "objective persistence unavailable" });
    }
    return true;
  }

  const sessionMatch = /^\/api\/objective\/sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && sessionMatch !== null) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const runtimeSession = dependencies.sessionManager.getSession(sessionId);
    if (runtimeSession !== undefined) {
      sendSession(response, runtimeSession);
      return true;
    }

    try {
      const durableSession = await dependencies.sessionRepository.getSession(sessionId);
      if (durableSession === undefined) {
        sendJson(response, 404, { error: "objective session not found" });
      } else {
        sendSession(response, durableSession);
      }
    } catch (error) {
      logPersistenceFailure("read", error);
      sendJson(response, 503, { error: "objective persistence unavailable" });
    }
    return true;
  }

  const stopMatch = /^\/api\/objective\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
  if (request.method === "POST" && stopMatch !== null) {
    const sessionId = decodeURIComponent(stopMatch[1]);
    const result = dependencies.sessionManager.stopSession(sessionId);
    if (result === undefined) {
      try {
        const durableSession = await dependencies.sessionRepository.getSession(sessionId);
        if (durableSession === undefined) {
          sendJson(response, 404, { error: "objective session not found" });
        } else if (durableSession.status === "COMPLETED") {
          sendSession(response, durableSession);
        } else {
          console.error(
            `[objective-storage] non-completed session missing from runtime session_id=${sessionId}`,
          );
          sendJson(response, 503, { error: "objective session runtime unavailable" });
        }
      } catch (error) {
        logPersistenceFailure("stop lookup", error);
        sendJson(response, 503, { error: "objective persistence unavailable" });
      }
      return true;
    }

    if (result.changed && dependencies.deviceRegistry.isConnected(result.session.device_id)) {
      dependencies.deviceRegistry.send(result.session.device_id, `STOP:${result.session.session_id}`);
    }

    try {
      const completed = await dependencies.sessionRepository.completeSession(
        result.session.session_id,
        result.session.completed_at_ms ?? result.session.updated_at_ms,
      );
      if (completed === undefined) {
        console.error(
          `[objective-storage] durable session disappeared during stop session_id=${result.session.session_id}`,
        );
        sendJson(response, 503, { error: "objective session stopped but durable completion failed" });
      } else {
        sendSession(response, completed);
      }
    } catch (error) {
      logPersistenceFailure("completion", error);
      sendJson(response, 503, { error: "objective session stopped but durable completion failed" });
    }
    return true;
  }

  return false;
}
