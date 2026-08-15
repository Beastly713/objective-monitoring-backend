import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceGateway } from "./deviceGateway.js";
import type { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import type { LiveGateway } from "./live/liveGateway.js";
import type { ObjectivePacketStore } from "./persistence/packetStore.js";
import type { ObjectiveSessionManager } from "./sessionManager.js";

export interface ObjectiveStatusRouteDependencies {
  configuredDeviceId: string;
  deviceRegistry: ObjectiveDeviceRegistry;
  deviceGateway: DeviceGateway;
  sessionManager: ObjectiveSessionManager;
  liveGateway: LiveGateway;
  packetStore: ObjectivePacketStore;
}

export function handleObjectiveStatusRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ObjectiveStatusRouteDependencies,
): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET" || url.pathname !== "/api/objective/status") {
    return false;
  }

  const device = dependencies.deviceGateway.getSnapshot();
  const live = dependencies.liveGateway.getSnapshot();
  const storage = dependencies.packetStore.getSnapshot();
  const session = dependencies.sessionManager.getActiveSessionForDevice(
    dependencies.configuredDeviceId,
  );

  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify({
    configured_device_id: dependencies.configuredDeviceId,
    device: {
      connected: dependencies.deviceRegistry.isConnected(dependencies.configuredDeviceId),
      connected_clients: device.connectedClients,
      authenticated_devices: device.authenticatedDevices,
    },
    session: session ?? null,
    ingestion: {
      accepted_packets: device.acceptedPackets,
      invalid_packets: device.invalidPackets,
      received_bytes: device.receivedBytes,
      latest_sequence: device.latestSequence,
      sequence_gaps: device.sequenceGaps,
      duplicate_packets: device.duplicatePackets,
      acknowledgements: device.acknowledgements,
      reconnects: device.reconnects,
    },
    live: {
      connected_clients: live.connectedClients,
      delivered_packets: live.deliveredPackets,
      dropped_packets: live.droppedPackets,
    },
    storage: {
      queue_depth: storage.queueDepth,
      persisted_packets: storage.persistedPackets,
      storage_errors: storage.storageErrors,
      storage_drops: storage.storageDrops,
      suppressed_duplicates: storage.suppressedDuplicates,
      healthy: storage.storageHealthy,
      degraded: storage.degraded,
    },
  })}\n`);
  return true;
}
