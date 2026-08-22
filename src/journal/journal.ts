import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { canonical } from "../canonical.js";
import { JournalError } from "../errors.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type RunStatus = "active" | "complete" | "rolled_back" | "partial";

/**
 * How a row says its approval was moved onto the action that ran. There is no
 * status for it -- adding one would change the schema, and an older journal
 * cannot be read under a newer schema -- so the row is denied and this is how
 * it is told apart from a person having said no.
 */
export const SPENT_APPROVAL = "approval was used by action";

export type ActionStatus =
  | "pending"
  | "gated"
  /** A person said yes; the agent has not made the call again yet. */
  | "approved"
  | "denied"
  | "applied"
  | "failed"
  | "rolling_back"
  | "rolled_back"
  | "unrecoverable";

export type ActionClass =
  | "unclassified"
  | "readonly"
  | "reversible"
  | "compensable"
  | "irreversible";

export interface RunRow {
  readonly id: string;
  readonly label: string | undefined;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly status: RunStatus;
}

export interface ActionRow {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly server: string;
  readonly tool: string;
  readonly args: unknown;
  readonly class: ActionClass;
  readonly snapshot: unknown;
  readonly postSnapshot: unknown;
  readonly result: unknown;
  readonly inverse: unknown;
  /** The read that detects drift, resolved at capture time. */
  readonly verify: unknown;
  readonly error: string | undefined;
  readonly idempotencyKey: string;
  readonly status: ActionStatus;
  readonly approvedBy: string | undefined;
  readonly approvedAt: string | undefined;
  readonly ts: string;
}

export interface RecordPendingInput {
  readonly runId: string;
  readonly server: string;
  readonly tool: string;
  readonly args: unknown;
  readonly class: ActionClass;
}

export interface AppliedOutcome {
  readonly result: unknown;
  /** Fully resolved at capture time (D5); absent when the class has no inverse. */
  readonly inverse?: unknown;
  /** The resolved read used to detect drift later. */
  readonly verify?: unknown;
  /** Post-state for drift detection; absent when the post-read could not run. */
  readonly postSnapshot?: unknown;
  /**
   * A non-fatal problem. `status` says what happened to the call; `error` says
   * what went wrong, and the two are independent: an applied call whose inverse
   * could not be built is both applied and no longer safely reversible.
   */
  readonly warning?: string;
}

export interface PendingAction {
  readonly actionId: string;
  readonly seq: number;
  readonly idempotencyKey: string;
}

const runSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  status: z.enum(["active", "complete", "rolled_back", "partial"]),
});

const actionSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  seq: z.number(),
  server: z.string(),
  tool: z.string(),
  args_json: z.string(),
  class: z.enum(["unclassified", "readonly", "reversible", "compensable", "irreversible"]),
  snapshot_json: z.string().nullable(),
  post_snapshot_json: z.string().nullable(),
  result_json: z.string().nullable(),
  inverse_json: z.string().nullable(),
  verify_json: z.string().nullable(),
  error: z.string().nullable(),
  idempotency_key: z.string(),
  status: z.enum([
    "pending",
    "gated",
    "approved",
    "denied",
    "applied",
    "failed",
    "rolling_back",
    "rolled_back",
    "unrecoverable",
  ]),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  ts: z.string(),
});

function decode(value: string | null): unknown {
  return value === null ? undefined : (JSON.parse(value) as unknown);
}

function orUndefined(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function toRun(raw: unknown): RunRow {
  const row = runSchema.parse(raw);
  return {
    id: row.id,
    label: orUndefined(row.label),
    startedAt: row.started_at,
    endedAt: orUndefined(row.ended_at),
    status: row.status,
  };
}

function toAction(raw: unknown): ActionRow {
  const row = actionSchema.parse(raw);
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    server: row.server,
    tool: row.tool,
    args: decode(row.args_json),
    class: row.class,
    snapshot: decode(row.snapshot_json),
    postSnapshot: decode(row.post_snapshot_json),
    result: decode(row.result_json),
    inverse: decode(row.inverse_json),
    verify: decode(row.verify_json),
    error: orUndefined(row.error),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    approvedBy: orUndefined(row.approved_by),
    approvedAt: orUndefined(row.approved_at),
    ts: row.ts,
  };
}

export interface Journal {
  beginRun(label: string | undefined): string;
  endRun(runId: string, status: RunStatus): void;
  /**
   * Closes a run whose proxy went away without saying so. Only a person can
   * ask for this: several proxies may share one journal, so a run left active
   * is indistinguishable from a run still being worked on, and closing one
   * that is live would make its remaining actions land in a finished run.
   *
   * Returns false when the run is already closed. Ends it at its last action
   * rather than now, since that is when anything last actually happened.
   */
  closeAbandonedRun(runId: string): boolean;
  setRunLabel(runId: string, label: string): void;
  recordPending(input: RecordPendingInput): PendingAction;
  attachSnapshot(actionId: string, snapshot: unknown): void;
  markApplied(actionId: string, outcome: AppliedOutcome): void;
  markFailed(actionId: string, error: string): void;
  markUnknown(actionId: string, error: string): void;
  /**
   * Claims an action for this rollback. Returns false when it was not this
   * call that moved it out of `applied`, which is how two undos running at
   * once are told apart from one resuming after a crash.
   */
  markRollingBack(actionId: string): boolean;
  markRolledBack(actionId: string): void;
  markUnrecoverable(actionId: string, error: string): void;
  markInverseRejected(actionId: string, error: string): void;
  markUnknownInverse(actionId: string, error: string): void;
  /**
   * `why` is kept on the row so the person deciding can see the reason
   * without the proxy running. It goes in `error`, which is already where a
   * row explains the state it is in.
   */
  markGated(actionId: string, why?: string): void;
  /** About to go out: from here on its outcome is genuinely unknown. */
  markInFlight(actionId: string): void;
  /** Returns false when the action is no longer awaiting a decision. */
  approve(actionId: string, by: string): boolean;
  deny(actionId: string, by: string | undefined, reason: string): boolean;
  /**
   * Records a refusal whatever state the row is in. `deny` is conditional
   * because an operator's decision must not overwrite one already settled; the
   * proxy needs the opposite, to record that an action it had approval for was
   * still not carried out.
   */
  settleAsDenied(actionId: string, by: string | undefined, reason: string): void;
  /**
   * Moves an approval granted in an earlier session onto the action that is
   * about to run, and spends the original so it cannot be used twice.
   */
  adoptApproval(actionId: string, granted: ActionRow): void;
  listGated(): readonly ActionRow[];
  /**
   * An approval that was granted but never carried out, for this exact call.
   * A retry after an out-of-band approval reuses that row rather than opening
   * a second one, so the approval sits on the action that actually ran.
   */
  findApproval(query: {
    server: string;
    tool: string;
    args: unknown;
    /** ISO timestamp; approvals older than this are ignored. */
    notBefore: string;
  }): ActionRow | undefined;
  /**
   * A call in this run that is already waiting for a decision. An agent told
   * to try again will often try again before anyone has answered, and a second
   * row for one decision is worse than useless: `approve` then refuses to act
   * without an id, and approving either one leaves its twin waiting for ever.
   */
  findGated(query: {
    runId: string;
    server: string;
    tool: string;
    args: unknown;
  }): ActionRow | undefined;
  getAction(actionId: string): ActionRow | undefined;
  listRuns(): readonly RunRow[];
  getRun(runId: string): RunRow | undefined;
  getActions(runId: string): readonly ActionRow[];
  /** The newest actions across every run, for watching work as it happens. */
  recentActions(limit: number): readonly ActionRow[];
  pragma(name: string): unknown;
  close(): void;
}

/**
 * Opening, with the failures named. better-sqlite3 reports "file is not a
 * database" and "unable to open database file" and leaves out which file it
 * meant, which is unhelpful precisely when the path was the mistake.
 */
function openDatabase(path: string): Database.Database {
  try {
    const db = new Database(path);
    // The pragmas, not the constructor: better-sqlite3 opens lazily, so a file
    // that is not a database is only found out on the first read.
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // WAL lets readers and one writer work at once; a second writer still has
    // to wait its turn, and without this SQLite does not wait at all -- it
    // fails immediately with "database is locked". Six agents sharing one
    // journal lost two of their calls that way, which is the arrangement this
    // tool recommends. Writes here are tiny, so the wait is milliseconds; the
    // five seconds is the ceiling before something is genuinely wedged.
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("not a database")) {
      throw new JournalError(
        "open",
        `${path} is not a Synartesis journal. Point --journal at a journal, or at a new file to start one.`,
      );
    }
    throw new JournalError("open", `the journal at ${path} could not be opened: ${detail}`);
  }
}

class SqliteJournal implements Journal {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    // Opening is the one step a user is most likely to get wrong -- a typo in
    // --journal, a path that is a directory, a file that is something else
    // entirely -- and it was the one step whose errors went out raw, as a bare
    // "file is not a database" naming neither the file nor the tool.
    // WAL so a reader (the CLI) never blocks the proxy mid-run.
    this.#db = openDatabase(path);

    const existing = z.number().parse(this.#db.pragma("user_version", { simple: true }));
    const populated =
      z
        .object({ count: z.number() })
        .parse(
          this.#db
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
            .get(),
        ).count > 0;
    if (populated && existing !== SCHEMA_VERSION) {
      // Reinterpreting an older journal under a newer schema would risk
      // reading a rollback state that was never written.
      throw new JournalError(
        "open",
        `journal at ${path} was written by schema version ${String(existing)}, but this build expects ${String(SCHEMA_VERSION)}. ` +
          `Point --journal at a new file to carry on, and keep this one: everything an agent did is in it. Delete it only once you are sure you do not want that history.`,
      );
    }

    this.#db.exec(SCHEMA_SQL);
    this.#db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
  }

  beginRun(label: string | undefined): string {
    const id = crypto.randomUUID();
    this.#run("beginRun", () => {
      this.#db
        .prepare("INSERT INTO runs (id, label, started_at, status) VALUES (?, ?, ?, 'active')")
        .run(id, label ?? null, new Date().toISOString());
    });
    return id;
  }

  endRun(runId: string, status: RunStatus): void {
    this.#run("endRun", () => {
      this.#db
        .prepare("UPDATE runs SET ended_at = ?, status = ? WHERE id = ?")
        .run(new Date().toISOString(), status, runId);
    });
  }

  closeAbandonedRun(runId: string): boolean {
    return this.#run("closeAbandonedRun", () => {
      const last = z
        .object({ ts: z.string().nullable() })
        .parse(
          this.#db
            .prepare("SELECT MAX(ts) AS ts FROM actions WHERE run_id = ?")
            .get(runId) ?? { ts: null },
        ).ts;
      const result = this.#db
        .prepare("UPDATE runs SET ended_at = ?, status = 'complete' WHERE id = ? AND status = 'active'")
        .run(last ?? new Date().toISOString(), runId);
      return result.changes === 1;
    });
  }

  setRunLabel(runId: string, label: string): void {
    this.#run("setRunLabel", () => {
      this.#db.prepare("UPDATE runs SET label = ? WHERE id = ?").run(label, runId);
    });
  }

  recordPending(input: RecordPendingInput): PendingAction {
    return this.#run("recordPending", () => {
      const insert = this.#db.transaction((): PendingAction => {
        const next = this.#db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM actions WHERE run_id = ?")
          .get(input.runId);
        const seq = z.object({ seq: z.number() }).parse(next).seq;
        const actionId = crypto.randomUUID();
        // Derived rather than random: a retried rollback must present the same
        // key for the same action, which is the whole point of D7.
        const idempotencyKey = `${input.runId}:${String(seq)}`;

        this.#db
          .prepare(
            `INSERT INTO actions
               (id, run_id, seq, server, tool, args_json, class, idempotency_key, status, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            actionId,
            input.runId,
            seq,
            input.server,
            input.tool,
            JSON.stringify(input.args ?? {}),
            input.class,
            idempotencyKey,
            new Date().toISOString(),
          );

        return { actionId, seq, idempotencyKey };
      });
      // immediate, not deferred. This reads the highest seq and then inserts,
      // and SQLite will not upgrade a read lock to a write one while another
      // writer has committed in between -- it returns "database is locked"
      // straight away, and busy_timeout does not apply to that case. Taking
      // the write lock up front is what makes the wait actually happen.
      return insert.immediate();
    });
  }

  attachSnapshot(actionId: string, snapshot: unknown): void {
    this.#run("attachSnapshot", () => {
      this.#db
        .prepare("UPDATE actions SET snapshot_json = ? WHERE id = ?")
        .run(JSON.stringify(snapshot ?? null), actionId);
    });
  }

  markApplied(actionId: string, outcome: AppliedOutcome): void {
    this.#run("markApplied", () => {
      this.#db
        .prepare(
          `UPDATE actions
             SET status = 'applied',
                 result_json = ?,
                 inverse_json = ?,
                 verify_json = ?,
                 post_snapshot_json = ?,
                 error = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(outcome.result ?? null),
          outcome.inverse === undefined ? null : JSON.stringify(outcome.inverse),
          outcome.verify === undefined ? null : JSON.stringify(outcome.verify),
          outcome.postSnapshot === undefined ? null : JSON.stringify(outcome.postSnapshot),
          outcome.warning ?? null,
          actionId,
        );
    });
  }

  markFailed(actionId: string, error: string): void {
    this.#run("markFailed", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'failed', error = ? WHERE id = ?")
        .run(error, actionId);
    });
  }

  /**
   * The call was interrupted, so whether the upstream applied it is genuinely
   * unknown. The row deliberately stays `pending`: recording it as failed
   * would assert something we cannot know, and section 3.1 wants exactly this
   * case surfaced rather than resolved by guesswork.
   */
  markUnknown(actionId: string, error: string): void {
    this.#run("markUnknown", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'pending', error = ? WHERE id = ?")
        .run(error, actionId);
    });
  }

  markRollingBack(actionId: string): boolean {
    return this.#run("markRollingBack", () => {
      // Conditional, so the transition is a claim rather than an announcement.
      // Two rollbacks of one run both read the action as applied and both sent
      // its inverse; for a compensating call rather than a restore, that is a
      // second real change to the world.
      const result = this.#db
        .prepare("UPDATE actions SET status = 'rolling_back' WHERE id = ? AND status = 'applied'")
        .run(actionId);
      return result.changes === 1;
    });
  }

  markRolledBack(actionId: string): void {
    this.#run("markRolledBack", () => {
      this.#db.prepare("UPDATE actions SET status = 'rolled_back' WHERE id = ?").run(actionId);
    });
  }

  /**
   * The upstream processed the inverse and refused it, so nothing was applied
   * and the action still needs undoing. Distinct from `unrecoverable`, which
   * means a human has to look: a refused inverse may simply be a server that
   * was briefly unwell, and rollback is expected to be retried (D7).
   */
  markInverseRejected(actionId: string, error: string): void {
    this.#run("markInverseRejected", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'applied', error = ? WHERE id = ?")
        .run(error, actionId);
    });
  }

  /**
   * The inverse may or may not have reached the upstream. The row stays in
   * `rolling_back` so the next attempt knows to resolve it by reading the
   * current state rather than assuming either way.
   */
  markUnknownInverse(actionId: string, error: string): void {
    this.#run("markUnknownInverse", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'rolling_back', error = ? WHERE id = ?")
        .run(error, actionId);
    });
  }

  markGated(actionId: string, why?: string): void {
    this.#run("markGated", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'gated', error = ? WHERE id = ?")
        .run(why ?? null, actionId);
    });
  }

  markInFlight(actionId: string): void {
    this.#run("markInFlight", () => {
      this.#db.prepare("UPDATE actions SET status = 'pending' WHERE id = ?").run(actionId);
    });
  }

  /**
   * Conditional on the row still being gated, so a decision made at the same
   * moment as a timeout resolves one way rather than both.
   */
  approve(actionId: string, by: string): boolean {
    return this.#run("approve", () => {
      const result = this.#db
        .prepare(
          `UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ?, error = NULL
           WHERE id = ? AND status = 'gated'`,
        )
        .run(by, new Date().toISOString(), actionId);
      return result.changes === 1;
    });
  }

  deny(actionId: string, by: string | undefined, reason: string): boolean {
    return this.#run("deny", () => {
      const result = this.#db
        .prepare(
          `UPDATE actions SET status = 'denied', approved_by = ?, approved_at = ?, error = ?
           WHERE id = ? AND status = 'gated'`,
        )
        .run(by ?? null, new Date().toISOString(), reason, actionId);
      return result.changes === 1;
    });
  }

  settleAsDenied(actionId: string, by: string | undefined, reason: string): void {
    this.#run("settleAsDenied", () => {
      this.#db
        .prepare(
          "UPDATE actions SET status = 'denied', approved_by = ?, approved_at = ?, error = ? WHERE id = ?",
        )
        .run(by ?? null, new Date().toISOString(), reason, actionId);
    });
  }

  adoptApproval(actionId: string, granted: ActionRow): void {
    this.#run("adoptApproval", () => {
      // Also immediate: adopting an approval reads one row and writes two.
      const move = this.#db.transaction((): void => {
        this.#db
          .prepare("UPDATE actions SET approved_by = ?, approved_at = ? WHERE id = ?")
          .run(granted.approvedBy ?? null, granted.approvedAt ?? null, actionId);
        this.#db
          .prepare("UPDATE actions SET status = 'denied', error = ? WHERE id = ?")
          .run(`${SPENT_APPROVAL} ${actionId}`, granted.id);
      });
      move.immediate();
    });
  }

  listGated(): readonly ActionRow[] {
    return this.#run("listGated", () =>
      this.#db.prepare("SELECT * FROM actions WHERE status = 'gated' ORDER BY ts").all().map(toAction),
    );
  }

  findApproval(query: {
    server: string;
    tool: string;
    args: unknown;
    notBefore: string;
  }): ActionRow | undefined {
    return this.#run("findApproval", () => {
      // Not scoped to one run: people restart their client, and an approval
      // stranded in a dead session is the same as no approval at all. Bounded
      // by time and by being single use instead, so a decision made this
      // morning cannot silently authorise the same call tomorrow.
      const rows = this.#db
        .prepare(
          `SELECT * FROM actions
            WHERE server = ? AND tool = ?
              AND status = 'approved'
              AND approved_at >= ?
            ORDER BY approved_at DESC`,
        )
        .all(query.server, query.tool, query.notBefore)
        .map(toAction);
      // Matched on meaning rather than on spelling: an agent that re-emits the
      // same arguments in a different key order is making the same call, and
      // sending a person back to approve what they just approved would teach
      // them to stop reading what they are approving.
      const wanted = canonical(query.args ?? {});
      return rows.find((row) => canonical(row.args) === wanted);
    });
  }

  findGated(query: {
    runId: string;
    server: string;
    tool: string;
    args: unknown;
  }): ActionRow | undefined {
    return this.#run("findGated", () => {
      // Scoped to the run, unlike an approval: a gated row belongs to the run
      // that raised it, and adopting one from a dead session would hang the
      // decision on an action that undoing this run would never reach.
      const rows = this.#db
        .prepare(
          `SELECT * FROM actions
            WHERE run_id = ? AND server = ? AND tool = ? AND status = 'gated'
            ORDER BY seq`,
        )
        .all(query.runId, query.server, query.tool)
        .map(toAction);
      const wanted = canonical(query.args ?? {});
      return rows.find((row) => canonical(row.args) === wanted);
    });
  }

  getAction(actionId: string): ActionRow | undefined {
    return this.#run("getAction", () => {
      const raw = this.#db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId);
      return raw === undefined ? undefined : toAction(raw);
    });
  }

  markUnrecoverable(actionId: string, error: string): void {
    this.#run("markUnrecoverable", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'unrecoverable', error = ? WHERE id = ?")
        .run(error, actionId);
    });
  }

  listRuns(): readonly RunRow[] {
    return this.#run("listRuns", () =>
      // Insertion order as the tiebreak, not the id. Two runs that start in
      // the same millisecond have equal timestamps, and a uuid orders them at
      // random -- which decides which one `show` and `undo` mean by "the most
      // recent", so the answer has to come from when they were written rather
      // than from what they happen to be called.
      this.#db.prepare("SELECT * FROM runs ORDER BY started_at, rowid").all().map(toRun),
    );
  }

  getRun(runId: string): RunRow | undefined {
    return this.#run("getRun", () => {
      const raw = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
      return raw === undefined ? undefined : toRun(raw);
    });
  }

  getActions(runId: string): readonly ActionRow[] {
    return this.#run("getActions", () =>
      this.#db
        .prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY seq")
        .all(runId)
        .map(toAction),
    );
  }

  recentActions(limit: number): readonly ActionRow[] {
    return this.#run("recentActions", () =>
      this.#db
        .prepare("SELECT * FROM actions ORDER BY ts DESC, seq DESC LIMIT ?")
        .all(limit)
        .map(toAction)
        .reverse(),
    );
  }

  pragma(name: string): unknown {
    return this.#db.pragma(name, { simple: true });
  }

  close(): void {
    this.#db.close();
  }

  /**
   * A failed journal write means the record of what the agent did is
   * incomplete. It is never swallowed and never merely logged.
   */
  #run<T>(operation: string, body: () => T): T {
    try {
      return body();
    } catch (error: unknown) {
      throw new JournalError(operation, error);
    }
  }
}

export interface OpenOptions {
  /**
   * Refuse to create the file. Reading commands should say a journal is not
   * there rather than conjure an empty one and report that nothing happened,
   * which looks identical to a real answer and leaves a stray file behind.
   */
  readonly mustExist?: boolean;
}

export function openJournal(path: string, options: OpenOptions = {}): Journal {
  if (options.mustExist === true && path !== ":memory:" && !existsSync(path)) {
    throw new JournalError("open", `there is no journal at ${path}`);
  }
  return new SqliteJournal(path);
}

/**
 * A row denied because its approval was spent on the call that actually ran is
 * not a refusal, and `watch` reported one as "denied" moments after the person
 * had said yes and the call had gone through.
 */
export function labelFor(action: ActionRow): string {
  return action.status === "denied" && (action.error ?? "").startsWith(SPENT_APPROVAL)
    ? "used"
    : action.status;
}

export function wasRefused(action: ActionRow): boolean {
  return action.status === "unrecoverable" || labelFor(action) === "denied";
}
