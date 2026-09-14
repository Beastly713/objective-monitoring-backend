import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceGateway } from "./deviceGateway.js";
import type { ObjectiveDeviceRegistry } from "./deviceRegistry.js";
import type { ObjectiveAnalysisPipeline } from "./analysis/pipeline.js";
import type { ObjectiveAnalysisResultStore } from "./analysisResultStore.js";
import type { ObjectiveSessionAnalysisStore } from "./sessionAnalysisStore.js";
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
  analysisPipeline?: ObjectiveAnalysisPipeline;
  analysisResultStore?: ObjectiveAnalysisResultStore;
  sessionAnalysisStore?: ObjectiveSessionAnalysisStore;
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
  const analysisPipeline = dependencies.analysisPipeline?.getSnapshot() ?? {
    windowsEmitted: 0,
    windowsFailed: 0,
    packetProcessingFailures: 0,
    queueDepth: 0,
    queueDrops: 0,
    pendingAnalysisWindows: 0,
    lastAnalysisQueueWaitMs: null,
    lastAnalysisDurationMs: null,
    lastWindow: { session_id: null, epoch_id: null, start_ms: null, end_ms: null },
    baseline: { collection_complete: false, ready_modalities: [] },
    finalAnalysis: { session_id: null, state: "unavailable", available: false },
    pipelineHealthy: true,
    degraded: false,
  };
  const analysisStorage = dependencies.analysisResultStore?.getSnapshot() ?? {
    queueDepth: 0,
    persistedResults: 0,
    storageErrors: 0,
    storageDrops: 0,
    suppressedDuplicates: 0,
    storageHealthy: true,
    degraded: false,
  };
  const finalAnalysisStorage = dependencies.sessionAnalysisStore?.getSnapshot() ?? {
    queueDepth: 0,
    persistedResults: 0,
    storageErrors: 0,
    storageDrops: 0,
    suppressedDuplicates: 0,
    storageHealthy: true,
    degraded: false,
  };
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
    analysis: {
      windows_emitted: analysisPipeline.windowsEmitted,
      windows_failed: analysisPipeline.windowsFailed,
      packet_processing_failures: analysisPipeline.packetProcessingFailures,
      queue_depth: analysisPipeline.queueDepth,
      queue_drops: analysisPipeline.queueDrops,
      completed_windows_emitted: analysisPipeline.windowsEmitted,
      pending_analysis_windows: analysisPipeline.pendingAnalysisWindows,
      analysis_queue_depth: analysisPipeline.queueDepth,
      analysis_queue_drops: analysisPipeline.queueDrops,
      last_analysis_queue_wait_ms: analysisPipeline.lastAnalysisQueueWaitMs,
      last_analysis_duration_ms: analysisPipeline.lastAnalysisDurationMs,
      storage_queue_depth: analysisStorage.queueDepth,
      storage_errors: analysisStorage.storageErrors,
      storage_drops: analysisStorage.storageDrops,
      last_window: analysisPipeline.lastWindow,
      final_analysis: {
        ...analysisPipeline.finalAnalysis,
        persisted_results: finalAnalysisStorage.persistedResults,
        persistence_queue_depth: finalAnalysisStorage.queueDepth,
        persistence_errors: finalAnalysisStorage.storageErrors,
        persistence_drops: finalAnalysisStorage.storageDrops,
        persistence_healthy: finalAnalysisStorage.storageHealthy,
      },
      baseline: analysisPipeline.baseline,
      pipeline_healthy: analysisPipeline.pipelineHealthy,
      storage_healthy: analysisStorage.storageHealthy && finalAnalysisStorage.storageHealthy,
      degraded: analysisPipeline.degraded || analysisStorage.degraded || finalAnalysisStorage.degraded,
    },
  })}\n`);
  return true;
}
