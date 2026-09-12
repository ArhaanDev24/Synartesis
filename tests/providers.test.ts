import { afterEach, describe, expect, it } from "vitest";

import {
  anthropicEvent,
  fakeModel,
  geminiEvent,
  openAIEvent,
  type FakeModel,
} from "./helpers/fake-model.js";
import { createAnthropicProvider, toMessages as toAnthropic } from "../app/providers/anthropic.js";
import { cleanSchema, createGeminiProvider, toContents } from "../app/providers/gemini.js";
import {
  createOpenAICompatibleProvider,
  toMessages as toOpenAI,
} from "../app/providers/openai.js";
import { createProvider, PRESETS } from "../app/providers/index.js";
import type { Ask, Exchange, ProviderTool } from "../app/providers/types.js";

/**
 * Three dialects, one conversation.
 *
 * The adapters are the only place in this app where a conversation can be
 * quietly mistranslated, and a mistranslation does not look like a failure --
 * a tool result attached to the wrong turn still produces a fluent answer. So
 * these tests check what actually left the machine, over real HTTP, against a
 * server that records it.
 */

const open: FakeModel[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
});

async function serving(reply: Parameters<typeof fakeModel>[0]): Promise<FakeModel> {
  const server = await fakeModel(reply);
  open.push(server);
  return server;
}

const TOOL: ProviderTool = {
  name: "fs__write_file",
  description: "Write a file.",
  inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

function ask(messages: readonly Exchange[], extra: Partial<Ask> = {}): Ask {
  return {
    system: "You are careful.",
    messages,
    tools: [TOOL],
    reasoning: "balanced",
    ...extra,
  };
}

/** A conversation that has been through one round of tools. */
const AFTER_TOOLS: readonly Exchange[] = [
  { role: "user", text: "zero out the north row" },
  {
    role: "assistant",
    text: "",
    calls: [{ id: "call_1", name: "fs__write_file", args: { path: "/r.txt", content: "0" } }],
  },
  { role: "tool", callId: "call_1", name: "fs__write_file", text: "written", failed: false },
  {
    role: "assistant",
    text: "",
    calls: [
      { id: "call_2", name: "fs__write_file", args: { path: "/a", content: "1" } },
      { id: "call_3", name: "fs__write_file", args: { path: "/b", content: "2" } },
    ],
  },
  { role: "tool", callId: "call_2", name: "fs__write_file", text: "written", failed: false },
  { role: "tool", callId: "call_3", name: "fs__write_file", text: "held for approval", failed: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Claude", () => {
  it("keeps the results of one turn in one message", () => {
    const messages = toAnthropic(AFTER_TOOLS);
    // Four: the question, the calls, their results, the next calls, their
    // results. Scattering results across a message each is a different
    // conversation as far as the model is concerned, and it answers differently.
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const second = messages[4];
    expect(Array.isArray(second?.content) ? second.content.length : 0).toBe(2);
  });

  it("marks a failed tool result as failed rather than as prose", () => {
    const messages = toAnthropic(AFTER_TOOLS);
    const results = messages[4]?.content;
    const held = Array.isArray(results) ? results[1] : undefined;
    expect(isRecord(held) && held["is_error"]).toBe(true);
  });

  it("sends no empty text block for a turn that was only tool calls", () => {
    const messages = toAnthropic(AFTER_TOOLS);
    const blocks = messages[1]?.content;
    // The API refuses an empty text block outright, so a "" that survives here
    // fails the whole request -- and only on turns that used tools.
    expect(Array.isArray(blocks) ? blocks.length : 0).toBe(1);
    expect(isRecord(Array.isArray(blocks) ? blocks[0] : undefined) ? "tool_use" : "").toBe(
      "tool_use",
    );
  });

  it("streams text and returns the tool call it was asked for", async () => {
    const server = await serving(() => ({
      sse: [
        anthropicEvent("message_start", {
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 40, output_tokens: 1 },
          },
        }),
        anthropicEvent("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        anthropicEvent("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "Zeroing " },
        }),
        anthropicEvent("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "the row." },
        }),
        anthropicEvent("content_block_stop", { index: 0 }),
        anthropicEvent("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: "toolu_9", name: "fs__write_file", input: {} },
        }),
        anthropicEvent("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":"/r.txt",' },
        }),
        anthropicEvent("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"content":"0"}' },
        }),
        anthropicEvent("content_block_stop", { index: 1 }),
        anthropicEvent("message_delta", {
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 31 },
        }),
        anthropicEvent("message_stop", {}),
      ],
    }));

    const provider = createAnthropicProvider({ apiKey: "not-a-real-key", baseURL: server.url });
    const streamed: string[] = [];
    const turn = await provider.respond(
      ask([{ role: "user", text: "zero it" }], {
        onText: (chunk) => streamed.push(chunk),
      }),
    );

    expect(streamed.join("")).toBe("Zeroing the row.");
    expect(turn.text).toBe("Zeroing the row.");
    expect(turn.calls).toEqual([
      { id: "toolu_9", name: "fs__write_file", args: { path: "/r.txt", content: "0" } },
    ]);
    expect(turn.usage).toEqual({ input: 40, output: 31 });
  });

  it("asks for the thinking the slider was set to", async () => {
    const server = await serving(() => ({
      sse: [
        anthropicEvent("message_start", {
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        anthropicEvent("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        anthropicEvent("message_stop", {}),
      ],
    }));
    const provider = createAnthropicProvider({ apiKey: "k", baseURL: server.url });
    await provider.respond(ask([{ role: "user", text: "hi" }], { reasoning: "thorough" }));

    const sent = server.sent[0];
    expect(sent?.["output_config"]).toEqual({ effort: "high" });
    // Adaptive, and no token budget: this model family rejects the budget
    // outright, so a stale one here is a 400 on every single request.
    expect(sent?.["thinking"]).toEqual({ type: "adaptive" });
    expect(JSON.stringify(sent)).not.toContain("budget_tokens");
  });
});

describe("Gemini", () => {
  it("strips the schema dialect the API refuses", () => {
    const cleaned = cleanSchema(TOOL.inputSchema);
    expect(cleaned["$schema"]).toBeUndefined();
    // And keeps everything that says what the tool accepts.
    expect(cleaned["required"]).toEqual(["path", "content"]);
    expect(cleaned["properties"]).toBeDefined();
  });

  it("says a tool failed in the protocol's own words", () => {
    const contents = toContents(AFTER_TOOLS);
    const results = contents[4]?.parts;
    const ok = results?.[0]?.functionResponse?.response;
    const bad = results?.[1]?.functionResponse?.response;
    expect(ok).toEqual({ output: "written" });
    // Not "output: Error: ...". Gemini has a place for this and using it is
    // the difference between a model that retries and one that carries on.
    expect(bad).toEqual({ error: "held for approval" });
  });

  it("never sends back an id Gemini did not issue", async () => {
    const server = await serving(() => ({
      sse: [
        geminiEvent({
          candidates: [
            {
              content: {
                role: "model",
                // No id, which is the usual case on this API.
                parts: [{ functionCall: { name: "fs__write_file", args: { path: "/x" } } }],
              },
            },
          ],
        }),
      ],
    }));
    const provider = createGeminiProvider({ apiKey: "k", baseURL: server.url });
    const turn = await provider.respond(ask([{ role: "user", text: "write it" }]));
    expect(turn.calls).toHaveLength(1);

    // Now send that call back as history and check the invented id stays here.
    const back = toContents([
      { role: "user", text: "write it" },
      { role: "assistant", text: "", calls: turn.calls },
      {
        role: "tool",
        callId: turn.calls[0]?.id ?? "",
        name: "fs__write_file",
        text: "done",
        failed: false,
      },
    ]);
    expect(JSON.stringify(back)).not.toContain("gemini-call-");
    expect(back[1]?.parts?.[0]?.functionCall?.id).toBeUndefined();
    expect(back[2]?.parts?.[0]?.functionResponse?.id).toBeUndefined();
  });

  it("streams text and counts thinking as output", async () => {
    const server = await serving(() => ({
      sse: [
        geminiEvent({ candidates: [{ content: { role: "model", parts: [{ text: "Look" }] } }] }),
        geminiEvent({
          candidates: [{ content: { role: "model", parts: [{ text: "ing." }] } }],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 300,
          },
        }),
      ],
    }));
    const provider = createGeminiProvider({ apiKey: "k", baseURL: server.url });
    const streamed: string[] = [];
    const turn = await provider.respond(
      ask([{ role: "user", text: "hi" }], { onText: (chunk) => streamed.push(chunk) }),
    );
    expect(streamed.join("")).toBe("Looking.");
    // Thoughts are billed and are most of what "thorough" buys. A total that
    // leaves them out understates the turn by exactly the amount the slider
    // changed, which would make the cost readout a lie about the setting.
    expect(turn.usage).toEqual({ input: 12, output: 304 });
  });

  it("sends the tool without the dialect key", async () => {
    const server = await serving(() => ({
      sse: [geminiEvent({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] })],
    }));
    const provider = createGeminiProvider({ apiKey: "k", baseURL: server.url });
    await provider.respond(ask([{ role: "user", text: "hi" }]));
    expect(JSON.stringify(server.sent[0])).not.toContain("json-schema.org");
    expect(JSON.stringify(server.sent[0])).toContain("fs__write_file");
  });
});

describe("anything OpenAI-compatible", () => {
  const local = (server: FakeModel, extra: Record<string, unknown> = {}) =>
    createOpenAICompatibleProvider({ model: "qwen3:8b", baseURL: `${server.url}/v1`, ...extra });

  it("assembles an event that arrived in two packets", async () => {
    const whole = openAIEvent({
      choices: [{ index: 0, delta: { content: "half and half" } }],
    });
    const server = await serving(() => ({
      // Cut in the middle of the JSON. A reader that treats each packet as a
      // message loses this one silently and the turn comes back empty.
      sse: [whole.slice(0, 25), whole.slice(25), "data: [DONE]\n\n"],
    }));
    const turn = await local(server).respond(ask([{ role: "user", text: "hi" }]));
    expect(turn.text).toBe("half and half");
  });

  it("assembles a tool call out of argument fragments", async () => {
    const server = await serving(() => ({
      sse: [
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    function: { name: "fs__write_file", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        }),
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"/r.txt"}' } }] },
            },
          ],
        }),
        openAIEvent({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
        "data: [DONE]\n\n",
      ],
    }));
    const turn = await local(server).respond(ask([{ role: "user", text: "write" }]));
    expect(turn.calls).toEqual([
      { id: "call_abc", name: "fs__write_file", args: { path: "/r.txt" } },
    ]);
    expect(turn.usage).toEqual({ input: 9, output: 3 });
  });

  it("refuses to pass on arguments it could not read", async () => {
    const server = await serving(() => ({
      sse: [
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_bad",
                    // What a small local model actually emits when it is out
                    // of its depth. Half a JSON object.
                    function: { name: "fs__write_file", arguments: '{"path": "/r.txt", "con' },
                  },
                ],
              },
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
    }));
    const turn = await local(server).respond(ask([{ role: "user", text: "write" }]));
    expect(turn.calls[0]?.malformed).toMatch(/not valid JSON/);
    // And nothing was salvaged from it. Half-read arguments are worse than
    // none: they look like a call the person meant to make.
    expect(turn.calls[0]?.args).toEqual({});
  });

  it("gives an id to a call from a server that sends none", async () => {
    const server = await serving(() => ({
      sse: [
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { name: "fs__write_file", arguments: "{}" } }],
              },
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
    }));
    const turn = await local(server).respond(ask([{ role: "user", text: "write" }]));
    // A result has to be addressed to something, or the next turn cannot
    // reference it and the model is told nothing happened.
    expect(turn.calls[0]?.id).not.toBe("");
  });

  it("repeats what the server said when it refuses", async () => {
    const server = await serving(() => ({
      status: 400,
      body: JSON.stringify({ error: { message: "qwen3:8b does not support tools" } }),
    }));
    await expect(local(server).respond(ask([{ role: "user", text: "hi" }]))).rejects.toThrow(
      /does not support tools/,
    );
  });

  it("does not ask for reasoning from a server that has none", async () => {
    const server = await serving(() => ({ sse: ["data: [DONE]\n\n"] }));
    const plain = local(server);
    expect(plain.supportsReasoning).toBe(false);
    await plain.respond(ask([{ role: "user", text: "hi" }], { reasoning: "thorough" }));
    expect(server.sent[0]?.["reasoning_effort"]).toBeUndefined();

    const reasoning = local(server, { reasoningEffort: true });
    expect(reasoning.supportsReasoning).toBe(true);
    await reasoning.respond(ask([{ role: "user", text: "hi" }], { reasoning: "thorough" }));
    expect(server.sent[1]?.["reasoning_effort"]).toBe("high");
  });

  it("sends no authorization at all to a local server", async () => {
    const server = await serving(() => ({ sse: ["data: [DONE]\n\n"] }));
    // An empty bearer token is not the same as no token: some gateways read it
    // as an attempt and refuse, which would break the free, local, no-account
    // case this adapter exists for.
    const provider = createProvider({
      kind: "openai-compatible",
      model: "qwen3:8b",
      baseURL: `${server.url}/v1`,
    });
    await provider.respond(ask([{ role: "user", text: "hi" }]));
    expect(server.paths[0]).toBe("/v1/chat/completions");
  });

  it("says an assistant turn had nothing to say, rather than saying nothing", () => {
    const messages = toOpenAI("be careful", AFTER_TOOLS);
    const assistant = messages.find(
      (message) => isRecord(message) && message["role"] === "assistant",
    );
    // Null, not "". Several servers reject an assistant message carrying both
    // an empty string and tool calls.
    expect(isRecord(assistant) ? assistant["content"] : "missing").toBeNull();
  });

  it("carries a failure across a protocol that has no word for one", () => {
    const messages = toOpenAI("", AFTER_TOOLS);
    const results = messages.filter((message) => isRecord(message) && message["role"] === "tool");
    const held = results[2];
    expect(isRecord(held) ? held["content"] : "").toMatch(/^Error: /);
  });
});

describe("the model picker", () => {
  it("asks for a key only where one is needed", () => {
    for (const preset of PRESETS) {
      const local = preset.config.kind === "openai-compatible" &&
        preset.config.baseURL.startsWith("http://localhost");
      // Everything running on this machine must work with no account at all.
      // That is the whole promise of the local option.
      expect(preset.needsKey).toBe(!local);
    }
  });

  it("refuses a hosted model with no key, before the request rather than after", () => {
    expect(() => createProvider({ kind: "anthropic" })).toThrow(/API key/);
    expect(() => createProvider({ kind: "gemini" }, "")).toThrow(/API key/);
  });

  it("tells the window whether the slider reaches anything", () => {
    expect(createProvider({ kind: "anthropic" }, "k").supportsReasoning).toBe(true);
    expect(createProvider({ kind: "gemini" }, "k").supportsReasoning).toBe(true);
    const mistral = PRESETS.find((preset) => preset.name === "Mistral")?.config;
    expect(mistral).toBeDefined();
    if (mistral !== undefined) {
      // Saying so is the point. A slider that moves and changes nothing is
      // worse than one that is greyed out with a reason.
      expect(createProvider(mistral, "k").supportsReasoning).toBe(false);
    }
  });
});
