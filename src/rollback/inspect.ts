import { z } from "zod";

import { canonical } from "../canonical.js";
import { changedLines, describe } from "../errors.js";
import type { ActionRow, Journal } from "../journal/journal.js";
import type { Router } from "../proxy/routing.js";
import { observeState, type InversePlan, type StateObservation } from "../proxy/snapshot.js";

/**
 * Whether a session can still be undone, asked without undoing anything.
 *
 * The one thing this could not tell you was the thing people most wanted to
 * know: has somebody edited that file since? Nothing an agent does not do
 * comes through the proxy, so a person editing a file by hand is invisible
 * here -- and it stayed invisible until you tried an undo and it refused. You
 * found out about a conflict by walking into it.
 *
 * The state was always there to compare against; nothing had ever read it
 * except a rollback that was already committed to acting. This reads it and
 * stops. Nothing is written, no inverse is sent, and no row changes status --
 * `undo --dry-run` is the closest thing there was, and it halts at the first
 * conflict, so a session with five writes told you about one of them.
 */

export type Condition =
  /** Still exactly as the run left it, so the recorded undo would apply. */
  | "unchanged"
  /** Somebody changed it after the run. Undoing would write over them. */
  | "changed"
  /** Already back to what it was, by an undo or by hand. */
  | "restored"
  /** An earlier write to the same thing; the newest one is what undo checks. */
  | "superseded"
  /** Never applied, so there is nothing of it in the world to look at. */
  | "not-applied"
  /** No pre-read was declared, so there is nothing to compare against. */
  | "unknowable";

export interface Resource {
  readonly seq: number;
  readonly server: string;
  readonly tool: string;
  readonly condition: Condition;
  /** Why, in a few words, where the condition alone does not say it. */
  readonly note?: string;
  /** What changed, as lines, for `changed`. */
  readonly diff?: string;
}

export interface Inspection {
  readonly runId: string;
  readonly resources: readonly Resource[];
}

export interface InspectOptions {
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

const inversePlan = z.object({
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});

const observation = z.union([
  z.object({ present: z.literal(true), value: z.unknown() }),
  z.object({ present: z.literal(false) }),
]);

function sameState(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** The state the recorded undo would produce, which is the pre-write one. */
function intended(action: ActionRow): StateObservation | undefined {
  return action.snapshot === undefined ? undefined : { present: true, value: action.snapshot };
}

/**
 * What identifies the thing an action touched: the read that looks at it.
 *
 * Two writes to one file share a verify read, and only the newest of them can
 * match the world -- undoing walks backwards, so each older one is checked
 * against a state the one above it has just restored. Reporting them all
 * against the world as it is now would call every write but the last one
 * "changed", which is the opposite of true.
 */
function resourceKey(plan: InversePlan): string {
  return canonical({ server: plan.server, tool: plan.tool, args: plan.args });
}

const SETTLED: ReadonlySet<string> = new Set(["failed", "denied", "gated", "approved"]);

export async function inspect(options: InspectOptions): Promise<Inspection> {
  const { journal, router, runId } = options;
  const signal = options.signal ?? new AbortController().signal;
  const actions = journal.getActions(runId);
  const resources: Resource[] = [];
  const seen = new Set<string>();

  // Newest first, so the write that owns the current state is the one asked
  // about. The list is turned back the right way up before returning: reading
  // order is what a person wants, even when checking order is not.
  for (const action of [...actions].reverse()) {
    const at = { seq: action.seq, server: action.server, tool: action.tool };

    if (action.class === "readonly") {
      continue;
    }
    if (SETTLED.has(action.status)) {
      resources.push({ ...at, condition: "not-applied", note: action.status });
      continue;
    }
    if (action.status === "rolled_back") {
      resources.push({ ...at, condition: "restored" });
      continue;
    }

    const verify = inversePlan.safeParse(action.verify);
    const post = observation.safeParse(action.postSnapshot);
    if (!verify.success || !post.success) {
      resources.push({
        ...at,
        condition: "unknowable",
        note: action.inverse === undefined ? "nothing was captured to restore" : "no pre-read was declared",
      });
      continue;
    }

    const key = resourceKey(verify.data);
    if (seen.has(key)) {
      resources.push({ ...at, condition: "superseded" });
      continue;
    }
    seen.add(key);

    let current: StateObservation;
    try {
      current = await observeState(router, verify.data, signal);
    } catch (error: unknown) {
      // A resource that cannot be read is not a resource that has changed.
      // Saying so is the whole point of a command that only looks.
      resources.push({ ...at, condition: "unknowable", note: `could not read it: ${describe(error)}` });
      continue;
    }

    if (sameState(current, post.data)) {
      resources.push({ ...at, condition: "unchanged" });
      continue;
    }
    const back = intended(action);
    if (back !== undefined && sameState(current, back)) {
      resources.push({ ...at, condition: "restored", note: "put back outside this journal" });
      continue;
    }
    resources.push({
      ...at,
      condition: "changed",
      diff: changedLines(post.data, current),
    });
  }

  return { runId, resources: resources.reverse() };
}

/** The one-line verdict for a whole session, in the words somebody would use. */
export function verdict(inspection: Inspection): string {
  const changed = inspection.resources.filter((r) => r.condition === "changed").length;
  const undoable = inspection.resources.filter((r) => r.condition === "unchanged").length;
  if (changed > 0) {
    return `${String(changed)} changed since this ran; undoing would write over ${changed === 1 ? "it" : "them"}`;
  }
  if (undoable > 0) {
    return `nothing has been touched since; all ${String(undoable)} would undo cleanly`;
  }
  return "nothing here is still applied";
}
