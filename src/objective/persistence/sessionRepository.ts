import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  ActiveObjectiveSessionConflictError,
  type ObjectiveSession,
  type ObjectiveSessionStatus,
} from "../sessionManager.js";

interface ObjectiveSessionRow {
  session_id: string;
  device_id: string;
  status: ObjectiveSessionStatus;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  completed_at_ms: string | number | null;
}

interface PostgreSqlError {
  code?: string;
  constraint?: string;
}

const ACTIVE_SESSION_INDEX = "objective_sessions_one_non_completed_per_device";

function mapSession(row: ObjectiveSessionRow): ObjectiveSession {
  return {
    session_id: row.session_id,
    device_id: row.device_id,
    status: row.status,
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
    completed_at_ms: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
  };
}

function isActiveSessionConflict(error: unknown): boolean {
  const databaseError = error as PostgreSqlError;
  return databaseError.code === "23505" && databaseError.constraint === ACTIVE_SESSION_INDEX;
}

export class ObjectiveSessionRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async createSession(deviceId: string): Promise<ObjectiveSession> {
    const now = Date.now();
    try {
      const result = await this.pool.query<ObjectiveSessionRow>(
        `INSERT INTO objective_sessions (
           session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms
         ) VALUES ($1, $2, 'WAITING', $3, $3, NULL)
         RETURNING session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms`,
        [randomUUID(), deviceId, now],
      );
      return mapSession(result.rows[0]);
    } catch (error) {
      if (isActiveSessionConflict(error)) {
        throw new ActiveObjectiveSessionConflictError(
          `device ${deviceId} already has a non-completed session`,
        );
      }
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<ObjectiveSession | undefined> {
    const result = await this.pool.query<ObjectiveSessionRow>(
      `SELECT session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms
       FROM objective_sessions
       WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0] === undefined ? undefined : mapSession(result.rows[0]);
  }

  async listRecentSessions(limit = 100): Promise<ObjectiveSession[]> {
    const result = await this.pool.query<ObjectiveSessionRow>(
      `SELECT session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms
       FROM objective_sessions
       ORDER BY created_at_ms DESC, session_id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapSession);
  }

  async updateRuntimeStatus(session: ObjectiveSession): Promise<void> {
    if (session.status === "COMPLETED") {
      throw new Error("runtime status updates cannot complete sessions");
    }

    await this.pool.query(
      `UPDATE objective_sessions
       SET status = $2, updated_at_ms = $3
       WHERE session_id = $1
         AND status <> 'COMPLETED'
         AND updated_at_ms <= $3`,
      [session.session_id, session.status, session.updated_at_ms],
    );
  }

  async completeSession(sessionId: string, completedAtMs: number): Promise<ObjectiveSession | undefined> {
    const result = await this.pool.query<ObjectiveSessionRow>(
      `UPDATE objective_sessions
       SET status = 'COMPLETED',
           updated_at_ms = CASE WHEN status = 'COMPLETED' THEN updated_at_ms ELSE $2 END,
           completed_at_ms = COALESCE(completed_at_ms, $2)
       WHERE session_id = $1
       RETURNING session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms`,
      [sessionId, completedAtMs],
    );
    return result.rows[0] === undefined ? undefined : mapSession(result.rows[0]);
  }

  async recoverNonCompletedSessions(): Promise<ObjectiveSession[]> {
    const recoveredAtMs = Date.now();
    await this.pool.query(
      `UPDATE objective_sessions
       SET status = 'DISCONNECTED', updated_at_ms = GREATEST(updated_at_ms + 1, $1)
       WHERE status = 'LIVE'`,
      [recoveredAtMs],
    );

    const result = await this.pool.query<ObjectiveSessionRow>(
      `SELECT session_id, device_id, status, created_at_ms, updated_at_ms, completed_at_ms
       FROM objective_sessions
       WHERE status <> 'COMPLETED'
       ORDER BY created_at_ms ASC, session_id ASC`,
    );

    const deviceIds = new Set<string>();
    const sessions = result.rows.map(mapSession);
    for (const session of sessions) {
      if (deviceIds.has(session.device_id)) {
        throw new Error(`multiple non-completed sessions found for objective device ${session.device_id}`);
      }
      deviceIds.add(session.device_id);
    }
    return sessions;
  }
}
