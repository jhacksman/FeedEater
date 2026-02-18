CREATE TABLE IF NOT EXISTS raw_events (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_events_subject ON raw_events (subject);
CREATE INDEX IF NOT EXISTS idx_raw_events_received_at ON raw_events (received_at);
