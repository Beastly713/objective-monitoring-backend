import type { Pool } from "pg";

import { ANALYSIS_VERSION } from "./analysis/versions.js";
import type { FinalSessionAnalysisBus, FinalSessionAnalysis } from "./analysis/sessionSynthesis.js";

const DEFAULT_QUEUE_CAPACITY = 64;
const DEFAULT_RETRY_DELAY_MS = 500;

interface FinalAnalysisRow {
  result: FinalSessionAnalysis | string;
}

export interface SessionAnalysisStoreSnapshot {
  queueDepth: number;
  persistedResults: number;
  storageErrors: number;
  storageDrops: number;
  suppressedDuplicates: number;
  storageHealthy: boolean;
  degraded: boolean;
}

export interface SessionAnalysisStoreOptions {
  queueCapacity?: number;
  retryDelayMs?: number;
}

export class ObjectiveSessionAnalysisStore {
  private readonly queue: FinalSessionAnalysis[] = [];
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
    finalAnalysisBus: FinalSessionAnalysisBus,
    private readonly pool: Pick<Pool, "query">,
    options: SessionAnalysisStoreOptions = {},
  ) {
    this.queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isInteger(this.queueCapacity) || this.queueCapacity <= 0) {
      throw new Error("final analysis persistence queue capacity must be a positive integer");
    }
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("final analysis persistence retry delay must be a non-negative integer");
    }
    this.unsubscribe = finalAnalysisBus.subscribe((analysis) => this.enqueue(analysis));
  }

  getSnapshot(): SessionAnalysisStoreSnapshot {
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

  async getFinalAnalysis(
    sessionId: string,
    analysisVersion = ANALYSIS_VERSION,
  ): Promise<FinalSessionAnalysis | undefined> {
    const result = await this.pool.query<FinalAnalysisRow>(
      `SELECT result
       FROM objective_session_analysis
       WHERE session_id = $1
         AND analysis_version = $2`,
      [sessionId, analysisVersion],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return typeof row.result === "string" ? JSON.parse(row.result) as FinalSessionAnalysis : row.result;
  }

  close(): void {
    this.stopped = true;
    this.unsubscribe();
  }

  private enqueue(analysis: FinalSessionAnalysis): void {
    if (this.stopped) {
      return;
    }
    if (this.queue.length >= this.queueCapacity) {
      this.storageDrops += 1;
      this.markDegraded("final analysis persistence queue exhausted; incoming result was dropped");
      return;
    }
    this.queue.push(analysis);
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
          this.markDegraded(`final analysis persistence failed message=${message}`);
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

  private async insertResult(analysis: FinalSessionAnalysis): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO objective_session_analysis (
         session_id, analysis_version, created_at_ms, result
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, analysis_version)
       DO NOTHING
       RETURNING 1`,
      [analysis.session_id, analysis.analysis_version, analysis.created_at_ms, analysis],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private markDegraded(reason: string): void {
    if (!this.storageHealthy) {
      return;
    }
    this.storageHealthy = false;
    console.warn(`[objective-final-analysis-storage] degraded reason=${reason}`);
  }

  private markHealthyIfRecovered(): void {
    const recoveryThreshold = Math.max(1, Math.floor(this.queueCapacity / 2));
    if (this.storageHealthy || this.queue.length >= recoveryThreshold) {
      return;
    }
    this.storageHealthy = true;
    console.info("[objective-final-analysis-storage] recovered");
  }
}
