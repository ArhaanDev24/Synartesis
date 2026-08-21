import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { JournalError } from "../errors.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type RunStatus = "active" | "complete" | "rolled_back" | "partial";

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
  setRunLabel(runId: string, label: string): void;
  recordPending(input: RecordPendingInput): PendingAction;
  attachSnapshot(actionId: string, snapshot: unknown): void;
  markApplied(actionId: string, outcome: AppliedOutcome): void;
  markFailed(actionId: string, error: string): void;
  markUnknown(actionId: string, error: string): void;
  markRollingBack(actionId: string): void;
  markRolledBack(actionId: string): void;
  markUnrecoverable(actionId: string, error: string): void;
  markInverseRejected(actionId: string, error: string): void;
  markUnknownInverse(actionId: string, error: string): void;
  markGated(actionId: string): void;
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
  getAction(actionId: string): ActionRow | undefined;
  listRuns(): readonly RunRow[];
  getRun(runId: string): RunRow | undefined;
  getActions(runId: string): readonly ActionRow[];
  /** The newest actions across every run, for watching work as it happens. */
  recentActions(limit: number): readonly ActionRow[];
  pragma(name: string): unknown;
  close(): void;
}

class SqliteJournal implements Journal {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new Database(path);
    // WAL so a reader (the CLI) never blocks the proxy mid-run.
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");

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
        `journal at ${path} was written by schema version ${String(existing)}, but this build expects ${String(SCHEMA_VERSION)}. Delete it or point --journal at a new file.`,
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
      return insert();
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

  markRollingBack(actionId: string): void {
    this.#run("markRollingBack", () => {
      this.#db.prepare("UPDATE actions SET status = 'rolling_back' WHERE id = ?").run(actionId);
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

  markGated(actionId: string): void {
    this.#run("markGated", () => {
      this.#db.prepare("UPDATE actions SET status = 'gated' WHERE id = ?").run(actionId);
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
      const move = this.#db.transaction((): void => {
        this.#db
          .prepare("UPDATE actions SET approved_by = ?, approved_at = ? WHERE id = ?")
          .run(granted.approvedBy ?? null, granted.approvedAt ?? null, actionId);
        this.#db
          .prepare("UPDATE actions SET status = 'denied', error = ? WHERE id = ?")
          .run(`approval was used by action ${actionId}`, granted.id);
      });
      move();
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
      const raw = this.#db
        .prepare(
          `SELECT * FROM actions
            WHERE server = ? AND tool = ? AND args_json = ?
              AND status = 'approved'
              AND approved_at >= ?
            ORDER BY approved_at DESC
            LIMIT 1`,
        )
        .get(
          query.server,
          query.tool,
          JSON.stringify(query.args ?? {}),
          query.notBefore,
        );
      return raw === undefined ? undefined : toAction(raw);
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
      this.#db.prepare("SELECT * FROM runs ORDER BY started_at, id").all().map(toRun),
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
