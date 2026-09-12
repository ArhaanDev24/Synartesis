import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../app/main/agent.js";
import { startEngine, type Engine } from "../app/main/engine.js";
import { createProvider } from "../app/providers/index.js";
import { rollback } from "../src/rollback/rollback.js";
import { fakeModel, openAIEvent, type FakeModel } from "./helpers/fake-model.js";

/**
 * A real adapter, driving the real thing.
 *
 * The other app tests use a scripted stand-in for a model, which proves the
 * loop but not the adapter. This one puts an actual provider -- HTTP, event
 * stream, tool calls assembled out of fragments -- in front of the proxy, and
 * checks the claim the whole product rests on: whatever the model reaches for,
 * the state it replaced is captured and can be put back.
 *
 * The OpenAI-compatible adapter is the one used here because it is the one a
 * person running Ollama on their laptop will use, which is the case that has
 * to work with no key and no account.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
const servers: FakeModel[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function bench(): Promise<{ engine: Engine; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-provider-"));
  dirs.push(root);
  const manifestPath = join(root, "synartesis.yaml");
  writeFileSync(
    manifestPath,
    readFileSync("manifests/filesystem.yaml", "utf8").replace(
      /servers:\n  fs:\n    command:.*\n    args:.*\n/,
      `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${root}"]\n`,
    ),
  );
  const engine = await startEngine({
    manifestPath,
    journalPath: join(root, "journal.db"),
    label: "provider-test",
    gateTimeoutMs: 300,
  });
  closers.push(() => engine.close());
  return { engine, root };
}

async function named(engine: Engine, bare: string): Promise<string> {
  const tools = await engine.tools();
  const found = tools.find((tool) => tool.name === bare || tool.name.endsWith(`__${bare}`));
  if (found === undefined) {
    throw new Error(`no tool like ${bare}`);
  }
  return found.name;
}

/**
 * A local model that calls one tool and then talks, like a real one would.
 *
 * The arguments arrive split across two packets, because that is how they
 * arrive from a real server and it is the half of this that has ever broken.
 */
async function modelThatCalls(tool: string, args: string): Promise<FakeModel> {
  let round = 0;
  const server = await fakeModel(() => {
    round += 1;
    if (round > 1) {
      return {
        sse: [
          openAIEvent({ choices: [{ index: 0, delta: { content: "Done." } }] }),
          "data: [DONE]\n\n",
        ],
      };
    }
    const cut = Math.floor(args.length / 2);
    return {
      sse: [
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: tool, arguments: args.slice(0, cut) } },
                ],
              },
            },
          ],
        }),
        openAIEvent({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] } },
          ],
        }),
        "data: [DONE]\n\n",
      ],
    };
  });
  servers.push(server);
  return server;
}

describe("a local model, through the proxy", () => {
  it("has what it changed captured, and put back", async () => {
    const { engine, root } = await bench();
    const path = join(root, "report.txt");
    const original = "Region   Revenue\nNorth    412,000\n";
    writeFileSync(path, original);

    const tool = await named(engine, "write_file");
    const server = await modelThatCalls(
      tool,
      JSON.stringify({ path, content: "Region   Revenue\nNorth    000,000\n" }),
    );
    const provider = createProvider({
      kind: "openai-compatible",
      model: "qwen3:8b",
      baseURL: `${server.url}/v1`,
    });

    await run({
      engine,
      provider,
      reasoning: "balanced",
      system: "You are careful.",
      history: [],
      say: "zero out the north revenue",
    });

    expect(readFileSync(path, "utf8")).toContain("000,000");

    const write = engine.journal.getActions(engine.runId).find((one) => one.tool === "write_file");
    expect(write?.status).toBe("applied");
    expect(write?.inverse).toBeDefined();

    const report = await rollback({
      journal: engine.journal,
      router: engine.router,
      runId: engine.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(readFileSync(path, "utf8")).toBe(original);

    // And the tool result really went back to the model: it was asked a second
    // time, with the result in hand. A loop that stops after one round looks
    // identical from the outside and gets the work half done.
    expect(server.sent).toHaveLength(2);
  });

  it("never sends a call whose arguments nobody could read", async () => {
    const { engine, root } = await bench();
    const path = join(root, "safe.txt");
    writeFileSync(path, "untouched\n");

    const tool = await named(engine, "write_file");
    // What a small model emits when it is out of its depth: an object it never
    // finished. Dispatching what survived parsing would be a write nobody
    // asked for, to a path the model only got halfway through naming.
    const server = await modelThatCalls(tool, `{"path": "${path}", "content": "wre`);
    const provider = createProvider({
      kind: "openai-compatible",
      model: "qwen3:8b",
      baseURL: `${server.url}/v1`,
    });

    const results: { text: string; failed: boolean }[] = [];
    await run({
      engine,
      provider,
      reasoning: "balanced",
      system: "",
      history: [],
      say: "write it",
      onEvent: (event) => {
        if (event.result !== undefined) results.push(event.result);
      },
    });

    expect(readFileSync(path, "utf8")).toBe("untouched\n");
    // Nothing reached the journal either, because nothing was sent. A recorded
    // action for a call that never happened is worse than no record at all.
    expect(engine.journal.getActions(engine.runId).some((one) => one.tool === "write_file")).toBe(
      false,
    );
    // And the model was told why, so it can try again rather than assume it worked.
    expect(results[0]?.failed).toBe(true);
    expect(results[0]?.text).toMatch(/not valid JSON/);
  });
});
