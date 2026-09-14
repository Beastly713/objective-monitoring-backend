import type { Pool } from "pg";

import type { AnalysisResult } from "../analysis/types.js";

export const MAX_ANALYSIS_RESULTS = 1_000;

export interface HistoricalAnalysisEnvelope {
  replay_start_ms: number;
  replay_end_ms: number;
  result: AnalysisResult;
}

export interface HistoricalAnalysisWindow {
  from_ms: number;
  duration_ms: number;
  to_ms: number;
  result_count: number;
  result_cap: 1_000;
  capped: boolean;
}

export interface HistoricalAnalysisResultWindow {
  window: HistoricalAnalysisWindow;
  results: HistoricalAnalysisEnvelope[];
}

interface HistoricalAnalysisRow {
  replay_start_ms: string | number;
  replay_end_ms: string | number;
  result: AnalysisResult | string;
}

const POSITIONED_ANALYSIS_CTE = `
WITH epoch_anchors AS (
  SELECT
    session_id,
    boot_id,
    epoch_id,
    MIN(esp_anchor_us) AS esp_anchor_us,
    MIN(backend_anchor_ms) AS backend_anchor_ms
  FROM objective_packets
  WHERE session_id = $1
  GROUP BY session_id, boot_id, epoch_id
),
session_origin AS (
  SELECT MIN(
    backend_anchor_ms::double precision + plot_t0_ms
  ) AS origin_wall_ms
  FROM objective_packets
  WHERE session_id = $1
),
positioned AS (
  SELECT
    r.*,
    (
      a.backend_anchor_ms::double precision
      + (r.window_start_us - a.esp_anchor_us)::double precision / 1000.0
      - o.origin_wall_ms
    ) AS replay_start_ms,
    (
      a.backend_anchor_ms::double precision
      + (r.window_end_us - a.esp_anchor_us)::double precision / 1000.0
      - o.origin_wall_ms
    ) AS replay_end_ms
  FROM objective_analysis_results r
  JOIN epoch_anchors a
    ON a.session_id = r.session_id
   AND a.boot_id = r.boot_id
   AND a.epoch_id = r.epoch_id
  CROSS JOIN session_origin o
  WHERE r.session_id = $1
    AND r.analysis_version = $4
)`;

function numberValue(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function analysisResultValue(value: AnalysisResult | string): AnalysisResult {
  return typeof value === "string" ? JSON.parse(value) as AnalysisResult : value;
}

export class ObjectiveAnalysisHistoryRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async getAnalysisWindow(
    sessionId: string,
    fromMs: number,
    durationMs: number,
    analysisVersion: string,
  ): Promise<HistoricalAnalysisResultWindow> {
    const result = await this.pool.query<HistoricalAnalysisRow>(
      `${POSITIONED_ANALYSIS_CTE}
       SELECT
         replay_start_ms,
         replay_end_ms,
         result
       FROM positioned
       WHERE replay_end_ms > $2
         AND replay_start_ms < $2 + $3
       ORDER BY replay_start_ms, epoch_id, window_start_us
       LIMIT 1001`,
      [sessionId, fromMs, durationMs, analysisVersion],
    );

    const boundedRows = result.rows.slice(0, MAX_ANALYSIS_RESULTS);
    const results = boundedRows.map<HistoricalAnalysisEnvelope>((row) => ({
      replay_start_ms: numberValue(row.replay_start_ms),
      replay_end_ms: numberValue(row.replay_end_ms),
      result: analysisResultValue(row.result),
    }));

    return {
      window: {
        from_ms: fromMs,
        duration_ms: durationMs,
        to_ms: fromMs + durationMs,
        result_count: results.length,
        result_cap: MAX_ANALYSIS_RESULTS,
        capped: result.rows.length > MAX_ANALYSIS_RESULTS,
      },
      results,
    };
  }
}
