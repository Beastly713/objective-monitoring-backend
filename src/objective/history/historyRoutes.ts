import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObjectiveSessionRepository } from "../persistence/sessionRepository.js";
import {
  DEFAULT_REPLAY_DURATION_MS,
  MAX_REPLAY_DURATION_MS,
  type ObjectiveHistoryRepository,
} from "./historyRepository.js";

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function parseQueryNumber(
  url: URL,
  name: string,
  defaultValue: number,
): number | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) {
    return defaultValue;
  }
  if (values.length !== 1 || values[0].trim().length === 0) {
    return undefined;
  }
  const value = Number(values[0]);
  return Number.isFinite(value) ? value : undefined;
}

function logPersistenceFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown database error";
  console.error(`[objective-storage] replay read failed message=${message}`);
}

export interface ObjectiveHistoryRouteDependencies {
  sessionRepository: Pick<ObjectiveSessionRepository, "getSession">;
  historyRepository: Pick<ObjectiveHistoryRepository, "getManifest" | "getPacketWindow">;
}

export async function handleObjectiveHistoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ObjectiveHistoryRouteDependencies,
): Promise<boolean> {
  if (request.method !== "GET") {
    return false;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const packetWindowMatch = /^\/api\/objective\/sessions\/([^/]+)\/replay\/packets$/.exec(url.pathname);
  const manifestMatch = /^\/api\/objective\/sessions\/([^/]+)\/replay$/.exec(url.pathname);
  if (packetWindowMatch === null && manifestMatch === null) {
    return false;
  }

  const encodedSessionId = (packetWindowMatch ?? manifestMatch)?.[1];
  if (encodedSessionId === undefined) {
    return false;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(encodedSessionId);
  } catch {
    sendJson(response, 400, { error: "invalid session id" });
    return true;
  }

  let fromMs = 0;
  let durationMs = DEFAULT_REPLAY_DURATION_MS;
  if (packetWindowMatch !== null) {
    const parsedFromMs = parseQueryNumber(url, "from_ms", 0);
    const parsedDurationMs = parseQueryNumber(url, "duration_ms", DEFAULT_REPLAY_DURATION_MS);
    if (parsedFromMs === undefined || parsedFromMs < 0) {
      sendJson(response, 400, { error: "from_ms must be a finite non-negative number" });
      return true;
    }
    if (
      parsedDurationMs === undefined ||
      parsedDurationMs <= 0 ||
      parsedDurationMs > MAX_REPLAY_DURATION_MS
    ) {
      sendJson(response, 400, {
        error: `duration_ms must be a finite number greater than 0 and at most ${MAX_REPLAY_DURATION_MS}`,
      });
      return true;
    }
    fromMs = parsedFromMs;
    durationMs = parsedDurationMs;
  }

  try {
    const session = await dependencies.sessionRepository.getSession(sessionId);
    if (session === undefined) {
      sendJson(response, 404, { error: "objective session not found" });
      return true;
    }

    if (packetWindowMatch !== null) {
      const packetWindow = await dependencies.historyRepository.getPacketWindow(
        sessionId,
        fromMs,
        durationMs,
      );
      sendJson(response, 200, { session, ...packetWindow });
    } else {
      const timeline = await dependencies.historyRepository.getManifest(sessionId);
      sendJson(response, 200, { session, timeline });
    }
  } catch (error) {
    logPersistenceFailure(error);
    sendJson(response, 503, { error: "objective persistence unavailable" });
  }
  return true;
}
