import type { SchemaV1Packet } from "./packetValidator.js";
import type { SequenceStatus } from "./sequenceTracker.js";

export interface AcceptedObjectivePacket {
  device_id: string;
  boot_id: string;
  session_id: string;
  received_at_ms: number;
  sequence_status: Exclude<SequenceStatus, "duplicate_stale">;
  gap_before: number;
  epoch_id: string;
  esp_anchor_us: number;
  backend_anchor_ms: number;
  plot_t0_ms: number;
  raw_packet: SchemaV1Packet;
}

export type AcceptedPacketSubscriber = (packet: AcceptedObjectivePacket) => void;

export class AcceptedPacketBus {
  private readonly subscribers = new Set<AcceptedPacketSubscriber>();

  subscribe(subscriber: AcceptedPacketSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(packet: AcceptedObjectivePacket): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(packet);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown subscriber error";
        console.error(`[objective-ingestion] accepted-packet subscriber failed message=${message}`);
      }
    }
  }
}
