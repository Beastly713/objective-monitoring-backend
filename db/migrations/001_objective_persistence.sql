CREATE TABLE objective_sessions (
  session_id UUID PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING', 'LIVE', 'DISCONNECTED', 'COMPLETED')),
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT NULL,
  CHECK (
    (status = 'COMPLETED' AND completed_at_ms IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at_ms IS NULL)
  )
);

CREATE UNIQUE INDEX objective_sessions_one_non_completed_per_device
  ON objective_sessions (device_id)
  WHERE status <> 'COMPLETED';

CREATE TABLE objective_packets (
  session_id UUID NOT NULL REFERENCES objective_sessions (session_id),
  boot_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  received_at_ms BIGINT NOT NULL,
  sequence_status TEXT NOT NULL CHECK (sequence_status IN ('first', 'normal', 'gap')),
  gap_before INTEGER NOT NULL CHECK (gap_before >= 0),
  epoch_id UUID NOT NULL,
  esp_anchor_us BIGINT NOT NULL,
  backend_anchor_ms BIGINT NOT NULL,
  plot_t0_ms DOUBLE PRECISION NOT NULL,
  raw_packet JSONB NOT NULL,
  PRIMARY KEY (session_id, boot_id, seq)
);

CREATE INDEX objective_packets_session_received_order
  ON objective_packets (session_id, received_at_ms, boot_id, seq);
