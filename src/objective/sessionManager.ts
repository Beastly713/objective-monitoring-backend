import { randomUUID } from "node:crypto";

export type ObjectiveSessionStatus = "WAITING" | "LIVE" | "DISCONNECTED" | "COMPLETED";

export interface ObjectiveSession {
  session_id: string;
  device_id: string;
  status: ObjectiveSessionStatus;
  created_at_ms: number;
}

export class UnknownObjectiveDeviceError extends Error {}
export class ActiveObjectiveSessionConflictError extends Error {}

const STOPPED_PACKET_GRACE_MS = 5_000;

interface RecentlyStoppedSession {
  sessionId: string;
  stoppedAtMs: number;
}

export class ObjectiveSessionManager {
  private readonly sessions = new Map<string, ObjectiveSession>();
  private readonly activeSessionByDevice = new Map<string, string>();
  private readonly recentlyStoppedSessionByDevice = new Map<string, RecentlyStoppedSession>();

  constructor(private readonly provisionedDeviceIds: ReadonlySet<string>) {}

  createSession(deviceId: string, deviceConnected: boolean): ObjectiveSession {
    if (!this.provisionedDeviceIds.has(deviceId)) {
      throw new UnknownObjectiveDeviceError(`unknown objective device ${deviceId}`);
    }

    if (this.activeSessionByDevice.has(deviceId)) {
      throw new ActiveObjectiveSessionConflictError(`device ${deviceId} already has an active session`);
    }

    const session: ObjectiveSession = {
      session_id: randomUUID(),
      device_id: deviceId,
      status: deviceConnected ? "LIVE" : "WAITING",
      created_at_ms: Date.now(),
    };

    this.sessions.set(session.session_id, session);
    this.activeSessionByDevice.set(deviceId, session.session_id);
    return { ...session };
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

    session.status = "LIVE";
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

    session.status = "DISCONNECTED";
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

    session.status = "COMPLETED";
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
}
