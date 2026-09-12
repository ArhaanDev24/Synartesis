import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../app/main/agent.js";
import { startEngine, type Engine } from "../app/main/engine.js";
import type { Ask, Provider, Turn } from "../app/providers/types.js";
import { openJournal } from "../src/journal/journal.js";
import { rollback } from "../src/rollback/rollback.js";
import { inspect, tally } from "../src/rollback/inspect.js";

/**
 * The spike, kept as a test.
 *
 * It proves the one claim the desktop app rests on: that a model talking to
 * the Synartesis proxy over an in-memory transport gets its work journalled
 * and reversible without the app writing a line of recovery code. Everything
 * else -- the window, the providers, the cards -- is presentation on top of
 * this. If this does not hold, none of it is worth building.
 *
 * No model and no network. A scripted provider stands in for one, which makes
 * the test deterministic and means it checks the loop rather than checking
 * whether some model happened to behave today.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A model that does exactly what the script says, once, then talks. */
function scripted(turns: readonly Turn[]): Provider & { asked: Ask[] } {
  const asked: Ask[] = [];
  let at = 0;
  return {
    id: "scripted",
    supportsTools: true,
    supportsReasoning: false,
    asked,
    respond(ask: Ask): Promise<Turn> {
      asked.push(ask);
      const turn = turns[at] ?? { text: "done", calls: [] };
      at += 1;
      return Promise.resolve(turn);
    },
  };
}

async function bench(): Promise<{ engine: Engine; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-app-"));
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
    label: "desktop-test",
    gateTimeoutMs: 300,
  });
  closers.push(() => engine.close());
  return { engine, root };
}


/**
 * What a tool is really called from the model's side.
 *
 * The proxy qualifies names whenever it fronts more than one server, and this
 * app always does -- the user's servers plus Synartesis's own. Hard-coding the
 * bare name here would test a configuration the app never has.
 */
async function named(engine: Engine, bare: string): Promise<string> {
  const tools = await engine.tools();
  const found = tools.find((tool) => tool.name === bare || tool.name.endsWith(`__${bare}`));
  if (found === undefined) {
    throw new Error(`no tool like ${bare}; saw ${tools.map((t) => t.name).join(", ")}`);
  }
  return found.name;
}

describe("an agent talking through the proxy", () => {
  it("offers the upstream's tools to the model, in provider shape", async () => {
    const { engine } = await bench();
    const wanted = await named(engine, "write_file");
    const write = (await engine.tools()).find((tool) => tool.name === wanted);
    expect(write).toBeDefined();
    expect(write?.inputSchema["type"]).toBe("object");
  });

  it("journals what the model changed, and puts it back", async () => {
    const { engine, root } = await bench();
    const path = join(root, "report.txt");
    const original = "Region   Revenue\nNorth    412,000\n";
    writeFileSync(path, original);

    const provider = scripted([
      {
        text: "Updating the report.",
        calls: [
          {
            id: "c1",
            name: await named(engine, "write_file"),
            args: { path, content: "Region   Revenue\nNorth    000,000\n" },
          },
        ],
      },
      { text: "Done.", calls: [] },
    ]);

    await run({
      engine,
      provider,
      reasoning: "balanced",
      system: "You are a helpful assistant.",
      history: [],
      say: "Zero out the north revenue.",
    });

    // It really wrote.
    expect(readFileSync(path, "utf8")).toContain("000,000");

    // And the proxy captured it without the app doing anything.
    const actions = engine.journal.getActions(engine.runId);
    const write = actions.find((action) => action.tool === "write_file");
    expect(write?.status).toBe("applied");
    expect(write?.inverse).toBeDefined();

    // Which is the whole claim: undo is a function call, not a feature.
    const report = await rollback({
      journal: engine.journal,
      router: engine.router,
      runId: engine.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("can be asked what it changed, without undoing anything", async () => {
    const { engine, root } = await bench();
    const path = join(root, "notes.md");
    writeFileSync(path, "before\n");

    const provider = scripted([
      {
        text: "",
        calls: [
          { id: "c1", name: await named(engine, "write_file"), args: { path, content: "after\n" } },
        ],
      },
      { text: "Done.", calls: [] },
    ]);
    await run({
      engine, provider, reasoning: "balanced",
      system: "", history: [], say: "change it",
    });

    const found = await inspect({
      journal: engine.journal,
      router: engine.router,
      runId: engine.runId,
    });
    expect(tally(found).unchanged).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("after\n");
  });

  it("tells the model when the proxy held a call, rather than failing silently", async () => {
    const { engine, root } = await bench();
    // Creating a file has no prior state to restore, and this server cannot
    // delete, so the policy holds it for a person. Nobody answers here.
    const provider = scripted([
      {
        text: "",
        calls: [
          {
            id: "c1",
            name: await named(engine, "write_file"),
            args: { path: join(root, "new.txt"), content: "x" },
          },
        ],
      },
      { text: "I could not do that without approval.", calls: [] },
    ]);

    const events: string[] = [];
    await run({
      engine, provider, reasoning: "balanced", system: "", history: [], say: "make a file",
      onEvent: (event) => {
        if (event.kind === "result" && event.result?.failed === true) {
          events.push(event.result.text);
        }
      },
    });

    // The model has to be told, in the proxy's own words, or it tries again.
    expect(events.join(" ")).toMatch(/approv|cannot be undone|held/i);
    // And the conversation carried that back as a failed tool result.
    const asked = provider.asked[1];
    const last = asked?.messages[asked.messages.length - 1];
    expect(last?.role).toBe("tool");
    expect(last?.role === "tool" && last.failed).toBe(true);
  });

  it("stops instead of looping forever when the model keeps calling tools", async () => {
    const { engine, root } = await bench();
    const path = join(root, "loop.txt");
    writeFileSync(path, "x\n");
    const forever: Turn = {
      text: "",
      calls: [{ id: "c", name: await named(engine, "read_text_file"), args: { path } }],
    };
    const provider = scripted([forever, forever, forever, forever]);

    let stopped: string | undefined;
    await run({
      engine, provider, reasoning: "balanced", system: "", history: [], say: "go",
      maxRounds: 3,
      onEvent: (event) => {
        if (event.kind === "stopped") stopped = event.why;
      },
    });
    expect(stopped).toMatch(/3 rounds/);
  });
});

describe("shutting the engine down", () => {
  /**
   * The ordering inside `close`, which is not a detail.
   *
   * An empty session is taken out of the journal on the way down. That tidy-up
   * used to come last, after every upstream had been asked to stop -- and
   * asking a server to stop means waiting for a child process to go. An
   * application being quit is given no such time: macOS ended the process
   * mid-wait and the row survived, once per launch, thirteen times in an
   * afternoon. Nothing can be recorded after the client is shut, so the count
   * is final long before the servers are gone, and the tidy-up now happens
   * there.
   */
  it("takes an empty session back before it waits for servers to go", async () => {
    const root = mkdtempSync(join(tmpdir(), "synartesis-slow-"));
    dirs.push(root);
    const manifestPath = join(root, "synartesis.yaml");
    writeFileSync(
      manifestPath,
      `version: 1\nservers:\n  slow:\n    command: node\n` +
        `    args: ["${resolve("tests/helpers/lingering-server.mjs")}", "400"]\ntools: []\n`,
    );
    const journalPath = join(root, "journal.db");
    const engine = await startEngine({ manifestPath, journalPath, label: "desktop-test" });

    const began = Date.now();
    const closing = engine.close();
    await new Promise((wake) => setTimeout(wake, 150));

    // Read it from beside, while the close is still in flight.
    const journal = openJournal(journalPath);
    try {
      expect(journal.listRuns()).toHaveLength(0);
    } finally {
      journal.close();
    }

    await closing;
    // And the wait was real: if the server had gone instantly the check above
    // would have proved nothing about when the tidy-up happens.
    expect(Date.now() - began).toBeGreaterThan(300);
  });
});
