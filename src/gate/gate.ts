import type { Journal } from "../journal/journal.js";

export interface GateRequest {
  readonly actionId: string;
  readonly runId: string;
  readonly seq: number;
  readonly server: string;
  readonly tool: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
}

export type GateDecision =
  | { readonly approved: true; readonly by: string }
  | {
      readonly approved: false;
      readonly by?: string;
      readonly reason: string;
      /**
       * Nobody has refused; the request is simply waiting for a person. The
       * agent should tell its user how to approve and then try again.
       */
      readonly awaiting?: boolean;
    };

export interface Gate {
  decide(request: GateRequest): Promise<GateDecision>;
}

export const DEFAULT_GATE_TIMEOUT_MS = 300_000;

/**
 * Records the request and refuses immediately, rather than holding the call
 * open until someone answers.
 *
 * Holding it open cannot work against a real client. Measured against Claude
 * Code: a suspended call sat for the full five minutes while the client had
 * long since reported it as failed, and any approval in that gap would have
 * sent something the agent had already said it had not sent. Every useful
 * window for a person to notice, open a terminal and decide is longer than a
 * client will wait, so the two cannot be reconciled by choosing a better
 * timeout. Refusing at once and letting the agent retry removes the conflict
 * instead of tuning it.
 */
export function createRetryGate(journal: Journal, approveWith = "synartesis"): Gate {
  return {
    decide(request: GateRequest): Promise<GateDecision> {
      journal.markGated(request.actionId);
      return Promise.resolve({
        approved: false,
        awaiting: true,
        reason:
          `it is waiting for a person to approve it. ` +
          `Ask them to run: ${approveWith} approve ${request.actionId.slice(0, 8)}` +
          `  --- then make this exact call again.`,
      });
    },
  };
}

export interface JournalGateOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /** Where the operator is told that something is waiting. */
  readonly notify?: (request: GateRequest) => void;
}

/**
 * Approval arrives out of band, through the journal, rather than from a prompt
 * on stdin.
 *
 * The proxy speaks MCP over stdin and stdout: that pipe carries protocol
 * frames, so there is nothing to prompt on. A prompt written to the
 * controlling terminal would work only when one exists, which rules out every
 * desktop client. The journal is already a transactional, WAL-mode, multi
 * process store, so `synartesis approve` in any other terminal is the natural
 * channel, and it behaves identically wherever the proxy was launched from.
 */
export function createJournalGate(journal: Journal, options: JournalGateOptions = {}): Gate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 100;
  const notify = options.notify ?? ((): void => undefined);

  return {
    async decide(request: GateRequest): Promise<GateDecision> {
      journal.markGated(request.actionId);
      notify(request);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const action = journal.getAction(request.actionId);
        if (action === undefined) {
          return { approved: false, reason: "the journal entry disappeared while awaiting approval" };
        }
        if (action.status !== "gated") {
          return action.status === "denied"
            ? {
                approved: false,
                ...(action.approvedBy === undefined ? {} : { by: action.approvedBy }),
                reason: action.error ?? "denied",
              }
            : { approved: true, by: action.approvedBy ?? "unknown" };
        }

        if (request.signal.aborted) {
          journal.deny(request.actionId, undefined, "the client disconnected before a decision");
          return { approved: false, reason: "the client disconnected before a decision" };
        }
        if (Date.now() >= deadline) {
          // Deny by default (3.4): silence is not consent.
          const reason = `no answer within ${String(Math.round(timeoutMs / 1000))}s, so it was denied`;
          journal.deny(request.actionId, undefined, reason);
          return { approved: false, reason };
        }

        await new Promise<void>((resolve) => setTimeout(resolve, pollMs).unref());
      }
    },
  };
}
