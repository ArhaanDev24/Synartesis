import { GoogleGenAI, ThinkingLevel, type Content, type Part, type Tool } from "@google/genai";

import type { Ask, Exchange, Provider, ProviderTool, Reasoning, ToolCall, Turn } from "./types.js";

/**
 * Gemini, through the official SDK.
 *
 * Two things about this API differ from the other two in ways that matter, and
 * both are handled here rather than leaked upwards. Gemini does not reliably
 * give a tool call an id, so one is invented and unwound on the way back. And
 * a failed tool result has a place of its own in the protocol -- an `error`
 * key rather than an `output` key -- which is a better fit for the `failed`
 * flag than the prose-with-a-prefix the OpenAI shape forces.
 */

export interface GeminiOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /** For a gateway, or for the fake server the tests run against. */
  readonly baseURL?: string;
}

const DEFAULT_MODEL = "gemini-3-pro-preview";

/**
 * The marker on an id this adapter invented.
 *
 * Gemini's own ids, when it sends them, have to come back exactly. An id we
 * made up must not: sending one Gemini never issued is a claim about a call it
 * does not recognise. So the synthetic ones are recognisable and stripped.
 */
const INVENTED = "gemini-call-";

const LEVEL: Record<Reasoning, ThinkingLevel> = {
  brief: ThinkingLevel.LOW,
  balanced: ThinkingLevel.MEDIUM,
  thorough: ThinkingLevel.HIGH,
};

/**
 * JSON Schema, minus the keywords this API rejects.
 *
 * MCP servers commonly generate their schemas from zod, which stamps a
 * `$schema` dialect URI on the top level. Gemini refuses the whole tool for
 * it. Only the top level is cleaned: `$ref` and friends deeper in a schema are
 * structural, and quietly removing those would change what the tool accepts.
 */
const NOT_SCHEMA = new Set(["$schema", "$id"]);

export function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => !NOT_SCHEMA.has(key)),
  );
}

export function toTools(tools: readonly ProviderTool[]): Tool[] {
  if (tools.length === 0) {
    return [];
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: cleanSchema(tool.inputSchema),
      })),
    },
  ];
}

/**
 * The conversation, in Gemini's shape.
 *
 * Tool results are `user` content here, as they are everywhere, and the run of
 * them belonging to one model turn goes in one message for the same reason.
 */
export function toContents(history: readonly Exchange[]): Content[] {
  const contents: Content[] = [];
  let pending: Part[] = [];

  const flush = (): void => {
    if (pending.length > 0) {
      contents.push({ role: "user", parts: pending });
      pending = [];
    }
  };

  for (const entry of history) {
    if (entry.role === "tool") {
      pending.push({
        functionResponse: {
          ...(entry.callId.startsWith(INVENTED) ? {} : { id: entry.callId }),
          name: entry.name,
          // The protocol's own words for what happened, rather than a failure
          // spelled out in prose and hoped to be noticed.
          response: entry.failed ? { error: entry.text } : { output: entry.text },
        },
      });
      continue;
    }
    flush();
    if (entry.role === "user") {
      contents.push({ role: "user", parts: [{ text: entry.text }] });
      continue;
    }
    const parts: Part[] = [];
    if (entry.text !== "") {
      parts.push({ text: entry.text });
    }
    for (const call of entry.calls ?? []) {
      parts.push({
        functionCall: {
          ...(call.id.startsWith(INVENTED) ? {} : { id: call.id }),
          name: call.name,
          args: call.args,
        },
      });
    }
    if (parts.length > 0) {
      contents.push({ role: "model", parts });
    }
  }
  flush();
  return contents;
}

export function createGeminiProvider(options: GeminiOptions): Provider {
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { httpOptions: { baseUrl: options.baseURL } }),
  });
  const model = options.model ?? DEFAULT_MODEL;

  return {
    id: `gemini:${model}`,
    supportsTools: true,
    supportsReasoning: true,
    async respond(ask: Ask): Promise<Turn> {
      const tools = toTools(ask.tools);
      const stream = await client.models.generateContentStream({
        model,
        contents: toContents(ask.messages),
        config: {
          ...(ask.system === "" ? {} : { systemInstruction: ask.system }),
          ...(tools.length === 0 ? {} : { tools }),
          ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
          thinkingConfig: { thinkingLevel: LEVEL[ask.reasoning] },
          ...(ask.signal === undefined ? {} : { abortSignal: ask.signal }),
        },
      });

      let text = "";
      const calls: ToolCall[] = [];
      let usage: Turn["usage"];
      for await (const chunk of stream) {
        const said = chunk.text;
        if (said !== undefined && said !== "") {
          text += said;
          ask.onText?.(said);
        }
        for (const call of chunk.functionCalls ?? []) {
          // A call with no name is not a call. Gemini sends partial function
          // calls in some streaming modes, which is not a mode we ask for.
          if (call.name === undefined) {
            continue;
          }
          calls.push({
            id: call.id ?? `${INVENTED}${String(calls.length)}`,
            name: call.name,
            args: call.args ?? {},
          });
        }
        const counted = chunk.usageMetadata;
        if (counted !== undefined) {
          usage = {
            input: counted.promptTokenCount ?? 0,
            // Thoughts are billed as output and are most of what a thorough
            // setting buys, so a total that leaves them out understates the
            // turn by exactly the amount the slider changed.
            output: (counted.candidatesTokenCount ?? 0) + (counted.thoughtsTokenCount ?? 0),
          };
        }
      }
      return { text, calls, ...(usage === undefined ? {} : { usage }) };
    },
  };
}
