/**
 * One shape every model speaks, so the rest of the app never learns three.
 *
 * Anthropic, Gemini and anything with an OpenAI-compatible endpoint all
 * disagree about how a conversation is spelled, what a tool call looks like,
 * and how you ask for more thinking. None of that disagreement is interesting
 * to a chat window or to the journal underneath it, so it stops here: an
 * adapter's whole job is to turn one of those dialects into this.
 *
 * Deliberately not the Anthropic SDK's own types, even though the Anthropic
 * adapter will use them internally. Borrowing one provider's vocabulary for
 * the interface all three implement makes the other two second-class.
 */

/** A tool as the model is told about it. Mapped straight from MCP's tools/list. */
export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, exactly as the server advertised it. */
  readonly inputSchema: Record<string, unknown>;
}

/**
 * How hard to think, in the only three steps a person actually wants.
 *
 * Every provider spells this differently -- adaptive thinking with an effort
 * level, a token budget, a reasoning field, or nothing at all -- and a slider
 * with three stops is honest about all of them. An adapter that cannot offer
 * it says so rather than silently ignoring the setting.
 */
export type Reasoning = "brief" | "balanced" | "thorough";

export interface ToolCall {
  /** The provider's own id for this call; tool results are matched back by it. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /**
   * Set when the model asked for a tool but the request could not be read --
   * arguments that are not JSON, most often, which small local models produce
   * regularly. The call is still reported so the model can be told what was
   * wrong with it, but it must never be dispatched: arguments nobody could
   * parse are arguments nobody can check, and this one would arrive at a real
   * filesystem. `args` is empty when this is set.
   */
  readonly malformed?: string;
}

/**
 * The conversation so far, in a form all three adapters can render.
 *
 * A tool result carries `failed` separately from its text because every
 * provider has a flag for it, and losing that distinction teaches a model that
 * errors are just unusual prose.
 */
export type Exchange =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly calls?: readonly ToolCall[] }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly text: string;
      readonly failed: boolean;
    };

/** What came back. Either it wants tools run, or it is talking to the person. */
export interface Turn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  /** What the turn cost, where the provider says. Local models report nothing. */
  readonly usage?: { readonly input: number; readonly output: number };
}

export interface Ask {
  readonly system: string;
  readonly messages: readonly Exchange[];
  readonly tools: readonly ProviderTool[];
  readonly reasoning: Reasoning;
  readonly signal?: AbortSignal;
  /** Called with text as it arrives, for a window that types as the model does. */
  readonly onText?: (chunk: string) => void;
}

export interface Provider {
  /** For logs and the picker; not shown as the model's name. */
  readonly id: string;
  /** Whether this model can be given tools at all. */
  readonly supportsTools: boolean;
  /** Whether the reasoning setting reaches anything, so the UI can say. */
  readonly supportsReasoning: boolean;
  respond(ask: Ask): Promise<Turn>;
}
