import { z } from "zod";

import { canonical } from "../canonical.js";
import { DriftConflict, RollbackHalted, changedLines, describe } from "../errors.js";
import type { ActionRow, ActionStatus, Journal } from "../journal/journal.js";
import type { Router } from "../proxy/routing.js";
import {
  observeState,
  planInverse,
  planRead,
  toPayload,
  resolvedRead,
  toResolvedRead,
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
  /** Below the --to floor: deliberately left alone, and listed so you can see it. */
  | "kept"
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
  /** The lines undoing anyway would write over, where that can be worked out. */
  readonly overwrites?: string;
  /**
   * Somebody changed the resource, so this is a decision rather than a fault.
   * The two ways past it -- put the resource back and replan, or overwrite the
   * change deliberately -- only make sense for these, so only these are told.
   */
  readonly conflict?: boolean;
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
  /**
   * Apply the recorded inverse even where the resource has changed since.
   *
   * Halting on drift is right by default: the alternative is silently
   * destroying whatever made the change. But a halt with no way past it is
   * only half an answer, and the person looking at the diff is the one who
   * knows whether their edit or the old value is the one worth keeping. Every
   * check still runs; this decides what happens when one of them fails.
   */
  readonly force?: boolean;
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
function classify(action: ActionRow, replanning: boolean, goAhead: boolean): Decision | undefined {
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
      //
      // A dry run passes here too. This halt exists so a second attempt does
      // not silently retry what a person already stopped, and a dry run is
      // not an attempt -- it writes nothing. Stopping on it meant the only
      // thing anyone could be shown about a conflict was the message from the
      // last try, which by then may not be true of anything.
      return replanning || goAhead
        ? undefined
        : { kind: "halt", reason: "halted here on an earlier attempt", verified: false };
    case "applied":
    case "rolling_back":
      return undefined;
  }
}

export async function rollback(options: RollbackOptions): Promise<RollbackReport> {
  const { journal, router, runId } = options;
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
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
  const floor = options.toSeq;
  const inScope = [...all]
    .filter((action) => floor === undefined || action.seq >= floor)
    .sort((a, b) => b.seq - a.seq);

  const steps: RollbackStep[] = [];
  // Everything --to excludes, reported rather than silently dropped: choosing
  // where to stop is the whole reason for the flag, and a plan that lists only
  // what it will touch shows you every part of that decision except the part
  // you are making.
  const kept = (floor === undefined ? [] : [...all].filter((action) => action.seq < floor)).sort(
    (a, b) => b.seq - a.seq,
  );
  let halted: RollbackHalt | undefined;
  /** Something permanent was stepped over, so the run is not fully reverted. */
  let leftInPlace = false;

  /**
   * Where a preview believes each resource will be by the time the plan
   * reaches it. Only ever consulted on a dry run: a real rollback reads the
   * world, because the world is what it is about to change.
   */
  const projected = new Map<string, StateObservation | typeof UNFORESEEABLE>();

  for (const action of inScope) {
    // Reset per action: forcing past one conflict says nothing about the next.
    let forcedOver: string | undefined;
    const early = classify(action, policies !== undefined, force || dryRun);
    if (early?.kind === "halt") {
      // Deliberately not written back. Every halt classify can reach was read
      // off the row's own status, so there is nothing here this rollback
      // learned. Relabelling a `pending` action as `unrecoverable` destroyed
      // the one fact that mattered about it -- that its outcome is unknown --
      // and the next attempt, seeing an unrecoverable row with no inverse,
      // stepped straight over it. Running undo twice undid more than running
      // it once, which is the last thing this command may do.
      // What it saw then, said as that. Reading the stored conflict out as
      // "actual" states a fact about a moment that has passed as a fact about
      // now, and after the conflict is resolved that reading is simply false.
      // The way on was --replan, which nothing said.
      const seen = action.error ?? "";
      const conflicted = action.status === "unrecoverable" && seen !== "";
      const detail = conflicted ? `what it saw last time, which may no longer hold:\n${seen}` : seen;
      halted = { seq: action.seq, reason: early.reason, detail, ...(conflicted ? { conflict: true } : {}) };
      steps.push({ ...describeStep(action), ...early });
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
    // resolvedRead, not inversePlan: the latter names only server, tool and
    // args, so parsing a stored read through it silently dropped absentWhen
    // and turned every read failure into "the resource is gone".
    const verifyRead = resolvedRead.safeParse(rebuilt.verify ?? action.verify);
    const recordedPost = observation.safeParse(action.postSnapshot);
    let verified = false;

    if (recordedPost.success && verifyRead.success) {
      // In a preview the inverses above this one have not been sent, so the
      // world still shows the newest write. Comparing an older action's
      // post-state against that reported drift a real undo never meets -- it
      // puts the intervening states back on its way down. So the preview
      // carries the state each planned inverse would leave, and checks against
      // that wherever it has one.
      const foreseen = dryRun
        ? projected.get(resourceKey(toResolvedRead(verifyRead.data)))
        : undefined;
      let current: StateObservation;
      try {
        current =
          foreseen !== undefined && foreseen !== UNFORESEEABLE
            ? foreseen
            : await observeState(router, toResolvedRead(verifyRead.data), signal);
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
      } else if (!force) {
        const conflict = new DriftConflict(action.seq, recordedPost.data, current);
        halted = {
          seq: action.seq,
          reason: "drift detected",
          detail: conflict.message,
          conflict: true,
          // What the person deciding actually needs: not only that it changed,
          // but which lines undoing would write over. A halt that shows the
          // first and hides the second leaves them choosing blind.
          overwrites: overwriteText(current, action),
        };
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
      } else {
        forcedOver = "the resource had changed since; that change was overwritten";
      }
    }

    // A reversible action promises evidence: a declared pre-read, and the
    // post-state captured with it. Without both there is no way to tell this
    // resource from one somebody has since edited, and writing the old value
    // back over their work is exactly the outcome every other check here
    // exists to prevent. Reverting anyway was the default; it is now a
    // decision, and `--force` is how a person makes it.
    //
    // A compensable action is a different case and must not be caught by this:
    // its policy declares no pre-read at all, so nothing was promised.
    if (!verified && action.class === "reversible" && !force) {
      const reason = unverifiedBecause(action);
      halted = {
        seq: action.seq,
        reason,
        detail:
          "Without it there is no way to tell this resource from one somebody has edited since, " +
          "so the recorded value was not written.",
        conflict: true,
      };
      steps.push({ ...describeStep(action), kind: "halt", reason, verified: false, plan });
      break;
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

    if (dryRun && verifyRead.success) {
      // What this inverse would leave behind, for the action below it to be
      // checked against. Only where that is actually knowable: an exact
      // restoration says its result is the state captured before the write.
      // A compensation says nothing about the resulting value, so the chain
      // stops rather than guessing.
      const after = intendedAfterInverse(action);
      projected.set(resourceKey(toResolvedRead(verifyRead.data)), after ?? UNFORESEEABLE);
    }

    steps.push({
      ...describeStep(action),
      kind: "revert",
      reason: verified
        ? "state matches; applying inverse"
        : (forcedOver ?? unverifiedBecause(action)),
      verified,
      plan,
      ...(rebuilt.inverse === undefined ? {} : { replanned: true }),
    });

    if (dryRun) {
      continue;
    }

    // Written before the call so a resume can tell "possibly applied" from
    // "definitely not applied", and claimed rather than announced: if this was
    // not the call that moved it out of `applied`, another rollback is already
    // working on it and sending the inverse again would apply it twice. An
    // action already in `rolling_back` is the other case -- a resume, which
    // has been checked for drift above -- and goes ahead.
    // Forcing acts on rows an earlier refusal left `unrecoverable`, so those
    // have to be claimable too or the claim is not made at all.
    // A replan is a person saying they corrected the policy and want it tried
    // again, and every check above still ran -- so an action an earlier
    // refusal left `unrecoverable` has to be claimable, or a resolved conflict
    // could never be recovered. The claim is still a claim: losing it means
    // another undo holds the action, which is a different thing entirely from
    // a status the code simply forgot to permit. Replanning authorises the
    // attempt; it does not authorise overwriting drift, which is checked
    // above and halts on its own.
    // `rolling_back` only under force. It means an inverse was sent and not
    // finished -- and nothing here can tell a process still working on it
    // from one that died holding it. Proceeding used to be automatic, so a
    // second undo starting while the first was mid-inverse sent the same
    // inverse again: harmless for a restore, a second real change to the
    // world for anything compensable. There is no lease to consult and
    // inventing a schema for one is a separate piece of work, so the honest
    // protocol is the one used everywhere else here: stop, and ask the only
    // party who can know.
    // Not `rolling_back`, under force or otherwise. Forcing past drift and
    // resuming an interrupted inverse are different intents that happen to
    // share a flag, and letting force claim a row already in `rolling_back`
    // would let two forced undos each claim it and each send -- the very
    // double-send the claim exists to stop.
    const claimable: readonly ActionStatus[] =
      force || policies !== undefined ? ["applied", "unrecoverable"] : ["applied"];
    const claimed = journal.markRollingBack(action.id, claimable);
    if (!claimed) {
      const reason =
        action.status === "rolling_back"
          ? "an inverse for this action was already sent and never finished; whether another undo still holds it cannot be told from here"
          : "another undo is already working on this action";
      halted = {
        seq: action.seq,
        reason,
        detail:
          action.status === "rolling_back"
            ? "Nothing here can tell a live owner from a dead one, and this build has no lease to consult. " +
              "Read the action with `show --live`: if the resource still shows the agent's write, the inverse never landed."
            : "",
      };
      steps[steps.length - 1] = {
        ...describeStep(action),
        kind: "halt",
        reason,
        verified,
        plan,
      };
      break;
    }
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

  for (const action of kept) {
    steps.push({
      ...describeStep(action),
      kind: "kept",
      reason: `below --to ${String(floor ?? 0)}, so it is left as it is`,
      verified: true,
    });
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

/**
 * A resource, as the read that looks at it. Two writes to one record share a
 * verify read, which is exactly what makes them the same resource.
 */
function resourceKey(read: { server: string; tool: string; args: Record<string, unknown> }): string {
  return canonical({ server: read.server, tool: read.tool, args: read.args });
}

/** A resource whose next state cannot be worked out without sending anything. */
const UNFORESEEABLE = Symbol("unforeseeable");

/** The state the recorded inverse is expected to leave behind. */
/**
 * What undoing anyway would change, from what is there now to what the
 * recorded inverse would put back. The drift message answers "what happened
 * since"; this answers "what do I lose if I go ahead", which is the question
 * somebody actually has in front of them.
 */
function overwriteText(current: StateObservation, action: ActionRow): string {
  const intended = intendedAfterInverse(action);
  if (intended === undefined) {
    return "";
  }
  return changedLines(current, intended);
}

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
