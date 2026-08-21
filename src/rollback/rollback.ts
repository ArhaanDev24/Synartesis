import { z } from "zod";

import { canonical } from "../canonical.js";
import { DriftConflict, RollbackHalted, describe } from "../errors.js";
import type { ActionRow, Journal } from "../journal/journal.js";
import type { Router } from "../proxy/routing.js";
import {
  observeState,
  planInverse,
  planRead,
  toPayload,
  type InversePlan,
  type StateObservation,
} from "../proxy/snapshot.js";
import { createPolicyResolver } from "../manifest/match.js";
import { qualify, type Manifest } from "../manifest/types.js";

/**
 * D7. Derived from the action rather than generated, so a retried rollback
 * presents the same key for the same action. It rides in `_meta`, which is
 * advisory: a server that ignores it gives no protection, which is why the
 * journal's own state transitions are the real guard against re-applying.
 */
export const IDEMPOTENCY_META_KEY = "synartesis.dev/idempotency-key";

export type StepKind =
  | "revert"
  | "skip"
  | "already-reverted"
  /** Known to be permanent. Not an obstacle to stop at, a fact to report. */
  | "permanent"
  | "halt";

export interface RollbackStep {
  readonly seq: number;
  readonly server: string;
  readonly tool: string;
  readonly kind: StepKind;
  readonly reason: string;
  /** Whether drift could be ruled out before acting. */
  readonly verified: boolean;
  readonly plan?: InversePlan;
  /** True when the inverse came from a corrected manifest, not the journal. */
  readonly replanned?: boolean;
}

export interface RollbackHalt {
  readonly seq: number;
  readonly reason: string;
  readonly detail: string;
}

export interface RollbackReport {
  readonly runId: string;
  readonly status: "rolled_back" | "partial";
  readonly dryRun: boolean;
  readonly steps: readonly RollbackStep[];
  readonly halted?: RollbackHalt;
}

export interface RollbackOptions {
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  /** Lowest sequence to undo. Sequences below it are left in place. */
  readonly toSeq?: number;
  readonly dryRun?: boolean;
  /**
   * Re-resolve each inverse from this manifest instead of using the one
   * recorded at capture time. For recovering from a policy that was wrong when
   * the run happened: the captured pre-state and result are replayed through
   * the corrected template, so no upstream state is re-read and D5 still holds.
   */
  readonly replanWith?: Manifest;
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

const toolResult = z.looseObject({ isError: z.boolean().default(false) });

function sameState(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

interface Decision {
  readonly kind: StepKind;
  readonly reason: string;
  readonly verified: boolean;
}

/**
 * Decides what to do with one action without touching any upstream. Statuses
 * that mean "never applied" are skipped; statuses that mean "we cannot know"
 * halt, because continuing past them produces a state that is neither the
 * before nor the after (D6).
 */
function classify(action: ActionRow, replanning: boolean): Decision | undefined {
  switch (action.status) {
    case "rolled_back":
      return { kind: "already-reverted", reason: "already rolled back", verified: true };
    case "failed":
    case "denied":
      return { kind: "skip", reason: `never applied (${action.status})`, verified: true };
    case "pending":
      return {
        kind: "halt",
        reason: "outcome unknown: the process died mid-call, so whether this applied cannot be determined",
        verified: false,
      };
    case "gated":
      return { kind: "skip", reason: "never applied (awaiting approval)", verified: true };
    case "approved":
      // Somebody said yes and the agent never made the call again, so it never
      // went out. Distinct from `pending`, where it did and we cannot say what
      // happened.
      return { kind: "skip", reason: "never applied (approved, never retried)", verified: true };
    case "unrecoverable":
      // With no inverse there is nothing that could be wrongly re-applied and
      // nothing for a person to decide. An earlier run having labelled it does
      // not make a permanent action any less permanent, and halting here would
      // keep a whole run stuck behind something that can never be undone.
      if (action.inverse === undefined) {
        return undefined;
      }
      // Otherwise it is genuine uncertainty. A replan is a person saying they
      // corrected the policy and want it tried again; every check still runs,
      // so real drift halts on it a second time.
      return replanning
        ? undefined
        : { kind: "halt", reason: "previously marked unrecoverable", verified: false };
    case "applied":
    case "rolling_back":
      return undefined;
  }
}

export async function rollback(options: RollbackOptions): Promise<RollbackReport> {
  const { journal, router, runId } = options;
  const dryRun = options.dryRun ?? false;
  const signal = options.signal ?? new AbortController().signal;

  const policies = options.replanWith === undefined ? undefined : createPolicyResolver(options.replanWith);

  /**
   * Rebuilds an action's inverse and verify read from a corrected policy,
   * using only what was already captured.
   */
  const replan = (
    action: ActionRow,
  ): { inverse?: InversePlan; verify?: InversePlan; error?: string } => {
    if (policies === undefined) {
      return {};
    }
    const policy = policies.resolve(qualify(action.server, action.tool)).policy;
    const context = {
      args: action.args,
      ...(action.snapshot === undefined ? {} : { snapshot: action.snapshot }),
      ...(action.result === undefined ? {} : { result: toPayload(action.result) }),
    };
    try {
      return {
        ...(policy.inverse === undefined ? {} : { inverse: planInverse(policy.inverse, context) }),
        ...(policy.snapshot === undefined
          ? {}
          : { verify: planRead(policy.snapshot, { args: action.args }) }),
      };
    } catch (error: unknown) {
      return { error: describe(error) };
    }
  };

  const all = journal.getActions(runId);
  const inScope = [...all]
    .filter((action) => options.toSeq === undefined || action.seq >= options.toSeq)
    .sort((a, b) => b.seq - a.seq);

  const steps: RollbackStep[] = [];
  let halted: RollbackHalt | undefined;
  /** Something permanent was stepped over, so the run is not fully reverted. */
  let leftInPlace = false;

  for (const action of inScope) {
    const early = classify(action, policies !== undefined);
    if (early?.kind === "halt") {
      halted = { seq: action.seq, reason: early.reason, detail: action.error ?? "" };
      steps.push({ ...describeStep(action), ...early });
      if (!dryRun) {
        journal.markUnrecoverable(action.id, early.reason);
      }
      break;
    }
    if (early !== undefined) {
      steps.push({ ...describeStep(action), ...early });
      continue;
    }

    if (action.class === "readonly") {
      steps.push({ ...describeStep(action), kind: "skip", reason: "readonly", verified: true });
      continue;
    }

    const rebuilt = replan(action);
    const parsedPlan = inversePlan.safeParse(rebuilt.inverse ?? action.inverse);
    if (!parsedPlan.success) {
      // An applied action with nothing to undo. Nothing here is uncertain: the
      // email was sent, and no amount of stopping un-sends it. Stopping only
      // decides whether everything older stays wrong as well, and when the
      // permanent action is the newest one that means undoing nothing at all.
      // So it is reported and stepped over, and the run is marked partial.
      const approved =
        action.approvedBy === undefined ? "" : `, approved by ${action.approvedBy}`;
      const reason =
        action.class === "irreversible"
          ? `cannot be undone${approved}; left in place`
          : `no usable inverse was recorded${action.error === undefined ? "" : `: ${action.error}`}; left in place`;
      steps.push({ ...describeStep(action), kind: "permanent", reason, verified: false });
      leftInPlace = true;
      continue;
    }
    const plan = parsedPlan.data;

    // Drift check. Only possible where a pre-read was declared, which is what
    // produced both the stored verify call and the post-state.
    const verifyRead = inversePlan.safeParse(rebuilt.verify ?? action.verify);
    const recordedPost = observation.safeParse(action.postSnapshot);
    let verified = false;

    if (recordedPost.success && verifyRead.success) {
      let current: StateObservation;
      try {
        current = await observeState(router, verifyRead.data, signal);
      } catch (error: unknown) {
        const reason = `could not read current state to check for drift: ${describe(error)}`;
        halted = { seq: action.seq, reason, detail: "" };
        steps.push({ ...describeStep(action), kind: "halt", reason, verified: false });
        if (!dryRun) {
          journal.markUnrecoverable(action.id, reason);
        }
        break;
      }

      if (sameState(current, recordedPost.data)) {
        verified = true;
      } else if (sameState(current, intendedAfterInverse(action))) {
        // The inverse has already taken effect, whether by an interrupted
        // rollback or by someone doing it by hand.
        steps.push({
          ...describeStep(action),
          kind: "already-reverted",
          reason: "the resource is already in the state this inverse would produce",
          verified: true,
          plan,
        });
        if (!dryRun) {
          journal.markRolledBack(action.id);
        }
        continue;
      } else {
        const conflict = new DriftConflict(action.seq, recordedPost.data, current);
        halted = { seq: action.seq, reason: "drift detected", detail: conflict.message };
        steps.push({
          ...describeStep(action),
          kind: "halt",
          reason: "drift detected",
          verified: false,
          plan,
        });
        if (!dryRun) {
          journal.markUnrecoverable(action.id, conflict.message);
        }
        break;
      }
    }

    if (!verified && action.status === "rolling_back") {
      // An inverse was already sent for this action before something
      // interrupted us, and there is no declared read to tell us whether it
      // landed. Sending it again could double-apply, so a human decides.
      const reason =
        "an inverse was already sent before an interruption and no pre-read is declared, so whether it applied cannot be determined";
      halted = { seq: action.seq, reason, detail: action.error ?? "" };
      steps.push({ ...describeStep(action), kind: "halt", reason, verified: false, plan });
      if (!dryRun) {
        journal.markUnrecoverable(action.id, reason);
      }
      break;
    }

    steps.push({
      ...describeStep(action),
      kind: "revert",
      reason: verified ? "state matches; applying inverse" : unverifiedBecause(action),
      verified,
      plan,
      ...(rebuilt.inverse === undefined ? {} : { replanned: true }),
    });

    if (dryRun) {
      continue;
    }

    // Written before the call so a resume can tell "possibly applied" from
    // "definitely not applied".
    journal.markRollingBack(action.id);
    const outcome = await executeInverse(router, plan, action.idempotencyKey, signal);

    if (outcome.ok) {
      journal.markRolledBack(action.id);
      continue;
    }

    const halt = new RollbackHalted(action.seq, outcome.message);
    if (outcome.rejected) {
      // Nothing was applied, so the action still needs undoing. Retrying is
      // the right move once whatever refused it is healthy again.
      journal.markInverseRejected(action.id, halt.message);
    } else {
      // The row stays in rolling_back: whether the call arrived is unknown,
      // and the next attempt resolves it by reading the current state.
      journal.markUnknownInverse(action.id, halt.message);
    }
    halted = { seq: action.seq, reason: "the inverse failed", detail: halt.message };
    steps[steps.length - 1] = {
      ...describeStep(action),
      kind: "halt",
      reason: "the inverse failed",
      verified,
      plan,
    };
    break;
  }

  const completedWholeRun =
    halted === undefined && !leftInPlace && options.toSeq === undefined;
  const status = completedWholeRun ? "rolled_back" : "partial";
  if (!dryRun) {
    journal.endRun(runId, status);
  }

  return {
    runId,
    status,
    dryRun,
    steps,
    ...(halted === undefined ? {} : { halted }),
  };
}

/**
 * Why drift could not be ruled out. The two cases are not the same thing to
 * read at the moment you are deciding whether to let an unverified revert
 * proceed: one is a policy that never claimed it could check, the other is a
 * check that was supposed to happen and did not.
 */
function unverifiedBecause(action: ActionRow): string {
  return action.verify === undefined
    ? "no pre-read declared, so drift could not be ruled out"
    : "the post-state was never captured, so drift could not be ruled out";
}

function describeStep(action: ActionRow): { seq: number; server: string; tool: string } {
  return { seq: action.seq, server: action.server, tool: action.tool };
}

/** The state the recorded inverse is expected to leave behind. */
function intendedAfterInverse(action: ActionRow): StateObservation | undefined {
  return action.snapshot === undefined ? undefined : { present: true, value: action.snapshot };
}

/**
 * `rejected` separates the two failures that matter. A tool-level error means
 * the upstream processed the inverse and refused it, so nothing was applied.
 * Anything else means the call may never have arrived, and whether it applied
 * is unknown.
 */
type InverseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejected: boolean; readonly message: string };

async function executeInverse(
  router: Router,
  plan: InversePlan,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<InverseOutcome> {
  const upstream = router.byName(plan.server);
  if (upstream === undefined) {
    return { ok: false, rejected: false, message: `server ${plan.server} is not connected` };
  }

  let raw: unknown;
  try {
    raw = await upstream.client.request(
      {
        method: "tools/call",
        params: {
          name: plan.tool,
          arguments: plan.args,
          _meta: { [IDEMPOTENCY_META_KEY]: idempotencyKey },
        },
      },
      z.looseObject({}),
      { signal },
    );
  } catch (error: unknown) {
    return { ok: false, rejected: false, message: describe(error) };
  }

  const parsed = toolResult.safeParse(raw);
  if (parsed.success && parsed.data.isError) {
    return {
      ok: false,
      rejected: true,
      message: `the inverse was refused: ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true };
}
