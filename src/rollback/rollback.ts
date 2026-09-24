import { z } from "zod";

import { canonical } from "../canonical.js";
import { IDEMPOTENCY_META_KEY } from "../idempotency.js";
import { DriftConflict, RollbackHalted, changedLines, describe } from "../errors.js";
import { labelFor, type ActionRow, type ActionStatus, type Journal, type Lease } from "../journal/journal.js";
import type { Router } from "../proxy/routing.js";
import {
  observeState,
  planInverse,
  planRead,
  toPayload,
  resolvedRead,
  toResolvedRead,
  type InversePlan,
  type ResolvedRead,
  type StateObservation,
} from "../proxy/snapshot.js";
import { createPolicyResolver } from "../manifest/match.js";
import { qualify, type Manifest } from "../manifest/types.js";


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
  /**
   * What the journal says about how this action was captured, where that
   * qualifies the line above it. The one that matters: a write whose server
   * never confirmed it, recorded because a read-back showed the change had
   * landed. `kind` and `reason` describe what the undo will do; this describes
   * how much the record it is working from can be relied on, and without it a
   * preview shows an inferred write and a confirmed one as the same line.
   */
  readonly note?: string;
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
  /**
   * Asks the rollback to stop, between actions.
   *
   * Deliberately not `signal`, and deliberately not forwarded to any upstream
   * call. `signal` aborts a request in flight, and a Ctrl-C wired to that is
   * the single best way to produce the one state this tool cannot recover
   * from: an inverse aborted after it was sent, leaving a row claimed and
   * nobody able to say whether the call landed. So an interrupt is honoured
   * where it is free to honour -- before the next action is claimed -- and
   * whatever is already in the air is allowed to finish and be recorded.
   */
  readonly interrupt?: AbortSignal;
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

/** Who holds a claim, for a person deciding what to do about it. */
function held(lease: Lease | undefined): string {
  if (lease === undefined) {
    return (
      "No lease is recorded against it, so it was claimed by a build from before leases existed " +
      "and there is no way from here to tell a live owner from a dead one. "
    );
  }
  if (lease.alive === undefined) {
    return (
      `It was claimed by process ${String(lease.pid)} on ${lease.host} at ${lease.claimedAt}, ` +
      `and this is not that machine, so whether it is still running cannot be asked from here. `
    );
  }
  return `It is held by process ${String(lease.pid)} on ${lease.host}, claimed at ${lease.claimedAt}, and that process is still running. `;
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
    case "denied": {
      // A row retired because its approval was spent on the call that actually
      // ran is stored as `denied`, and it is not a refusal. Reporting it as one
      // told a person their own yes had been a no.
      const why =
        labelFor(action) === "used"
          ? "never applied: its approval moved to the call that ran"
          : `never applied (${action.status})`;
      return { kind: "skip", reason: why, verified: true };
    }
    case "pending":
      return {
        kind: "halt",
        // Not "the process died mid-call". That is one of the ways a row ends
        // up here; a server that timed out, or answered with an error the
        // read-back could not settle, arrives in exactly the same state and is
        // told the same wrong story. The row's own error says which it was,
        // and the halt prints it directly underneath.
        reason:
          "outcome unknown: the call went out and its outcome was never established, " +
          "so whether this applied cannot be determined",
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
    // Between actions, where stopping costs nothing: everything below this
    // line is already reverted and recorded as such, and everything above it
    // is untouched. Reported as a halt rather than a quiet end, because a
    // run that stopped half way is a partial run whoever reads it next needs
    // to know about.
    if (options.interrupt?.aborted === true) {
      halted = {
        seq: action.seq,
        reason: "interrupted, so this and everything before it were left as they are",
        detail: "Nothing was half applied: the stop was taken between actions. Run undo again to carry on.",
      };
      break;
    }
    // Reset per action: forcing past one conflict says nothing about the next.
    let forcedOver: string | undefined;
    // Before its status is consulted at all. A readonly action changed
    // nothing, so whether its outcome is known says nothing about whether the
    // world needs putting back -- and classify halts on `pending`, which is
    // exactly what a read still in flight looks like. A rollback that stopped
    // because something was being *read* would be stopping on nothing.
    if (action.class === "readonly") {
      steps.push({ ...describeStep(action), kind: "skip", reason: "readonly", verified: true });
      continue;
    }

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
      // Only for the irreversible branch: the other one already quotes the row
      // and a note would say it twice. This is the worst case of the lot -- a
      // permanent action nothing confirmed, which is somebody asking whether
      // the email went out and getting a line that does not say.
      const unconfirmed = action.class === "irreversible" ? caveat(action) : undefined;
      steps.push({
        ...describeStep(action),
        kind: "permanent",
        reason,
        verified: false,
        ...(unconfirmed === undefined ? {} : { note: unconfirmed }),
      });
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
        // Not written back, for the reason the `pending` halt is not: the read
        // never happened, so nothing was learned about the resource. Recording
        // it cost twice. A row that had halted on real drift kept the diff of
        // what somebody had changed in `error`, and this overwrote it with
        // "server fs is not connected" -- so the next attempt offered the
        // three-way choice with a transport error where the evidence had been.
        // And an ordinary `applied` row came back `unrecoverable`, which makes
        // the next plain undo refuse with "halted here on an earlier attempt"
        // and demand --replan or --force: a server that was briefly down
        // escalated an undo that would have worked into one needing a flag
        // that overwrites other people's changes.
        const reason = `could not read current state to check for drift: ${describe(error)}`;
        halted = { seq: action.seq, reason, detail: "" };
        steps.push({ ...describeStep(action), kind: "halt", reason, verified: false });
        break;
      }

      if (sameState(current, recordedPost.data)) {
        verified = true;
      } else if (
        sameState(current, intendedAfterInverse(action)) ||
        // An inverse this undo sent before it was killed, whose owner is gone:
        // the resource having reached the state it produces is the inverse
        // having landed. Found by SIGKILLing undo mid-compensation: the delete
        // had gone through, and every later attempt called its absence drift.
        (action.status === "rolling_back" &&
          journal.leaseFor(action.id)?.alive === false &&
          looksUndone(current, action))
      ) {
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
      // The row usually knows why there is no post-state, and saying only the
      // consequence reads as an oversight -- as though a reading was simply
      // not taken. When the real answer is that the server never confirmed the
      // write at all, that is the first thing the person deciding needs, and
      // it was sitting one column away the whole time.
      const because = caveat(action);
      halted = {
        seq: action.seq,
        reason,
        detail:
          (because === undefined ? "" : `${because}\n\n`) +
          "Without it there is no way to tell this resource from one somebody has edited since, " +
          "so the recorded value was not written.",
        conflict: true,
      };
      steps.push({
        ...describeStep(action),
        kind: "halt",
        reason,
        verified: false,
        plan,
        ...(because === undefined ? {} : { note: because }),
      });
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

    const recordedWith = caveat(action);
    steps.push({
      ...describeStep(action),
      kind: "revert",
      reason: verified
        ? "unchanged since, so safe to put back"
        : (forcedOver ?? unverifiedBecause(action)),
      verified,
      plan,
      ...(rebuilt.inverse === undefined ? {} : { replanned: true }),
      ...(recordedWith === undefined ? {} : { note: recordedWith }),
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
    // `rolling_back` is reclaimable now, and only on evidence. Two separate
    // questions had to be answered before it could be, and the build that
    // wrote this comment could answer neither, so it refused -- permanently,
    // which meant one Ctrl-C during an undo put an action beyond every flag
    // this command has.
    //
    // Did the inverse already land? Answered above, by the world: a
    // `rolling_back` row that reaches this line has a verified drift check,
    // because the branch that halts on an unverified one runs first. Verified
    // means the resource still matches what the run left, so the inverse
    // demonstrably never applied and sending it cannot double-apply.
    //
    // Is somebody still sending it? Answered by the lease, which is what the
    // table added for this release is for. A dead owner is one whose process
    // is gone from the machine that took the claim -- asked of the operating
    // system, so there is no timeout to tune and no window in which a slow
    // undo is mistaken for a dead one. Anything less certain than "that
    // process is gone" reads as live and still halts: an unknown pid on
    // another host, a lease from a build that predates the table, or no
    // lease at all.
    //
    // Note this is not `--force`. Forcing past drift and resuming after a
    // crash are different intents that happened to share a flag, and a
    // forced claim of a live row is the double-send the claim exists to stop.
    const lease = action.status === "rolling_back" ? journal.leaseFor(action.id) : undefined;
    const abandoned = verified && lease?.alive === false;
    const claimable: readonly ActionStatus[] = [
      "applied",
      ...(force || policies !== undefined ? (["unrecoverable"] as const) : []),
      ...(abandoned ? (["rolling_back"] as const) : []),
    ];
    const claimed = journal.markRollingBack(action.id, claimable);
    if (!claimed) {
      const reason =
        action.status === "rolling_back"
          ? "an inverse for this action was already sent and never finished, and the undo that sent it is still running"
          : "another undo is already working on this action";
      halted = {
        seq: action.seq,
        reason,
        detail:
          action.status === "rolling_back"
            ? held(lease) +
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

    // An error is the server's account of the call, not the world's. A server
    // can apply the inverse and then fail before answering -- a handler that
    // crashes after its write, a gateway that times out -- and reading that
    // as "nothing was applied" left the resource already put back, and every
    // later attempt calling that drift: the undo had succeeded and could
    // never say so. Found by the randomised undo test, not by any scenario
    // anyone had written. So, where there is a read to ask, ask it.
    const landed =
      outcome.rejected && recordedPost.success && verifyRead.success
        ? await landedAnyway(router, toResolvedRead(verifyRead.data), recordedPost.data, action, signal)
        : undefined;
    if (landed !== undefined) {
      journal.markRolledBack(action.id);
      steps[steps.length - 1] = {
        ...describeStep(action),
        kind: "revert",
        reason: landed,
        verified,
        plan,
        note: `the server reported an error (${truncated(outcome.message)}), but the resource had changed as this inverse changes it`,
      };
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
    // Unrestricted, deliberately: a rollback's verdict on a run is the whole
    // point of running one, and the README has always said the session is
    // marked. The overwriting this had to be protected from is the other
    // direction -- a client disconnecting afterwards and stamping `complete`
    // over it -- and that is guarded where it happens, in proxy.ts.
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
    ? "no read declared for this tool, so drift could not be ruled out -- " +
      "a `verify` read in its policy would give it one"
    : "the post-state was never captured, so drift could not be ruled out";
}

/**
 * The row's own caveat about its capture, where it has one.
 *
 * `error` carries something different under every status -- a refusal, a
 * conflict seen on an earlier attempt, the reason an outcome is unknown -- and
 * each of those is already read out where it belongs. Under `applied` it holds
 * the warning markApplied recorded, which is the only one nothing else shows:
 * the inverse could not be built, the post-state could not be read, or the
 * write was never confirmed and was established by reading the resource back.
 */
function caveat(action: ActionRow): string | undefined {
  return action.status === "applied" && action.error !== undefined && action.error !== ""
    ? action.error
    : undefined;
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

/**
 * Whether an inverse the server said failed took effect regardless, told by
 * reading the resource straight after. A reason when it did; undefined when
 * the resource is as the run left it (a real refusal, safe to retry) or has
 * gone somewhere this inverse would not have put it (a question for a person).
 *
 * Where the inverse restores a captured value, only that value counts. A
 * compensation has no captured value to compare with -- a delete that offsets
 * a create -- so there, the resource having moved off the run's state in the
 * moment after this undo's own call is taken as that call landing.
 */
async function landedAnyway(
  router: Router,
  read: ResolvedRead,
  post: StateObservation,
  action: ActionRow,
  signal: AbortSignal,
): Promise<string | undefined> {
  let now: StateObservation;
  try {
    now = await observeState(router, read, signal);
  } catch {
    return undefined;
  }
  if (sameState(now, post)) {
    return undefined;
  }
  return looksUndone(now, action) ? "done, despite the server reporting an error" : undefined;
}

/**
 * Whether the resource is where this action's inverse would have put it.
 *
 * Exact where the inverse restores a captured value. A compensation has no
 * captured value, so only one answer is accepted for it: the resource is
 * gone, which is what a delete offsetting a create leaves and which nobody's
 * edit produces. A compensation that leaves something behind -- a refund, a
 * cancellation -- is not recognised, and halts for a person, which is the
 * safe direction to be unsure in.
 */
function looksUndone(now: StateObservation, action: ActionRow): boolean {
  const intended = intendedAfterInverse(action);
  if (intended !== undefined) {
    return sameState(now, intended);
  }
  return action.class === "compensable" && !now.present;
}

function truncated(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
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
    // Refused at the door -- an expired token on a hosted server -- is known
    // not to have been applied, which is what `rejected` means. Anything else
    // stays unknown.
    return { ok: false, rejected: upstream.classify?.(error) !== undefined, message: describe(error) };
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
