CREATE SCHEMA IF NOT EXISTS mod_slack;

CREATE TABLE IF NOT EXISTS mod_slack.slack_messages (
  id text PRIMARY KEY,
  channel_id text NOT NULL,
  slack_ts text NOT NULL,
  slack_ts_num double precision NOT NULL,
  ts timestamptz NOT NULL,
  author_id text,
  author_name text,
  text text,
  thread_ts text,
  is_thread_reply boolean NOT NULL DEFAULT false,
  reply_count int,
  payload jsonb NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slack_messages_ts_idx ON mod_slack.slack_messages (ts);
CREATE INDEX IF NOT EXISTS slack_messages_channel_ts_idx ON mod_slack.slack_messages (channel_id, ts);


