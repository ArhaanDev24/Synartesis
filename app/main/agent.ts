import type { Engine } from "./engine.js";
import type { Exchange, Provider, Reasoning, ToolCall } from "../providers/types.js";

/**
 * The loop: ask, run what it asked for, tell it what happened, ask again.
 *
 * Written by hand rather than taken from a provider's tool runner, for three
 * reasons that are not going away. The tools are discovered from MCP at run
 * time, so there is nothing to decorate up front. Three adapters have to share
 * one loop or the app grows three. And every call has to be interceptable --
 * that is where the tool cards, the approval prompts and the undo affordances
 * hang, and a loop that owns its own turns has nowhere to put them.
 */

export interface AgentEvent {
  readonly kind: "text" | "call" | "result" | "done" | "stopped";
  readonly text?: string;
  readonly call?: ToolCall;
  readonly result?: { readonly text: string; readonly failed: boolean };
  /** Why it stopped, when it stopped for a reason worth saying. */
  readonly why?: string;
}

export interface RunOptions {
  readonly engine: Engine;
  readonly provider: Provider;
  readonly reasoning: Reasoning;
  readonly system: string;
  /** The conversation so far. Appended to, and returned. */
  readonly history: readonly Exchange[];
  readonly say: string;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly signal?: AbortSignal;
  /**
   * A ceiling on rounds of tool use in one turn. Not a safety mechanism --
   * the gate and the journal are that -- but a model that has misunderstood
   * its task should stop and say so rather than work all afternoon.
   */
  readonly maxRounds?: number;
}

const DEFAULT_MAX_ROUNDS = 24;

export async function run(options: RunOptions): Promise<readonly Exchange[]> {
  const { engine, provider, onEvent } = options;
  const emit = (event: AgentEvent): void => onEvent?.(event);
  const messages: Exchange[] = [...options.history, { role: "user", text: options.say }];

  // Asked once per turn rather than once per round: a server that gains a tool
  // mid-conversation is rare, and re-listing between every round would change
  // the cached prefix on every request for nothing.
  const tools = provider.supportsTools ? await engine.tools() : [];

  const ceiling = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  for (let round = 0; round < ceiling; round += 1) {
    if (options.signal?.aborted === true) {
      emit({ kind: "stopped", why: "you stopped it" });
      return messages;
    }

    const turn = await provider.respond({
      system: options.system,
      // A copy. An adapter that holds on to what it was given -- to retry, to
      // count tokens, to cache a prefix -- must not find it rewritten
      // underneath by the next round of tool results.
      messages: [...messages],
      tools,
      reasoning: options.reasoning,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onText: (chunk) => {
        emit({ kind: "text", text: chunk });
      },
    });

    messages.push({
      role: "assistant",
      text: turn.text,
      ...(turn.calls.length === 0 ? {} : { calls: turn.calls }),
    });

    if (turn.calls.length === 0) {
      emit({ kind: "done" });
      return messages;
    }

    // Sequentially, not in parallel. Two writes to one resource in the same
    // round would race their own snapshots, and the journal would hold two
    // pre-states for one before -- which is the one thing it must never do.
    for (const call of turn.calls) {
      emit({ kind: "call", call });
      const result = await engine.call(call.name, call.args);
      emit({ kind: "result", call, result });
      messages.push({
        role: "tool",
        callId: call.id,
        name: call.name,
        text: result.text,
        failed: result.failed,
      });
    }
  }

  emit({ kind: "stopped", why: `it used ${String(ceiling)} rounds of tools without finishing` });
  return messages;
}
