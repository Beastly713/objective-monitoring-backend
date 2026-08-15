export type ObjectiveSessionStatus = "WAITING" | "LIVE" | "DISCONNECTED" | "COMPLETED";

export interface ObjectiveSession {
  session_id: string;
  device_id: string;
  status: ObjectiveSessionStatus;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
}

export class UnknownObjectiveDeviceError extends Error {}
export class ActiveObjectiveSessionConflictError extends Error {}

const STOPPED_PACKET_GRACE_MS = 5_000;

interface RecentlyStoppedSession {
  sessionId: string;
  stoppedAtMs: number;
}

export type RuntimeStatusChangeHandler = (session: ObjectiveSession) => void | Promise<void>;

export class ObjectiveSessionManager {
  private readonly sessions = new Map<string, ObjectiveSession>();
  private readonly activeSessionByDevice = new Map<string, string>();
  private readonly recentlyStoppedSessionByDevice = new Map<string, RecentlyStoppedSession>();

  constructor(
    private readonly provisionedDeviceIds: ReadonlySet<string>,
    private readonly onRuntimeStatusChange?: RuntimeStatusChangeHandler,
  ) {}

  assertCanRegisterSession(deviceId: string): void {
    if (!this.provisionedDeviceIds.has(deviceId)) {
      throw new UnknownObjectiveDeviceError(`unknown objective device ${deviceId}`);
    }
    if (this.activeSessionByDevice.has(deviceId)) {
      throw new ActiveObjectiveSessionConflictError(
        `device ${deviceId} already has a non-completed session`,
      );
    }
  }

  registerSession(session: ObjectiveSession): ObjectiveSession {
    this.assertCanRegisterSession(session.device_id);
    if (session.status === "COMPLETED") {
      throw new Error(`cannot register completed objective session ${session.session_id}`);
    }
    if (this.sessions.has(session.session_id)) {
      throw new Error(`objective session ${session.session_id} is already registered`);
    }

    const runtimeSession = { ...session };
    this.sessions.set(runtimeSession.session_id, runtimeSession);
    this.activeSessionByDevice.set(runtimeSession.device_id, runtimeSession.session_id);
    return { ...runtimeSession };
  }

  hydrateSessions(sessions: readonly ObjectiveSession[]): void {
    for (const session of sessions) {
      this.registerSession(session);
    }
  }

  getSession(sessionId: string): ObjectiveSession | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : { ...session };
  }

  getActiveSessionForDevice(deviceId: string): ObjectiveSession | undefined {
    const sessionId = this.activeSessionByDevice.get(deviceId);
    return sessionId === undefined ? undefined : this.getSession(sessionId);
  }

  getLiveSessionForDevice(deviceId: string): ObjectiveSession | undefined {
    const session = this.getActiveSessionForDevice(deviceId);
    return session?.status === "LIVE" ? session : undefined;
  }

  isRecentlyStoppedSessionPacket(deviceId: string, sessionId: string, receivedAtMs: number): boolean {
    const stopped = this.recentlyStoppedSessionByDevice.get(deviceId);
    return (
      stopped?.sessionId === sessionId &&
      receivedAtMs - stopped.stoppedAtMs >= 0 &&
      receivedAtMs - stopped.stoppedAtMs <= STOPPED_PACKET_GRACE_MS
    );
  }

  handleDeviceConnected(deviceId: string): ObjectiveSession | undefined {
    const sessionId = this.activeSessionByDevice.get(deviceId);
    if (sessionId === undefined) {
      return undefined;
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status === "COMPLETED") {
      return undefined;
    }

    if (session.status !== "LIVE") {
      this.transitionRuntimeStatus(session, "LIVE");
    }
    return { ...session };
  }

  handleDeviceDisconnected(deviceId: string): ObjectiveSession | undefined {
    const sessionId = this.activeSessionByDevice.get(deviceId);
    if (sessionId === undefined) {
      return undefined;
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined || session.status !== "LIVE") {
      return session === undefined ? undefined : { ...session };
    }

    this.transitionRuntimeStatus(session, "DISCONNECTED");
    return { ...session };
  }

  stopSession(sessionId: string): { session: ObjectiveSession; changed: boolean } | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }

    if (session.status === "COMPLETED") {
      return { session: { ...session }, changed: false };
    }

    const stoppedAtMs = this.nextUpdatedAt(session);
    session.status = "COMPLETED";
    session.updated_at_ms = stoppedAtMs;
    session.completed_at_ms = stoppedAtMs;
    this.activeSessionByDevice.delete(session.device_id);
    this.recentlyStoppedSessionByDevice.set(session.device_id, {
      sessionId: session.session_id,
      stoppedAtMs: Date.now(),
    });
    return { session: { ...session }, changed: true };
  }

  describeActiveSessions(): string {
    const states = [...this.activeSessionByDevice.keys()].map((deviceId) => {
      const session = this.getActiveSessionForDevice(deviceId);
      return `${deviceId}:${session?.status ?? "unknown"}`;
    });
    return states.length === 0 ? "none" : states.join(",");
  }

  private transitionRuntimeStatus(session: ObjectiveSession, status: ObjectiveSessionStatus): void {
    session.status = status;
    session.updated_at_ms = this.nextUpdatedAt(session);
    const snapshot = { ...session };

    if (this.onRuntimeStatusChange !== undefined) {
      queueMicrotask(() => {
        Promise.resolve(this.onRuntimeStatusChange?.(snapshot)).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "unknown persistence error";
          console.warn(
            `[objective-storage] session status update failed session_id=${snapshot.session_id} status=${snapshot.status} message=${message}`,
          );
        });
      });
    }
  }

  private nextUpdatedAt(session: ObjectiveSession): number {
    return Math.max(Date.now(), session.updated_at_ms + 1);
  }
}
