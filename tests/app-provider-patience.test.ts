import { afterEach, describe, expect, it } from "vitest";

import { createProvider } from "../app/providers/index.js";
import { patient } from "../app/providers/patience.js";
import type { Ask, Provider, Turn } from "../app/providers/types.js";
import { fakeModel, openAIEvent, type FakeModel } from "./helpers/fake-model.js";

/**
 * Waiting out a rate limit is the one retry this app is allowed to make on
 * somebody's behalf, and it is only safe because of what it refuses to retry.
 * These tests are mostly about the refusals.
 */

const LIMITED =
  "Quota exceeded for metric: generate_content_requests, limit: 60. Please retry in 2s.";

const NO_ALLOWANCE =
  "You exceeded your current quota. Quota exceeded for metric: " +
  "generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro. Please retry in 23.4s.";

/** A provider that fails in a stated way for a stated number of attempts. */
function flaky(fails: number, said: string, options: { speaksFirst?: boolean } = {}): {
  provider: Provider;
  attempts: () => number;
} {
  let attempts = 0;
  const provider: Provider = {
    id: "gemini:gemini-3.1-pro-preview",
    supportsTools: true,
    supportsReasoning: true,
    respond(ask: Ask): Promise<Turn> {
      attempts += 1;
      if (attempts <= fails) {
        if (options.speaksFirst === true) {
          ask.onText?.("Half a sentence");
        }
        return Promise.reject(new Error(said));
      }
      return Promise.resolve({ text: "done", calls: [] });
    },
  };
  return { provider, attempts: () => attempts };
}

function ask(extra: Partial<Ask> = {}): Ask {
  return { system: "", messages: [], tools: [], reasoning: "balanced", ...extra };
}

describe("waiting out a rate limit", () => {
  it("waits as long as the provider asked and gets the answer", async () => {
    const slept: number[] = [];
    const { provider, attempts } = flaky(1, LIMITED);
    const waiting: number[] = [];

    const turn = await patient(provider, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    }).respond(ask({ onWait: (ms) => waiting.push(ms) }));

    expect(turn.text).toBe("done");
    expect(attempts()).toBe(2);
    // Two seconds and a little, because their clock is the one that counts.
    expect(slept).toEqual([2250]);
    // And the window was told, so a two-second silence is a sentence.
    expect(waiting).toEqual([2250]);
  });

  it("does not wait for a quota that is zero", async () => {
    const slept: number[] = [];
    const { provider, attempts } = flaky(1, NO_ALLOWANCE);

    await expect(
      patient(provider, (ms) => {
        slept.push(ms);
        return Promise.resolve();
      }).respond(ask()),
    ).rejects.toThrow(/quota/);

    // The body says "retry in 23.4s" and means nothing by it.
    expect(attempts()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("does not retry once the model has started speaking", async () => {
    const slept: number[] = [];
    const said: string[] = [];
    const { provider, attempts } = flaky(1, LIMITED, { speaksFirst: true });

    await expect(
      patient(provider, (ms) => {
        slept.push(ms);
        return Promise.resolve();
      }).respond(ask({ onText: (chunk) => said.push(chunk) })),
    ).rejects.toThrow(/Quota exceeded/);

    // A retry replays the request from the beginning, and those words are
    // already on screen. Saying them twice is worse than the error.
    expect(attempts()).toBe(1);
    expect(slept).toEqual([]);
    expect(said).toEqual(["Half a sentence"]);
  });

  it("gives up rather than waiting forever, and hands over what the provider said", async () => {
    const slept: number[] = [];
    const { provider, attempts } = flaky(99, LIMITED);

    await expect(
      patient(provider, (ms) => {
        slept.push(ms);
        return Promise.resolve();
      }).respond(ask()),
    ).rejects.toThrow(/Please retry in 2s/);

    expect(attempts()).toBe(3);
    expect(slept).toHaveLength(2);
  });

  it("does not start a wait the person has already stopped", async () => {
    const slept: number[] = [];
    const { provider, attempts } = flaky(1, LIMITED);
    const stop = new AbortController();
    stop.abort();

    await expect(
      patient(provider, (ms) => {
        slept.push(ms);
        return Promise.resolve();
      }).respond(ask({ signal: stop.signal })),
    ).rejects.toThrow(/Quota exceeded/);

    expect(attempts()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("comes back out of a real wait the moment somebody stops it", async () => {
    // The default sleep, not a stub: a wait of a few seconds that cannot be
    // interrupted is a window that has stopped listening.
    const { provider, attempts } = flaky(1, LIMITED);
    const stop = new AbortController();

    const started = Date.now();
    await expect(
      patient(provider).respond(
        ask({
          signal: stop.signal,
          onWait: () => {
            setTimeout(() => {
              stop.abort();
            }, 10);
          },
        }),
      ),
    ).rejects.toThrow(/stopped it while it was waiting/);

    // Out in milliseconds, not the two and a quarter seconds it was told.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(attempts()).toBe(1);
  });

  it("passes anything that is not a rate limit straight through", async () => {
    const { provider, attempts } = flaky(1, "the server closed the connection after 3 bytes");
    await expect(patient(provider, () => Promise.resolve()).respond(ask())).rejects.toThrow(
      /closed the connection/,
    );
    expect(attempts()).toBe(1);
  });

  it("leaves the provider it wraps recognisable", () => {
    const { provider } = flaky(0, LIMITED);
    const waiting = patient(provider);
    expect(waiting.id).toBe(provider.id);
    expect(waiting.supportsTools).toBe(true);
    expect(waiting.supportsReasoning).toBe(true);
  });
});

describe("a rate limit over real HTTP", () => {
  const servers: FakeModel[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it("is waited out by every provider the app builds, not just the one it was written for", async () => {
    let round = 0;
    const server = await fakeModel(() => {
      round += 1;
      if (round === 1) {
        return {
          status: 429,
          body: JSON.stringify({
            error: { message: "Rate limit exceeded. Please retry in 0.1s.", type: "rate_limit_error" },
          }),
        };
      }
      return {
        sse: [
          openAIEvent({ choices: [{ index: 0, delta: { content: "Done." } }] }),
          "data: [DONE]\n\n",
        ],
      };
    });
    servers.push(server);

    // Through createProvider, which is the thing that has to remember to do
    // this. An adapter built by hand in a test would prove nothing about the
    // provider the window actually gets.
    const provider = createProvider({
      kind: "openai-compatible",
      model: "local-model",
      baseURL: `${server.url}/v1`,
    });

    const waited: number[] = [];
    const turn = await provider.respond({
      system: "",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      reasoning: "balanced",
      onWait: (ms) => {
        waited.push(ms);
      },
    });

    expect(turn.text).toBe("Done.");
    expect(round).toBe(2);
    expect(waited).toEqual([350]);
  });
});
