/**
 * Schema version is stored in SQLite's user_version. Migrations are added as
 * numbered statements; the file is the whole migration history.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  label        TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active','complete','rolled_back','partial'))
);

CREATE TABLE IF NOT EXISTS actions (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  seq                INTEGER NOT NULL,
  server             TEXT NOT NULL,
  tool               TEXT NOT NULL,
  args_json          TEXT NOT NULL,
  class              TEXT NOT NULL,
  snapshot_json      TEXT,
  post_snapshot_json TEXT,
  result_json        TEXT,
  inverse_json       TEXT,
  error              TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending','gated','denied','applied','failed','rolled_back','unrecoverable')),
  approved_by        TEXT,
  approved_at        TEXT,
  ts                 TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS actions_by_run ON actions(run_id, seq);
`;
