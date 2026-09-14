CREATE TABLE objective_analysis_results (
  session_id UUID NOT NULL
    REFERENCES objective_sessions (session_id)
    ON DELETE CASCADE,
  boot_id TEXT NOT NULL,
  epoch_id UUID NOT NULL,

  window_start_us BIGINT NOT NULL,
  window_end_us BIGINT NOT NULL,

  analysis_version TEXT NOT NULL,
  conversion_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,

  created_at_ms BIGINT NOT NULL,
  result JSONB NOT NULL,

  PRIMARY KEY (
    session_id,
    epoch_id,
    window_start_us,
    analysis_version
  ),

  CHECK (window_end_us = window_start_us + 10000000)
);

CREATE INDEX objective_analysis_results_session_epoch_window
  ON objective_analysis_results (
    session_id,
    epoch_id,
    window_start_us
  );
