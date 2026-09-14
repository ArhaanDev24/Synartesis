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
 * Version 3 adds `approved`: granted by a person but not yet carried out.
 * That was `pending` at first, which also means a call went out and its
 * outcome is unknown. Undo has to halt on the second and step past the first,
 * so they cannot share a name.
 *
 * There is no migration path yet, and inventing one before anything needs
 * migrating would mean shipping untested machinery. An older journal is
 * refused with instructions instead of being silently reinterpreted.
 */
export const SCHEMA_VERSION = 3;

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
                       ('pending','gated','approved','denied','applied','failed',
                        'rolling_back','rolled_back','unrecoverable')),
  approved_by        TEXT,
  approved_at        TEXT,
  ts                 TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS actions_by_run ON actions(run_id, seq);

-- Deliberately not a schema version bump. Adding an index changes no row and
-- no meaning, IF NOT EXISTS makes it idempotent, and the statement is run on
-- every open -- so a journal written months ago gains these the next time it
-- is opened, and an older build opening the same file afterwards neither
-- notices nor cares. A version bump would have been the opposite: this build
-- refuses to open a journal from a different schema, and telling somebody to
-- abandon everything an agent has ever done in order to gain an index would
-- be a poor trade.
--
-- Both of these sit in front of a person waiting. findApproval runs twice on
-- every gated call and findGated backs the gates command and the console;
-- without them each is a full scan over rows that carry the snapshots, which
-- is the largest thing in the table. Measured at fifty thousand actions with
-- two-kilobyte snapshots: 61ms to 0.01ms, and 56ms to 0.00ms.
CREATE INDEX IF NOT EXISTS actions_approved ON actions(server, tool, status, approved_at);
CREATE INDEX IF NOT EXISTS actions_gated ON actions(status, ts);

-- Covering, and that is the whole point. listRuns needs a count and three
-- status tallies per run, and without this the group-by scans the table --
-- which carries the snapshots, so the cost of listing sessions grew with the
-- size of the data those sessions touched, not with how many there were.
-- Adding status to the run index lets sqlite answer entirely from the index.
-- Measured on forty runs of five hundred actions with two-kilobyte snapshots,
-- a hundred-megabyte journal: 76ms to 2ms.
--
-- Added the same way as the two above and for the same reason: no row changes,
-- no meaning changes, IF NOT EXISTS makes it idempotent, and an older build
-- opening the same file afterwards neither notices nor cares.
CREATE INDEX IF NOT EXISTS actions_run_status ON actions(run_id, status);

-- Partial, which is what makes it small: newestUndoable asks for the newest run
-- holding something an undo would reverse, and that is a handful of rows out of
-- a table where every other row is a read, a refusal or something already put
-- back. Without it the question can only be answered by reaching into the table
-- to test inverse_json on every applied row -- and those rows carry the
-- snapshots, so the cost of the hint at the foot of a session list grew with
-- the size of the data rather than with the number of sessions, which is
-- exactly what the index above was added to stop. Measured on sixty runs of a
-- thousand actions with two-kilobyte snapshots, a 246MB journal: 56ms to
-- 0.01ms.
--
-- newestUndoable names this index with INDEXED BY, and has to: left to choose,
-- sqlite takes actions_gated for the status seek and then reads the rows. See
-- the query for why that is preferred to running ANALYZE.
--
-- Added the same way as the three above and for the same reason: no row
-- changes, no meaning changes, IF NOT EXISTS makes it idempotent, and an older
-- build opening the same file afterwards neither notices nor cares.
CREATE INDEX IF NOT EXISTS actions_undoable ON actions(run_id)
  WHERE status = 'applied' AND inverse_json IS NOT NULL;
`;
