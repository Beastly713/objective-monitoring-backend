CREATE TABLE objective_session_analysis (
  session_id UUID NOT NULL
    REFERENCES objective_sessions (session_id)
    ON DELETE CASCADE,
  analysis_version TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  result JSONB NOT NULL,

  PRIMARY KEY (session_id, analysis_version)
);

CREATE INDEX objective_session_analysis_session_created
  ON objective_session_analysis (session_id, created_at_ms DESC);
