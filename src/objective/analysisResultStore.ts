import type { Pool } from "pg";

import type { AnalysisResultBus } from "./analysis/resultBus.js";
import type { AnalysisResult } from "./analysis/types.js";

const DEFAULT_QUEUE_CAPACITY = 1_000;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface AnalysisResultStoreSnapshot {
  queueDepth: number;
  persistedResults: number;
  storageErrors: number;
  storageDrops: number;
  suppressedDuplicates: number;
  storageHealthy: boolean;
  degraded: boolean;
}

export interface AnalysisResultStoreOptions {
  queueCapacity?: number;
  retryDelayMs?: number;
}

export class ObjectiveAnalysisResultStore {
  private readonly queue: AnalysisResult[] = [];
  private readonly queueCapacity: number;
  private readonly retryDelayMs: number;
  private readonly unsubscribe: () => void;
  private workerScheduled = false;
  private workerRunning = false;
  private stopped = false;
  private persistedResults = 0;
  private storageErrors = 0;
  private storageDrops = 0;
  private suppressedDuplicates = 0;
  private storageHealthy = true;

  constructor(
    analysisResultBus: AnalysisResultBus,
    private readonly pool: Pick<Pool, "query">,
    options: AnalysisResultStoreOptions = {},
  ) {
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isInteger(this.queueCapacity) || this.queueCapacity <= 0) {
      throw new Error("analysis result persistence queue capacity must be a positive integer");
    }
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("analysis result persistence retry delay must be a non-negative integer");
    }

    this.unsubscribe = analysisResultBus.subscribe((result) => this.enqueue(result));
  }

  getSnapshot(): AnalysisResultStoreSnapshot {
    return {
      queueDepth: this.queue.length,
      persistedResults: this.persistedResults,
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

  private enqueue(result: AnalysisResult): void {
    if (this.stopped) {
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.storageDrops += 1;
      this.markDegraded("analysis result persistence queue exhausted; incoming results will be dropped");
      return;
    }

    this.queue.push(result);
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
          const inserted = await this.insertResult(this.queue[0]);
          this.queue.shift();
          if (inserted) {
            this.persistedResults += 1;
          } else {
            this.suppressedDuplicates += 1;
          }
          this.markHealthyIfRecovered();
        } catch (error) {
          this.storageErrors += 1;
          const message = error instanceof Error ? error.message : "unknown database error";
          this.markDegraded(`analysis result persistence failed message=${message}`);
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

  private async insertResult(result: AnalysisResult): Promise<boolean> {
    const queryResult = await this.pool.query(
      `INSERT INTO objective_analysis_results (
         session_id,
         boot_id,
         epoch_id,
         window_start_us,
         window_end_us,
         analysis_version,
         conversion_version,
         feature_version,
         rule_version,
         created_at_ms,
         result
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (
         session_id,
         epoch_id,
         window_start_us,
         analysis_version
       )
       DO NOTHING
       RETURNING 1`,
      [
        result.session_id,
        result.boot_id,
        result.epoch_id,
        result.window.start_us,
        result.window.end_us,
        result.analysis_version,
        result.conversion_version,
        result.feature_version,
        result.rule_version,
        result.created_at_ms,
        result,
      ],
    );
    if ((queryResult.rowCount ?? 0) > 0) {
      return true;
    }

    const existing = await this.pool.query<{
      conversion_version: string;
      feature_version: string;
      rule_version: string;
    }>(
      `SELECT conversion_version, feature_version, rule_version
       FROM objective_analysis_results
       WHERE session_id = $1
         AND epoch_id = $2
         AND window_start_us = $3
         AND analysis_version = $4`,
      [
        result.session_id,
        result.epoch_id,
        result.window.start_us,
        result.analysis_version,
      ],
    );
    const existingVersion = existing.rows[0];
    if (
      existingVersion !== undefined &&
      (
        existingVersion.conversion_version !== result.conversion_version ||
        existingVersion.feature_version !== result.feature_version ||
        existingVersion.rule_version !== result.rule_version
      )
    ) {
      throw new Error(
        `analysis version contract mismatch for session_id=${result.session_id} epoch_id=${result.epoch_id} window_start_us=${result.window.start_us}`,
      );
    }
    return false;
  }

  private markDegraded(reason: string): void {
    if (!this.storageHealthy) {
      return;
    }
    this.storageHealthy = false;
    console.warn(`[objective-analysis-storage] degraded reason=${reason}`);
  }

  private markHealthyIfRecovered(): void {
    const recoveryThreshold = Math.max(1, Math.floor(this.queueCapacity / 2));
    if (this.storageHealthy || this.queue.length >= recoveryThreshold) {
      return;
    }
    this.storageHealthy = true;
    console.info("[objective-analysis-storage] recovered");
  }
}
