import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../app/main/agent.js";
import { startEngine, type Engine } from "../app/main/engine.js";
import type { Ask, Provider, Turn } from "../app/providers/types.js";

/**
 * Synartesis offered to the model as tools.
 *
 * The point of the app: "what did you change?" and "put that back" are things
 * you say, not commands you look up. The point of these tests is the other
 * half -- that handing a model the undo machinery does not hand it the ability
 * to overwrite somebody's work. It may look as much as it likes and must ask
 * before it changes anything, which is the rule the product applies to every
 * other server applied to the product.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

async function bench(
  options: { gateTimeoutMs?: number; onApprovalNeeded?: (r: { actionId: string }) => void } = {},
): Promise<{ engine: Engine; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-toolset-"));
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
    label: "toolset-test",
    gateTimeoutMs: options.gateTimeoutMs ?? 300,
    ...(options.onApprovalNeeded === undefined ? {} : { onApprovalNeeded: options.onApprovalNeeded }),
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

/** Write a file through the model, so there is something to ask about. */
async function damage(engine: Engine, path: string): Promise<void> {
  writeFileSync(path, "before\n");
  await run({
    engine,
    provider: scripted([
      {
        text: "",
        calls: [
          { id: "c1", name: await named(engine, "write_file"), args: { path, content: "after\n" } },
        ],
      },
      { text: "done", calls: [] },
    ]),
    reasoning: "balanced",
    system: "",
    history: [],
    say: "change it",
  });
}

describe("Synartesis offered to the model", () => {
  it("puts its own tools in the list the model is given", async () => {
    const { engine } = await bench();
    const names = (await engine.tools()).map((tool) => tool.name);
    // Qualified, because the proxy fronts the user's servers and this one.
    expect(names).toContain(engine.ownTool("list_sessions"));
    expect(names).toContain(engine.ownTool("what_changed"));
    expect(names).toContain(engine.ownTool("undo_session"));
  });

  it("never offers a way to overwrite somebody's edit", async () => {
    const { engine } = await bench();
    const names = (await engine.tools()).map((tool) => tool.name);
    // --force is the one thing a person decides in front of a diff. A model
    // that can reach it has been handed exactly what this tool prevents.
    expect(names.some((name) => /force/i.test(name))).toBe(false);
    for (const tool of await engine.tools()) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/force/i);
    }
  });

  it("lets the model ask what changed, and answers from the world", async () => {
    const { engine, root } = await bench();
    const path = join(root, "notes.md");
    await damage(engine, path);

    const answer = await engine.call(engine.ownTool("what_changed"), { session: engine.runId });
    expect(answer.failed).toBe(false);
    expect(answer.text).toMatch(/unchanged/);

    // Now somebody edits it, and the same question gives a different answer.
    writeFileSync(path, "a human wrote this\n");
    const again = await engine.call(engine.ownTool("what_changed"), { session: engine.runId });
    expect(again.text).toMatch(/changed/);
  });

  it("lets the model plan an undo without doing any of it", async () => {
    const { engine, root } = await bench();
    const path = join(root, "plan.md");
    await damage(engine, path);

    const plan = await engine.call(engine.ownTool("preview_undo"), { session: engine.runId });
    expect(plan.failed).toBe(false);
    expect(plan.text).toMatch(/revert/);
    // A preview that changed the file would be the worst bug in the product.
    expect(readFileSync(path, "utf8")).toBe("after\n");
  });

  it("holds an undo for a person, and does not do it unasked", async () => {
    const held: string[] = [];
    const { engine, root } = await bench({
      gateTimeoutMs: 200,
      onApprovalNeeded: (request) => held.push(request.actionId),
    });
    const path = join(root, "held.md");
    await damage(engine, path);

    // Nobody answers, so the gate times out and the undo never runs.
    const attempt = await engine.call(engine.ownTool("undo_session"), { session: engine.runId });

    expect(held).toHaveLength(1);
    expect(attempt.failed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("after\n");
  });

  it("does the undo once a person says yes", async () => {
    const { engine, root } = await bench({
      gateTimeoutMs: 4000,
      // A person clicking Approve in the window is exactly this call.
      onApprovalNeeded: (request) => {
        engine.journal.approve(request.actionId, "arhaan");
      },
    });
    const path = join(root, "approved.md");
    await damage(engine, path);

    const done = await engine.call(engine.ownTool("undo_session"), { session: engine.runId });
    expect(done.failed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("before\n");
  });

  it("refuses to guess which session was meant", async () => {
    const { engine } = await bench();
    const answer = await engine.call(engine.ownTool("show_session"), { session: "nosuchthing" });
    expect(answer.text).toMatch(/No session starts with/);
  });

  it("reaches all of this through the model, not just directly", async () => {
    const { engine, root } = await bench();
    const path = join(root, "spoken.md");
    await damage(engine, path);

    // What the app is for: the person asks in words and the model uses the
    // same machinery they would have.
    const provider = scripted([
      {
        text: "",
        calls: [
          { id: "c1", name: engine.ownTool("what_changed"), args: { session: engine.runId } },
        ],
      },
      { text: "One file changed, and it is still recoverable.", calls: [] },
    ]);
    const results: string[] = [];
    await run({
      engine, provider, reasoning: "balanced", system: "", history: [],
      say: "what did you change?",
      onEvent: (event) => {
        if (event.kind === "result" && event.result !== undefined) results.push(event.result.text);
      },
    });
    expect(results.join("\n")).toMatch(/unchanged|changed/);
  });
});
