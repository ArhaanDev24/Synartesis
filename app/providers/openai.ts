import type { Ask, Exchange, Provider, ProviderTool, Reasoning, ToolCall, Turn } from "./types.js";

/**
 * Anything that speaks `/v1/chat/completions`.
 *
 * Which is most of the field: Ollama, LM Studio, vLLM, llama.cpp, Mistral,
 * OpenAI itself, and every gateway that imitates them. Written against the
 * wire format with `fetch` rather than against a vendor's SDK, because the
 * whole value of this adapter is that it belongs to no vendor -- a client
 * library would have opinions about base URLs, authentication and retries
 * that a local model on `localhost:11434` does not share.
 *
 * Running fully local is the case this is really for: no key, no account, no
 * network, and nothing left on somebody else's disk.
 */

export interface OpenAICompatibleOptions {
  readonly model: string;
  /** Where the server lives, up to and including `/v1`. */
  readonly baseURL: string;
  /** Absent for a local server that wants no authentication. */
  readonly apiKey?: string;
  readonly maxTokens?: number;
  /**
   * Whether this endpoint understands `reasoning_effort`. Off by default,
   * because most do not and a server that does not is entitled to reject the
   * whole request for it. When off, the app says the slider does nothing here
   * rather than moving it and changing nothing.
   */
  readonly reasoningEffort?: boolean;
  /** Named for the picker, when a bare model id is not recognisable. */
  readonly label?: string;
}

const EFFORT: Record<Reasoning, "low" | "medium" | "high"> = {
  brief: "low",
  balanced: "medium",
  thorough: "high",
};

/**
 * How a failed tool result is spelled here.
 *
 * This protocol has no flag for it -- a tool message is a string and nothing
 * else -- so the failure has to survive in the prose or not at all. Marking it
 * is lossy and obvious; leaving it out teaches the model that errors are
 * ordinary output, which is the failure this prefix exists to prevent.
 */
const FAILED = "Error: ";

export function toTools(tools: readonly ProviderTool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function toMessages(system: string, history: readonly Exchange[]): unknown[] {
  const messages: unknown[] = [];
  if (system !== "") {
    messages.push({ role: "system", content: system });
  }
  for (const entry of history) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.text });
      continue;
    }
    if (entry.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: entry.callId,
        content: entry.failed ? `${FAILED}${entry.text}` : entry.text,
      });
      continue;
    }
    const calls = entry.calls ?? [];
    messages.push({
      role: "assistant",
      // Null rather than "" -- several servers reject an assistant message
      // that has both empty content and tool calls, and null is the shape the
      // protocol uses to mean there was nothing to say.
      content: entry.text === "" ? null : entry.text,
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }),
    });
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** One tool call being assembled across however many fragments it arrives in. */
interface Building {
  id: string;
  name: string;
  args: string;
}

/**
 * Arguments as the model actually sent them.
 *
 * A model that emits arguments which are not JSON has not made a call anybody
 * can check, and small local models do this often enough that it is a normal
 * condition rather than a bug. It is reported as a malformed call so the model
 * can be told what was wrong, and never dispatched.
 */
function finish(building: Building): ToolCall {
  const raw = building.args.trim();
  if (raw === "") {
    return { id: building.id, name: building.name, args: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      id: building.id,
      name: building.name,
      args: {},
      malformed: `arguments were not valid JSON: ${raw.slice(0, 200)}`,
    };
  }
  const fields = record(parsed);
  if (fields === undefined) {
    return {
      id: building.id,
      name: building.name,
      args: {},
      malformed: `arguments must be a JSON object, got ${raw.slice(0, 200)}`,
    };
  }
  return { id: building.id, name: building.name, args: fields };
}

/**
 * Server-sent events, split out of however the bytes happened to arrive.
 *
 * A chunk boundary lands in the middle of a JSON payload regularly, so the
 * tail of every read is kept until the blank line that ends its event shows up.
 */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n");
      while (cut !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
        cut = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): Provider {
  const endpoint = `${options.baseURL.replace(/\/$/, "")}/chat/completions`;
  const reasons = options.reasoningEffort ?? false;

  return {
    id: options.label ?? `openai-compatible:${options.model}`,
    supportsTools: true,
    supportsReasoning: reasons,
    async respond(ask: Ask): Promise<Turn> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          messages: toMessages(ask.system, ask.messages),
          ...(ask.tools.length === 0 ? {} : { tools: toTools(ask.tools) }),
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
          ...(reasons ? { reasoning_effort: EFFORT[ask.reasoning] } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        ...(ask.signal === undefined ? {} : { signal: ask.signal }),
      });

      if (!response.ok || response.body === null) {
        // The body is the message. A server refusing tools says so here, and
        // swallowing it would leave the app looking like the model simply
        // chose not to call anything -- which is the one failure this app
        // cannot afford to make look normal.
        const said = response.body === null ? "" : await response.text();
        throw new Error(
          `${options.model} at ${options.baseURL} refused the request ` +
            `(HTTP ${String(response.status)}): ${said.slice(0, 500)}`,
        );
      }

      let said = "";
      /** Keyed by the index the server assigns, which is how fragments pair up. */
      const building = new Map<number, Building>();
      let usage: Turn["usage"];

      for await (const data of events(response.body)) {
        if (data === "[DONE]") {
          break;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          // A line that is not JSON is not something to guess at. Comments and
          // keep-alives are legal in this protocol and mean nothing here.
          continue;
        }
        const frame = record(payload);
        if (frame === undefined) {
          continue;
        }

        const counted = record(frame["usage"]);
        if (counted !== undefined) {
          usage = {
            input: count(counted["prompt_tokens"]) ?? 0,
            output: count(counted["completion_tokens"]) ?? 0,
          };
        }

        const choices = frame["choices"];
        if (!Array.isArray(choices)) {
          continue;
        }
        for (const choice of choices) {
          const delta = record(record(choice)?.["delta"]);
          if (delta === undefined) {
            continue;
          }
          const chunk = text(delta["content"]);
          if (chunk !== undefined && chunk !== "") {
            said += chunk;
            ask.onText?.(chunk);
          }
          const fragments = delta["tool_calls"];
          if (!Array.isArray(fragments)) {
            continue;
          }
          for (const one of fragments) {
            const fragment = record(one);
            if (fragment === undefined) {
              continue;
            }
            const at = count(fragment["index"]) ?? building.size;
            const soFar = building.get(at) ?? { id: "", name: "", args: "" };
            const id = text(fragment["id"]);
            if (id !== undefined && id !== "") {
              soFar.id = id;
            }
            const fn = record(fragment["function"]);
            const name = text(fn?.["name"]);
            if (name !== undefined && name !== "") {
              soFar.name = name;
            }
            soFar.args += text(fn?.["arguments"]) ?? "";
            building.set(at, soFar);
          }
        }
      }

      const calls = [...building.entries()]
        .sort(([a], [b]) => a - b)
        .map(([at, one]) =>
          // Some servers -- Ollama among them -- send no id at all, and a tool
          // result has to be addressed to something. The index is stable
          // within the turn, which is as much as the result needs.
          finish(one.id === "" ? { ...one, id: `call-${String(at)}` } : one),
        )
        .filter((call) => call.name !== "");

      return { text: said, calls, ...(usage === undefined ? {} : { usage }) };
    },
  };
}
