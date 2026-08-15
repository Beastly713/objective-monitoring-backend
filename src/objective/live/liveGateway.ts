import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import type { AcceptedObjectivePacket, AcceptedPacketBus } from "../acceptedPacketBus.js";

const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;

export interface LiveGatewaySnapshot {
  connectedClients: number;
  deliveredPackets: number;
  droppedPackets: number;
}

export interface LiveGatewayOptions {
  maxBufferedBytes?: number;
}

export interface LiveGateway {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): void;
  getSnapshot(): LiveGatewaySnapshot;
  close(): void;
}

export function createObjectiveLiveGateway(
  acceptedPacketBus: AcceptedPacketBus,
  options: LiveGatewayOptions = {},
): LiveGateway {
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 0) {
    throw new Error("live WebSocket buffer threshold must be a non-negative integer");
  }

  const webSocketServer = new WebSocketServer({ noServer: true });
  const clientsBySession = new Map<string, Set<WebSocket>>();
  let deliveredPackets = 0;
  let droppedPackets = 0;

  const removeClient = (sessionId: string, webSocket: WebSocket): void => {
    const clients = clientsBySession.get(sessionId);
    if (clients === undefined || !clients.delete(webSocket)) {
      return;
    }
    if (clients.size === 0) {
      clientsBySession.delete(sessionId);
    }
  };

  const addClient = (sessionId: string, webSocket: WebSocket): void => {
    let clients = clientsBySession.get(sessionId);
    if (clients === undefined) {
      clients = new Set<WebSocket>();
      clientsBySession.set(sessionId, clients);
    }
    clients.add(webSocket);

    webSocket.once("close", () => removeClient(sessionId, webSocket));
    webSocket.once("error", () => {
      removeClient(sessionId, webSocket);
      webSocket.terminate();
    });

    try {
      webSocket.send(JSON.stringify({ type: "ready", session_id: sessionId }));
    } catch {
      removeClient(sessionId, webSocket);
      webSocket.close();
    }
  };

  const unsubscribe = acceptedPacketBus.subscribe((packet: AcceptedObjectivePacket) => {
    const clients = clientsBySession.get(packet.session_id);
    if (clients === undefined || clients.size === 0) {
      return;
    }

    const message = JSON.stringify({ type: "packet", packet });
    for (const webSocket of clients) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (webSocket.bufferedAmount >= maxBufferedBytes) {
        droppedPackets += 1;
        continue;
      }

      try {
        webSocket.send(message);
        deliveredPackets += 1;
      } catch {
        droppedPackets += 1;
        removeClient(packet.session_id, webSocket);
      }
    }
  });

  return {
    handleUpgrade: (request, socket, head, sessionId) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        addClient(sessionId, webSocket);
      });
    },
    getSnapshot: () => ({
      connectedClients: [...clientsBySession.values()].reduce(
        (total, clients) => total + clients.size,
        0,
      ),
      deliveredPackets,
      droppedPackets,
    }),
    close: () => {
      unsubscribe();
      clientsBySession.clear();
      webSocketServer.close();
    },
  };
}
