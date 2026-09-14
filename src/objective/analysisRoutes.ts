import type { IncomingMessage, ServerResponse } from "node:http";

import { ANALYSIS_VERSION } from "./analysis/versions.js";
import type { ObjectiveSessionRepository } from "./persistence/sessionRepository.js";
import {
  DEFAULT_REPLAY_DURATION_MS,
  MAX_REPLAY_DURATION_MS,
} from "./history/historyRepository.js";
import type { ObjectiveAnalysisHistoryRepository } from "./history/analysisHistoryRepository.js";

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

function parseAnalysisVersion(url: URL): string | undefined {
  const values = url.searchParams.getAll("analysis_version");
  if (values.length === 0) {
    return ANALYSIS_VERSION;
  }
  if (values.length !== 1 || values[0].trim().length === 0 || values[0].length > 64) {
    return undefined;
  }
  return values[0];
}

function logPersistenceFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown database error";
  console.error(`[objective-storage] analysis history read failed message=${message}`);
}

export interface ObjectiveAnalysisRouteDependencies {
  sessionRepository: Pick<ObjectiveSessionRepository, "getSession">;
  analysisHistoryRepository: Pick<ObjectiveAnalysisHistoryRepository, "getAnalysisWindow">;
}

export async function handleObjectiveAnalysisRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ObjectiveAnalysisRouteDependencies,
): Promise<boolean> {
  if (request.method !== "GET") {
    return false;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/api\/objective\/sessions\/([^/]+)\/analysis$/.exec(url.pathname);
  if (match === null) {
    return false;
  }

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    sendJson(response, 400, { error: "invalid session id" });
    return true;
  }

  const fromMs = parseQueryNumber(url, "from_ms", 0);
  const durationMs = parseQueryNumber(url, "duration_ms", DEFAULT_REPLAY_DURATION_MS);
  const analysisVersion = parseAnalysisVersion(url);
  if (fromMs === undefined || fromMs < 0) {
    sendJson(response, 400, { error: "from_ms must be a finite non-negative number" });
    return true;
  }
  if (
    durationMs === undefined ||
    durationMs <= 0 ||
    durationMs > MAX_REPLAY_DURATION_MS
  ) {
    sendJson(response, 400, {
      error: `duration_ms must be a finite number greater than 0 and at most ${MAX_REPLAY_DURATION_MS}`,
    });
    return true;
  }
  if (analysisVersion === undefined) {
    sendJson(response, 400, {
      error: "analysis_version must be a non-empty value of at most 64 characters",
    });
    return true;
  }

  try {
    const session = await dependencies.sessionRepository.getSession(sessionId);
    if (session === undefined) {
      sendJson(response, 404, { error: "objective session not found" });
      return true;
    }

    const analysisWindow = await dependencies.analysisHistoryRepository.getAnalysisWindow(
      sessionId,
      fromMs,
      durationMs,
      analysisVersion,
    );
    sendJson(response, 200, { session, ...analysisWindow });
  } catch (error) {
    logPersistenceFailure(error);
    sendJson(response, 503, { error: "objective persistence unavailable" });
  }
  return true;
}
