import type { Pool } from "pg";

import type { AcceptedObjectivePacket, AcceptedPacketBus } from "../acceptedPacketBus.js";

const DEFAULT_QUEUE_CAPACITY = 1_000;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface PacketStoreSnapshot {
  queueDepth: number;
  persistedPackets: number;
  storageErrors: number;
  storageDrops: number;
  suppressedDuplicates: number;
  storageHealthy: boolean;
  degraded: boolean;
}

export interface PacketStoreOptions {
  queueCapacity?: number;
  retryDelayMs?: number;
}

export class ObjectivePacketStore {
  private readonly queue: AcceptedObjectivePacket[] = [];
  private readonly queueCapacity: number;
  private readonly retryDelayMs: number;
  private readonly unsubscribe: () => void;
  private workerScheduled = false;
  private workerRunning = false;
  private stopped = false;
  private persistedPackets = 0;
  private storageErrors = 0;
  private storageDrops = 0;
  private suppressedDuplicates = 0;
  private storageHealthy = true;

  constructor(
    acceptedPacketBus: AcceptedPacketBus,
    private readonly pool: Pick<Pool, "query">,
    options: PacketStoreOptions = {},
  ) {
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isInteger(this.queueCapacity) || this.queueCapacity <= 0) {
      throw new Error("packet persistence queue capacity must be a positive integer");
    }
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("packet persistence retry delay must be a non-negative integer");
    }

    this.unsubscribe = acceptedPacketBus.subscribe((packet) => this.enqueue(packet));
  }

  getSnapshot(): PacketStoreSnapshot {
    return {
      queueDepth: this.queue.length,
      persistedPackets: this.persistedPackets,
      storageErrors: this.storageErrors,
      storageDrops: this.storageDrops,
      suppressedDuplicates: this.suppressedDuplicates,
      storageHealthy: this.storageHealthy,
      degraded: !this.storageHealthy,
    };
  }

  close(): void {
    this.stopped = true;
    this.unsubscribe();
  }

  private enqueue(packet: AcceptedObjectivePacket): void {
    if (this.stopped) {
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.storageDrops += 1;
      this.markDegraded("persistence queue exhausted; incoming packets will be dropped from storage");
      return;
    }

    this.queue.push(packet);
    this.scheduleWorker();
  }

  private scheduleWorker(): void {
    if (this.workerScheduled || this.workerRunning || this.stopped) {
      return;
    }
    this.workerScheduled = true;
    setImmediate(() => {
      this.workerScheduled = false;
      void this.runWorker();
    });
  }

  private async runWorker(): Promise<void> {
    if (this.workerRunning || this.stopped) {
      return;
    }
    this.workerRunning = true;

    try {
      while (!this.stopped && this.queue.length > 0) {
        try {
          const inserted = await this.insertPacket(this.queue[0]);
          this.queue.shift();
          if (inserted) {
            this.persistedPackets += 1;
          } else {
            this.suppressedDuplicates += 1;
          }
          this.markHealthyIfRecovered();
        } catch (error) {
          this.storageErrors += 1;
          const message = error instanceof Error ? error.message : "unknown database error";
          this.markDegraded(`packet persistence failed message=${message}`);
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    } finally {
      this.workerRunning = false;
      if (!this.stopped && this.queue.length > 0) {
        this.scheduleWorker();
      }
    }
  }

  private async insertPacket(packet: AcceptedObjectivePacket): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO objective_packets (
         session_id, boot_id, seq, received_at_ms, sequence_status, gap_before,
         epoch_id, esp_anchor_us, backend_anchor_ms, plot_t0_ms, raw_packet
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (session_id, boot_id, seq) DO NOTHING`,
      [
        packet.session_id,
        packet.boot_id,
        packet.raw_packet.seq,
        packet.received_at_ms,
        packet.sequence_status,
        packet.gap_before,
        packet.epoch_id,
        packet.esp_anchor_us,
        packet.backend_anchor_ms,
        packet.plot_t0_ms,
        packet.raw_packet,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private markDegraded(reason: string): void {
    if (!this.storageHealthy) {
      return;
    }
    this.storageHealthy = false;
    console.warn(`[objective-storage] degraded reason=${reason}`);
  }

  private markHealthyIfRecovered(): void {
    const recoveryThreshold = Math.max(1, Math.floor(this.queueCapacity / 2));
    if (this.storageHealthy || this.queue.length >= recoveryThreshold) {
      return;
    }
    this.storageHealthy = true;
    console.info("[objective-storage] packet persistence recovered");
  }
}
