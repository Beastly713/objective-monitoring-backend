import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { validateSchemaV1Packet } from "./packetValidator.js";

export const OBJECTIVE_DEVICE_PATH = "/ws/objective/device";

export interface DeviceGatewaySnapshot {
  connectedClients: number;
  acceptedPackets: number;
  invalidPackets: number;
  receivedBytes: number;
  latestSequence: number | null;
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

export function attachObjectiveDeviceGateway(server: Server): DeviceGateway {
  const webSocketServer = new WebSocketServer({ noServer: true });
  let acceptedPackets = 0;
  let invalidPackets = 0;
  let receivedBytes = 0;
  let latestSequence: number | null = null;
  let intervalAcceptedPackets = 0;
  let intervalReceivedBytes = 0;

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
    console.info(`[objective-device] connected remote=${remoteAddress}`);

    webSocket.on("message", (data, isBinary) => {
      const payload = rawDataToBuffer(data);
      receivedBytes += payload.byteLength;
      intervalReceivedBytes += payload.byteLength;

      if (isBinary) {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected binary frame remote=${remoteAddress}`);
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(payload.toString("utf8"));
      } catch {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected malformed JSON remote=${remoteAddress}`);
        return;
      }

      const result = validateSchemaV1Packet(parsed);
      if (!result.valid) {
        invalidPackets += 1;
        console.warn(`[objective-device] rejected packet remote=${remoteAddress} reason=${result.reason}`);
        return;
      }

      acceptedPackets += 1;
      intervalAcceptedPackets += 1;
      latestSequence = result.packet.seq;

      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(`ACK:${result.packet.seq}`);
      }
    });

    webSocket.on("error", (error) => {
      console.warn(`[objective-device] socket error remote=${remoteAddress} message=${error.message}`);
    });

    webSocket.on("close", (code) => {
      console.info(`[objective-device] disconnected remote=${remoteAddress} code=${code}`);
    });
  });

  webSocketServer.on("error", (error) => {
    console.error(`[objective-device] gateway error message=${error.message}`);
  });

  const diagnosticsInterval = setInterval(() => {
    console.info(
      `[objective-device] clients=${webSocketServer.clients.size} accepted_per_sec=${intervalAcceptedPackets} bytes_per_sec=${intervalReceivedBytes} latest_seq=${latestSequence ?? "none"} invalid_total=${invalidPackets}`,
    );
    intervalAcceptedPackets = 0;
    intervalReceivedBytes = 0;
  }, 1_000);
  diagnosticsInterval.unref();

  return {
    getSnapshot: () => ({
      connectedClients: webSocketServer.clients.size,
      acceptedPackets,
      invalidPackets,
      receivedBytes,
      latestSequence,
    }),
    close: () => {
      clearInterval(diagnosticsInterval);
      server.off("upgrade", handleUpgrade);
      webSocketServer.close();
    },
  };
}
