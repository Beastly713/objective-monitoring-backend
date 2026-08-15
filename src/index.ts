import { createServer } from "node:http";

import { attachObjectiveDeviceGateway, OBJECTIVE_DEVICE_PATH } from "./objective/deviceGateway.js";

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

const host = process.env.HOST ?? DEFAULT_HOST;
const port = readPort(process.env.PORT);
const server = createServer((_request, response) => {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found\n");
});

attachObjectiveDeviceGateway(server);

server.on("error", (error) => {
  console.error(`[backend] server error message=${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address !== null ? address.port : port;
  console.info(`[backend] objective device endpoint listening at ws://${host}:${listeningPort}${OBJECTIVE_DEVICE_PATH}`);
});
