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

-- Who is currently sending an inverse for an action, so that a dead owner can
-- be told from a live one.
--
-- Without this, a row left in rolling_back by an undo that was killed could
-- never be reclaimed by anything. The claim exists to stop two undos each
-- sending the same inverse -- harmless for a restore, a second real change to
-- the world for a compensation -- and refusing was the only safe answer to
-- "is somebody still working on this?" when there was no way to ask. So an
-- action could be stranded permanently by one Ctrl-C, on the command whose
-- entire job is getting back. rollback.ts said as much in a comment: there is
-- no lease to consult, and inventing a schema for one is a separate piece of
-- work. This is that table.
--
-- Not a schema version bump, on the same argument the indexes above make: a
-- table nothing older reads changes no row and no meaning, IF NOT EXISTS makes
-- it idempotent, and an older build opening the same file afterwards neither
-- notices nor cares -- it simply goes on refusing to reclaim, which is what it
-- did before. A bump would refuse to open every journal already out there.
--
-- host and pid together, because a pid is only meaningful on the machine that
-- issued it, and journals are shared. claimed_at is for the message rather
-- than the decision: liveness is asked of the operating system, not inferred
-- from a clock, so there is no timeout to tune and no window in which a slow
-- undo is mistaken for a dead one.
CREATE TABLE IF NOT EXISTS leases (
  action_id  TEXT PRIMARY KEY REFERENCES actions(id),
  host       TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  claimed_at TEXT NOT NULL
);

-- What each session's servers were started with, so an undo can tell whether
-- it is about to act on the same thing.
--
-- An undo starts the server again, reading its environment from the client
-- entry that wraps it. If that entry has changed since -- a memory server now
-- pointed at a different file -- the undo reaches a different store from the
-- one the session wrote to, sends its inverse there, and reports success. It
-- cannot tell, because nothing recorded what the session's server was given.
--
-- The working directory, and for every variable the client entry or the policy
-- declares, its name and a keyed HMAC of its value -- never the value. These
-- are mostly tokens, and a token is a different class of secret from the file
-- contents the rest of this journal holds: it must not land here in any form
-- that gives it back. A keyed hash does not, for anything with a token's
-- entropy, even to someone holding this file. The key is kept in the journal
-- itself (the secrets table below) rather than beside it: this file is already
-- the sensitive one and already owner-only, and a second file would be one
-- more thing to protect and to lose.
--
-- Not a schema version bump, for the reason the leases table above is not.
CREATE TABLE IF NOT EXISTS secrets (
  name  TEXT PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS run_servers (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  server       TEXT NOT NULL,
  cwd          TEXT,
  fingerprints TEXT NOT NULL,
  PRIMARY KEY (run_id, server)
);

-- A person's no, kept apart from every other way a row ends up denied.
--
-- The status alone cannot say it. A spent approval is stored as denied, and so
-- is an approval the client stopped waiting for, and a desktop timeout -- some
-- of them with the approver's name on the row. So "has anybody refused this
-- exact call?" asked of the status would tell an agent that arhaan said no to
-- a call arhaan had approved. Only a person's deny writes here.
--
-- lifted_at is a person changing their mind: approving the same row afterwards
-- lifts the denial rather than leaving two contradictory answers standing.
--
-- Not a schema version bump, for the reason the tables above are not.
CREATE TABLE IF NOT EXISTS denials (
  action_id  TEXT PRIMARY KEY REFERENCES actions(id),
  server     TEXT NOT NULL,
  tool       TEXT NOT NULL,
  denied_by  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  denied_at  TEXT NOT NULL,
  lifted_at  TEXT,
  lifted_by  TEXT
);
CREATE INDEX IF NOT EXISTS denials_recent ON denials(server, tool, denied_at);

-- A person saying "stop asking me about this tool" for a while.
--
-- Before this the only way to stop being asked was to edit the policy by hand
-- and restart the client, in the middle of whatever the agent was doing. This
-- takes effect on the next call, with no reload, and runs out by itself: a
-- yes that outlives the session it was given for is a yes nobody remembers
-- giving. stopped_at is the person taking it back before then.
--
-- Not a schema version bump, for the reason the tables above are not.
CREATE TABLE IF NOT EXISTS allows (
  id          INTEGER PRIMARY KEY,
  server      TEXT NOT NULL,
  tool        TEXT NOT NULL,
  allowed_by  TEXT NOT NULL,
  allowed_at  TEXT NOT NULL,
  until       TEXT NOT NULL,
  stopped_at  TEXT,
  stopped_by  TEXT
);
CREATE INDEX IF NOT EXISTS allows_current ON allows(server, tool, until);

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

-- Partial for the same reason: findPending runs on the way in to every write,
-- looking for an earlier attempt at that exact call whose outcome was never
-- established. Those are rare, so the index holds almost nothing -- while the
-- rows it saves reading are the ones carrying the snapshots.
CREATE INDEX IF NOT EXISTS actions_unresolved ON actions(run_id, server, tool)
  WHERE status = 'pending';

-- Partial again, and for the third time the partial half is the point. The
-- session list says what each session did, which means the last action in it
-- that changed something. Without this, a run that read ten thousand files and
-- wrote once is walked backwards through all ten thousand reads to find the
-- write -- and those rows carry the snapshots.
--
-- The one of these three the planner finds on its own, so lastWrite does not
-- name it: the query's WHERE clause is this predicate exactly, and seq is the
-- ordering it asks for, so the index both filters and sorts.
CREATE INDEX IF NOT EXISTS actions_writes ON actions(run_id, seq)
  WHERE class <> 'readonly';

-- Covering, like actions_run_status and for the same reason. status asks when
-- each server was last used; without this the group-by walks the table, and
-- the table carries the snapshots, so the cost of drawing a connection list
-- grew with the size of the data those connections had touched rather than
-- with how many there were. Both columns the query reads are here, so sqlite
-- never reaches into a row -- the plan says COVERING INDEX, and it is the
-- covering half that does the work. Measured on sixty thousand actions across
-- twelve servers with two-kilobyte snapshots: 75ms to 3.5ms.
--
-- Added the same way as the ones above and for the same reason: no row
-- changes, no meaning changes, IF NOT EXISTS makes it idempotent, and an older
-- build opening the same file afterwards neither notices nor cares.
CREATE INDEX IF NOT EXISTS actions_seen ON actions(server, ts);

-- The twin of actions_undoable, and partial for the same reason. The console
-- asks, of every session, two questions: is there anything here an undo would
-- reverse, and is there anything here a person still has to decide. The first
-- is actions_undoable above; this is the second. It was being answered by
-- materialising every action in every run -- snapshots, results and inverses,
-- each through a zod parse -- eight times a second, to arrive at two integers
-- per row. Measured on forty runs of five hundred actions with two-kilobyte
-- snapshots, a hundred-megabyte journal: 62ms a frame, which on a 120ms tick
-- is half the event loop spent deciding what to draw, so keypresses queued
-- behind renders and the screen felt stuck.
--
-- The inverse_json test is in the predicate rather than in the query, so the
-- count never reaches into a row: an unrecoverable action with no inverse is
-- not a decision anybody can act on, and telling the two apart is exactly
-- what cost the frame.
--
-- Added the same way as the ones above and for the same reason: no row
-- changes, no meaning changes, IF NOT EXISTS makes it idempotent, and an older
-- build opening the same file afterwards neither notices nor cares.
CREATE INDEX IF NOT EXISTS actions_conflicted ON actions(run_id)
  WHERE status = 'unrecoverable' AND inverse_json IS NOT NULL;

-- The one query the seven above left behind, and the one running most often.
-- recentActions asks for the newest twelve rows by time, and the watch screen
-- asks it every 120ms. There was no index on ts alone -- actions_gated leads
-- with status and actions_seen leads with server, so neither can serve a bare
-- ORDER BY ts -- which left a full scan plus a temporary b-tree over a table
-- whose rows carry the snapshots, to return twelve of them. The columns are
-- in the same order the query sorts by, so sqlite walks this backwards and
-- stops at the limit. Measured on forty runs of five hundred actions with
-- two-kilobyte snapshots, a hundred-megabyte journal: 7.4ms to 0.03ms.
--
-- Added the same way as the ones above and for the same reason: no row
-- changes, no meaning changes, IF NOT EXISTS makes it idempotent, and an older
-- build opening the same file afterwards neither notices nor cares.
CREATE INDEX IF NOT EXISTS actions_recent ON actions(ts, seq);
`;
