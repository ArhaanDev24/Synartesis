import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { JournalError } from "../errors.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type RunStatus = "active" | "complete" | "rolled_back" | "partial";

export type ActionStatus =
  | "pending"
  | "gated"
  | "denied"
  | "applied"
  | "failed"
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
  error: z.string().nullable(),
  idempotency_key: z.string(),
  status: z.enum([
    "pending",
    "gated",
    "denied",
    "applied",
    "failed",
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
  recordPending(input: RecordPendingInput): PendingAction;
  markApplied(actionId: string, result: unknown): void;
  markFailed(actionId: string, error: string): void;
  listRuns(): readonly RunRow[];
  getRun(runId: string): RunRow | undefined;
  getActions(runId: string): readonly ActionRow[];
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
             VALUES (?, ?, ?, ?, ?, ?, 'unclassified', ?, 'pending', ?)`,
          )
          .run(
            actionId,
            input.runId,
            seq,
            input.server,
            input.tool,
            JSON.stringify(input.args ?? {}),
            idempotencyKey,
            new Date().toISOString(),
          );

        return { actionId, seq, idempotencyKey };
      });
      return insert();
    });
  }

  markApplied(actionId: string, result: unknown): void {
    this.#run("markApplied", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'applied', result_json = ? WHERE id = ?")
        .run(JSON.stringify(result ?? null), actionId);
    });
  }

  markFailed(actionId: string, error: string): void {
    this.#run("markFailed", () => {
      this.#db
        .prepare("UPDATE actions SET status = 'failed', error = ? WHERE id = ?")
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

export function openJournal(path: string): Journal {
  return new SqliteJournal(path);
}
