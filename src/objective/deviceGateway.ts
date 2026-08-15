import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { AcceptedPacketBus } from "./acceptedPacketBus.js";
import type { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import { validateSchemaV1Packet } from "./packetValidator.js";
import type { SequenceTracker } from "./sequenceTracker.js";
import type { ObjectiveSessionManager } from "./sessionManager.js";
import type { ObjectiveTimeMapper } from "./timeMapper.js";

export const OBJECTIVE_DEVICE_PATH = "/ws/objective/device";

const POLICY_VIOLATION = 1008;
const UNSUPPORTED_DATA = 1003;
const CONNECTION_REPLACED = 4000;

interface HelloMessage {
  type: "hello";
  protocol: 1;
  device_id: string;
  boot_id: string;
  firmware: string;
  token: string;
}

interface ConnectionIdentity {
  deviceId: string;
  bootId: string;
  firmware: string;
}

export interface DeviceCredential {
  deviceId: string;
  token: string;
}

export interface DeviceGatewayDependencies {
  credential: DeviceCredential;
  deviceRegistry: ObjectiveDeviceRegistry;
  sessionManager: ObjectiveSessionManager;
  sequenceTracker: SequenceTracker;
  timeMapper: ObjectiveTimeMapper;
  acceptedPacketBus: AcceptedPacketBus;
}

export interface DeviceGatewaySnapshot {
  connectedClients: number;
  authenticatedDevices: number;
  acceptedPackets: number;
  invalidPackets: number;
  receivedBytes: number;
  latestSequence: number | null;
  sequenceGaps: number;
  duplicatePackets: number;
  acknowledgements: number;
  reconnects: number;
}

export interface DeviceGateway {
  getSnapshot(): DeviceGatewaySnapshot;
  close(): void;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function rejectUpgrade(socket: Duplex): void {
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateHello(value: unknown): HelloMessage | null {
  if (
    !isRecord(value) ||
    value.type !== "hello" ||
    value.protocol !== 1 ||
    !isNonEmptyString(value.device_id) ||
    !isNonEmptyString(value.boot_id) ||
    !isNonEmptyString(value.firmware) ||
    !isNonEmptyString(value.token)
  ) {
    return null;
  }

  return value as unknown as HelloMessage;
}

function secretsEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function attachObjectiveDeviceGateway(
  server: Server,
  dependencies: DeviceGatewayDependencies,
): DeviceGateway {
  const webSocketServer = new WebSocketServer({ noServer: true });
  const authenticatedDeviceIds = new Set<string>();
  let acceptedPackets = 0;
  let invalidPackets = 0;
  let receivedBytes = 0;
  let latestSequence: number | null = null;
  let sequenceGaps = 0;
  let duplicatePackets = 0;
  let acknowledgements = 0;
  let reconnects = 0;
  let intervalAcceptedPackets = 0;
  let intervalReceivedBytes = 0;
  let intervalAcknowledgements = 0;

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;

    try {
      pathname = new URL(request.url ?? "", "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket);
      return;
    }

    if (pathname !== OBJECTIVE_DEVICE_PATH) {
      rejectUpgrade(socket);
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };

  server.on("upgrade", handleUpgrade);

  webSocketServer.on("connection", (webSocket, request) => {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    let identity: ConnectionIdentity | undefined;
    let protocolFailed = false;
    console.info(`[objective-device] connected remote=${remoteAddress} authenticated=false`);

    const closeForProtocolFailure = (code: number, reason: string): void => {
      protocolFailed = true;
      invalidPackets += 1;
      webSocket.close(code, reason);
    };

    const sendAcknowledgement = (sequence: number): void => {
      if (webSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      webSocket.send(`ACK:${sequence}`);
      acknowledgements += 1;
      intervalAcknowledgements += 1;
    };

    webSocket.on("message", (data, isBinary) => {
      if (protocolFailed) {
        return;
      }

      const receivedAtMs = Date.now();
      const payload = rawDataToBuffer(data);
      receivedBytes += payload.byteLength;
      intervalReceivedBytes += payload.byteLength;

      if (identity === undefined) {
        if (isBinary) {
          closeForProtocolFailure(UNSUPPORTED_DATA, "text HELLO required");
          return;
        }

        let parsedHello: unknown;
        try {
          parsedHello = JSON.parse(payload.toString("utf8"));
        } catch {
          closeForProtocolFailure(POLICY_VIOLATION, "invalid HELLO");
          return;
        }

        const hello = validateHello(parsedHello);
        if (hello === null) {
          closeForProtocolFailure(POLICY_VIOLATION, "invalid HELLO");
          return;
        }

        if (
          hello.device_id !== dependencies.credential.deviceId ||
          !secretsEqual(hello.token, dependencies.credential.token)
        ) {
          closeForProtocolFailure(POLICY_VIOLATION, "authentication failed");
          return;
        }

        identity = {
          deviceId: hello.device_id,
          bootId: hello.boot_id,
          firmware: hello.firmware,
        };
        const previousConnection = dependencies.deviceRegistry.register({
          ...identity,
          webSocket,
        });

        if (authenticatedDeviceIds.has(identity.deviceId)) {
          reconnects += 1;
        } else {
          authenticatedDeviceIds.add(identity.deviceId);
        }

        if (previousConnection !== undefined && previousConnection.webSocket !== webSocket) {
          previousConnection.webSocket.close(CONNECTION_REPLACED, "replaced by newer connection");
        }

        console.info(
          `[objective-device] authenticated device_id=${identity.deviceId} boot_id=${identity.bootId} firmware=${identity.firmware}`,
        );
        webSocket.send("READY");

        const activeSession = dependencies.sessionManager.handleDeviceConnected(identity.deviceId);
        if (activeSession !== undefined) {
          webSocket.send(`START:${activeSession.session_id}`);
        }
        return;
      }

      if (!dependencies.deviceRegistry.isCurrent(identity.deviceId, webSocket)) {
        webSocket.close(CONNECTION_REPLACED, "replaced by newer connection");
        return;
      }

      if (isBinary) {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected binary frame device_id=${identity.deviceId}`);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected malformed JSON device_id=${identity.deviceId}`);
        return;
      }

      const result = validateSchemaV1Packet(parsed);
      if (!result.valid) {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected packet device_id=${identity.deviceId} reason=${result.reason}`);
        return;
      }

      const activeSession = dependencies.sessionManager.getLiveSessionForDevice(identity.deviceId);
      if (activeSession === undefined) {
        // STOP can cross a sensor frame already in the TCP/WebSocket path.
        // Reject that known, just-completed session frame without ACKing or
        // publishing it, while preserving the authenticated idle socket.
        if (
          dependencies.sessionManager.isRecentlyStoppedSessionPacket(
            identity.deviceId,
            result.packet.session_id,
            receivedAtMs,
          )
        ) {
          return;
        }
        closeForProtocolFailure(POLICY_VIOLATION, "active session required");
        return;
      }

      if (result.packet.session_id !== activeSession.session_id) {
        if (
          dependencies.sessionManager.isRecentlyStoppedSessionPacket(
            identity.deviceId,
            result.packet.session_id,
            receivedAtMs,
          )
        ) {
          return;
        }
        closeForProtocolFailure(POLICY_VIOLATION, "session mismatch");
        return;
      }

      const sequence = dependencies.sequenceTracker.classify(
        activeSession.session_id,
        identity.bootId,
        result.packet.seq,
      );

      if (sequence.status === "duplicate_stale") {
        duplicatePackets += 1;
        sendAcknowledgement(result.packet.seq);
        return;
      }

      const time = dependencies.timeMapper.map(
        activeSession.session_id,
        identity.bootId,
        result.packet.t0_us,
        receivedAtMs,
      );

      dependencies.acceptedPacketBus.publish({
        device_id: identity.deviceId,
        boot_id: identity.bootId,
        session_id: activeSession.session_id,
        received_at_ms: receivedAtMs,
        sequence_status: sequence.status,
        gap_before: sequence.gapBefore,
        epoch_id: time.epochId,
        esp_anchor_us: time.espAnchorUs,
        backend_anchor_ms: time.backendAnchorMs,
        plot_t0_ms: time.plotT0Ms,
        raw_packet: result.packet,
      });

      acceptedPackets += 1;
      intervalAcceptedPackets += 1;
      latestSequence = result.packet.seq;
      sequenceGaps += sequence.gapBefore;
      sendAcknowledgement(result.packet.seq);
    });

    webSocket.on("error", (error) => {
      const device = identity?.deviceId ?? "unauthenticated";
      console.warn(`[objective-device] socket error device_id=${device} message=${error.message}`);
    });

    webSocket.on("close", (code) => {
      if (identity !== undefined && dependencies.deviceRegistry.unregister(identity.deviceId, webSocket)) {
        dependencies.sessionManager.handleDeviceDisconnected(identity.deviceId);
      }
      const device = identity?.deviceId ?? "unauthenticated";
      console.info(`[objective-device] disconnected device_id=${device} code=${code}`);
    });
  });

  webSocketServer.on("error", (error) => {
    console.error(`[objective-device] gateway error message=${error.message}`);
  });

  const diagnosticsInterval = setInterval(() => {
    console.info(
      `[objective-device] clients=${webSocketServer.clients.size} authenticated=${dependencies.deviceRegistry.size} accepted_per_sec=${intervalAcceptedPackets} bytes_per_sec=${intervalReceivedBytes} latest_seq=${latestSequence ?? "none"} invalid_total=${invalidPackets} gaps_total=${sequenceGaps} duplicates_total=${duplicatePackets} acks_per_sec=${intervalAcknowledgements} reconnects_total=${reconnects} sessions=${dependencies.sessionManager.describeActiveSessions()}`,
    );
    intervalAcceptedPackets = 0;
    intervalReceivedBytes = 0;
    intervalAcknowledgements = 0;
  }, 1_000);
  diagnosticsInterval.unref();

  return {
    getSnapshot: () => ({
      connectedClients: webSocketServer.clients.size,
      authenticatedDevices: dependencies.deviceRegistry.size,
      acceptedPackets,
      invalidPackets,
      receivedBytes,
      latestSequence,
      sequenceGaps,
      duplicatePackets,
      acknowledgements,
      reconnects,
    }),
    close: () => {
      clearInterval(diagnosticsInterval);
      server.off("upgrade", handleUpgrade);
      webSocketServer.close();
    },
  };
}
