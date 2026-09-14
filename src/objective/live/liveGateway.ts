import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import type { AcceptedObjectivePacket, AcceptedPacketBus } from "../acceptedPacketBus.js";
import type { AnalysisResultBus } from "../analysis/resultBus.js";
import type { AnalysisResult } from "../analysis/types.js";

const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;

export interface LiveGatewaySnapshot {
  connectedClients: number;
  deliveredPackets: number;
  droppedPackets: number;
  deliveredAnalysis?: number;
  droppedAnalysis?: number;
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
  analysisResultBusOrOptions: AnalysisResultBus | LiveGatewayOptions = {},
  options: LiveGatewayOptions = {},
): LiveGateway {
  const analysisResultBus = typeof analysisResultBusOrOptions === "object" &&
    analysisResultBusOrOptions !== null &&
    "subscribe" in analysisResultBusOrOptions
    ? analysisResultBusOrOptions as AnalysisResultBus
    : undefined;
  const liveOptions = analysisResultBus === undefined
    ? analysisResultBusOrOptions as LiveGatewayOptions
    : options;
  const maxBufferedBytes = liveOptions.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 0) {
    throw new Error("live WebSocket buffer threshold must be a non-negative integer");
  }

  const webSocketServer = new WebSocketServer({ noServer: true });
  const clientsBySession = new Map<string, Set<WebSocket>>();
  let deliveredPackets = 0;
  let droppedPackets = 0;
  let deliveredAnalysis = 0;
  let droppedAnalysis = 0;

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

  const unsubscribeAnalysis = analysisResultBus?.subscribe((result: AnalysisResult) => {
    const clients = clientsBySession.get(result.session_id);
    if (clients === undefined || clients.size === 0) {
      return;
    }

    const message = JSON.stringify({ type: "analysis_update", result });
    for (const webSocket of clients) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (webSocket.bufferedAmount >= maxBufferedBytes) {
        droppedAnalysis += 1;
        continue;
      }

      try {
        webSocket.send(message);
        deliveredAnalysis += 1;
      } catch {
        droppedAnalysis += 1;
        removeClient(result.session_id, webSocket);
      }
    }
  });

  return {
    handleUpgrade: (request, socket, head, sessionId) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        addClient(sessionId, webSocket);
      });
    },
    getSnapshot: () => {
      const snapshot: LiveGatewaySnapshot = {
        connectedClients: [...clientsBySession.values()].reduce(
        (total, clients) => total + clients.size,
        0,
        ),
        deliveredPackets,
        droppedPackets,
      };
      if (analysisResultBus !== undefined) {
        snapshot.deliveredAnalysis = deliveredAnalysis;
        snapshot.droppedAnalysis = droppedAnalysis;
      }
      return snapshot;
    },
    close: () => {
      unsubscribe();
      unsubscribeAnalysis?.();
      clientsBySession.clear();
      webSocketServer.close();
    },
  };
}
