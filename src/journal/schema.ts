/**
 * Schema version is stored in SQLite's user_version.
 *
 * Version 2 adds `rolling_back`, written before an inverse is sent. On resume,
 * a row still in that state means the inverse may already have been applied,
 * which is the difference between a correct resume and a double-application.
 * It also adds `verify_json`, the read used to detect drift, resolved to
 * literal arguments at capture time for the same reason the inverse is (D5):
 * the manifest may have been edited by the time anyone rolls back.
 *
 * There is no migration path yet, and inventing one before anything needs
 * migrating would mean shipping untested machinery. An older journal is
 * refused with instructions instead of being silently reinterpreted.
 */
export const SCHEMA_VERSION = 2;

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
  verify_json        TEXT,
  error              TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending','gated','denied','applied','failed',
                        'rolling_back','rolled_back','unrecoverable')),
  approved_by        TEXT,
  approved_at        TEXT,
  ts                 TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS actions_by_run ON actions(run_id, seq);
`;
