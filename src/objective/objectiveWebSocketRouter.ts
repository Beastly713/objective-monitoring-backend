import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { OBJECTIVE_DEVICE_PATH, type DeviceGateway } from "./deviceGateway.js";
import type { LiveGateway } from "./live/liveGateway.js";

const LIVE_PATH_PATTERN = /^\/ws\/objective\/live\/([^/]+)$/;

export interface ObjectiveWebSocketRouterDependencies {
  deviceGateway: DeviceGateway;
  liveGateway: LiveGateway;
}

export interface ObjectiveWebSocketRouter {
  close(): void;
}

function rejectUpgrade(socket: Duplex): void {
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

export function attachObjectiveWebSocketRouter(
  server: Server,
  dependencies: ObjectiveWebSocketRouterDependencies,
): ObjectiveWebSocketRouter {
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "http://localhost").pathname;
    } catch {
      rejectUpgrade(socket);
      return;
    }

    if (pathname === OBJECTIVE_DEVICE_PATH) {
      dependencies.deviceGateway.handleUpgrade(request, socket, head);
      return;
    }

    const liveMatch = LIVE_PATH_PATTERN.exec(pathname);
    if (liveMatch !== null) {
      try {
        const sessionId = decodeURIComponent(liveMatch[1]);
        if (sessionId.length > 0) {
          dependencies.liveGateway.handleUpgrade(request, socket, head, sessionId);
          return;
        }
      } catch {
        // Reject malformed URL encoding below.
      }
    }

    rejectUpgrade(socket);
  };

  server.on("upgrade", handleUpgrade);
  return {
    close: () => server.off("upgrade", handleUpgrade),
  };
}
