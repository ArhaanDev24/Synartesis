import Anthropic from "@anthropic-ai/sdk";

import type { Ask, Exchange, Provider, ProviderTool, Reasoning, ToolCall, Turn } from "./types.js";

/**
 * Claude, through the official SDK.
 *
 * The conversion functions are exported because they are where this adapter
 * can be wrong in ways a running model would hide: a tool result attached to
 * the wrong turn still produces a plausible answer. They are tested directly.
 */

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /** For pointing at a gateway, or at a fake server in the tests. */
  readonly baseURL?: string;
}

const DEFAULT_MODEL = "claude-opus-5";

/**
 * Streaming, always, and a ceiling high enough that a long answer is not
 * silently guillotined. A non-streaming request with a ceiling this high runs
 * into the request timeout before it runs into the ceiling.
 */
const DEFAULT_MAX_TOKENS = 64000;

/**
 * Three stops on the slider, three efforts.
 *
 * Thinking is adaptive -- the model decides how much it needs -- and effort is
 * how far it is allowed to go. `budget_tokens` is not here on purpose: it is
 * rejected outright by this model family.
 */
const EFFORT: Record<Reasoning, "low" | "medium" | "high"> = {
  brief: "low",
  balanced: "medium",
  thorough: "high",
};

/** MCP hands over JSON Schema, which is what a tool definition already wants. */
export function toTools(tools: readonly ProviderTool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // `type` last so a schema carrying something else under that key cannot
    // quietly turn the tool into a non-object one.
    input_schema: { ...tool.inputSchema, type: "object" as const },
  }));
}

/**
 * The conversation, in Anthropic's shape.
 *
 * Two rules worth stating because breaking either is silent. Tool results are
 * user content, and every result from one assistant turn has to arrive in one
 * message -- scattering them across several is a different conversation as far
 * as the model is concerned. And a content block may not be empty: an
 * assistant turn that was nothing but tool calls has no text to send.
 */
export function toMessages(history: readonly Exchange[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  /** The run of tool results being gathered, flushed when the run ends. */
  let pending: Anthropic.ToolResultBlockParam[] = [];

  const flush = (): void => {
    if (pending.length > 0) {
      messages.push({ role: "user", content: pending });
      pending = [];
    }
  };

  for (const entry of history) {
    if (entry.role === "tool") {
      pending.push({
        type: "tool_result",
        tool_use_id: entry.callId,
        content: entry.text,
        is_error: entry.failed,
      });
      continue;
    }
    flush();
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.text });
      continue;
    }
    const content: Anthropic.ContentBlockParam[] = [];
    if (entry.text !== "") {
      content.push({ type: "text", text: entry.text });
    }
    for (const call of entry.calls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
    }
    // An assistant turn with neither text nor calls cannot be sent and means
    // nothing; dropping it is closer to the truth than inventing filler.
    if (content.length > 0) {
      messages.push({ role: "assistant", content });
    }
  }
  flush();
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the model asked for, out of a finished message. */
export function toTurn(message: Anthropic.Message): Turn {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const calls: ToolCall[] = message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      // The SDK types tool input as `unknown` because a tool's schema is the
      // user's. Anything that is not an object is not arguments.
      args: isRecord(block.input) ? block.input : {},
    }));
  return {
    text,
    calls,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
  };
}

export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  });
  const model = options.model ?? DEFAULT_MODEL;

  return {
    id: `anthropic:${model}`,
    supportsTools: true,
    supportsReasoning: true,
    async respond(ask: Ask): Promise<Turn> {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          // The system prompt and the tool list are the same bytes on every
          // round of a conversation, so they are worth caching. Anything that
          // varies must stay after them or the prefix stops matching.
          cache_control: { type: "ephemeral" },
          ...(ask.system === "" ? {} : { system: ask.system }),
          messages: toMessages(ask.messages),
          ...(ask.tools.length === 0 ? {} : { tools: toTools(ask.tools) }),
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT[ask.reasoning] },
        },
        ask.signal === undefined ? undefined : { signal: ask.signal },
      );

      if (ask.onText !== undefined) {
        const onText = ask.onText;
        stream.on("text", (chunk: string) => {
          onText(chunk);
        });
      }
      return toTurn(await stream.finalMessage());
    },
  };
}
