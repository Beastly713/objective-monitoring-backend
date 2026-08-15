import { createServer } from "node:http";

import { AcceptedPacketBus } from "./objective/acceptedPacketBus.js";
import { attachObjectiveDeviceGateway, OBJECTIVE_DEVICE_PATH } from "./objective/deviceGateway.js";
import { ObjectiveDeviceRegistry } from "./objective/deviceRegistry.js";
import { SequenceTracker } from "./objective/sequenceTracker.js";
import { ObjectiveSessionManager } from "./objective/sessionManager.js";
import { handleObjectiveSessionRequest } from "./objective/sessionRoutes.js";
import { ObjectiveTimeMapper } from "./objective/timeMapper.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8080;

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT must be an integer from 0 to 65535; received ${JSON.stringify(value)}`);
  }

  return port;
}

function readRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be configured with a non-empty value`);
  }
  return value;
}

const host = process.env.HOST ?? DEFAULT_HOST;
const port = readPort(process.env.PORT);
const deviceId = readRequiredEnvironmentVariable("OBJECTIVE_DEVICE_ID");
const deviceToken = readRequiredEnvironmentVariable("OBJECTIVE_DEVICE_TOKEN");
const deviceRegistry = new ObjectiveDeviceRegistry();
const sessionManager = new ObjectiveSessionManager(new Set([deviceId]));
const acceptedPacketBus = new AcceptedPacketBus();

const server = createServer((request, response) => {
  void handleObjectiveSessionRequest(request, response, { sessionManager, deviceRegistry })
    .then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not Found\n");
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown request error";
      console.error(`[backend] request error message=${message}`);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      response.end(`${JSON.stringify({ error: "internal server error" })}\n`);
    });
});

attachObjectiveDeviceGateway(server, {
  credential: { deviceId, token: deviceToken },
  deviceRegistry,
  sessionManager,
  sequenceTracker: new SequenceTracker(),
  timeMapper: new ObjectiveTimeMapper(),
  acceptedPacketBus,
});

server.on("error", (error) => {
  console.error(`[backend] server error message=${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address !== null ? address.port : port;
  console.info(`[backend] objective device endpoint listening at ws://${host}:${listeningPort}${OBJECTIVE_DEVICE_PATH}`);
});
