import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "../src/proxy/upstream.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate } from "./helpers/harness.js";
import type { Gate } from "../src/gate/gate.js";

/** Nobody is there to say yes, which is the state a held call starts in. */
const refuseGate: Gate = {
  decide: async () =>
    await Promise.resolve({ approved: false, awaiting: true, reason: "ask a person" }),
};

/**
 * What the shipped memory policy actually does, against the real server.
 *
 * Until this existed the policy said `provenance: live` and the README said
 * its recovery guarantees were unproven, and both were right: the tools had
 * been checked against the server, and no undo had ever been run. A policy can
 * name every tool correctly, take the arguments the server really wants, and
 * still resolve an inverse that puts nothing back -- and that failure looks
 * exactly like success, because the drift check passes and the report says
 * rolled_back.
 *
 * So this writes to a real knowledge graph, undoes it, and compares the graph
 * file. It is the only thing in the suite entitled to say the memory adapter
 * works, and it is deliberately the same shape as the filesystem one.
 */

const MEMORY_SERVER = resolve("node_modules/@modelcontextprotocol/server-memory/dist/index.js");

/**
 * The version these guarantees were established against. A server that has
 * changed its tools or the shape of its answers has not been tested here,
 * whatever this file says.
 */
const TESTED_AGAINST = "2026.8.31";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Bench {
  readonly client: Client;
  readonly journal: Journal;
  readonly router: Router;
  readonly runId: string;
  readonly graphPath: string;
  /** The graph as the server has written it, line by line, order-insensitive. */
  graph: () => readonly string[];
}

interface Seeded {
  /** Lines to write into the graph before the server ever starts. */
  readonly seed?: readonly string[];
  /** An existing graph to open a second session against. */
  readonly graphPath?: string;
  /** Refuse everything the policy holds, which is what a person's absence looks like. */
  readonly refuse?: boolean;
}

/**
 * The shipped policy, pointed at a graph file that exists only for this test.
 *
 * `seed` writes the graph directly, before anything connects, which is the
 * only way to have data the run did not make. Creating it through the client
 * would put it in the same session, and undoing the session would correctly
 * take it away again -- a test built that way asserts that undo deletes
 * everything, which is the failure it was meant to catch.
 */
async function bench(options: Seeded = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-memory-adapter-"));
  dirs.push(root);
  const graphPath = options.graphPath ?? join(root, "memory.json");
  if (options.seed !== undefined) {
    writeFileSync(graphPath, `${options.seed.join("\n")}\n`);
  }
  const journal = openJournal(join(root, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  // The shipped file, with only the command swapped for the copy installed
  // here. Everything under `tools:` -- which is the part being tested -- is
  // exactly what ships.
  // The policy reads MEMORY_FILE_PATH out of the environment, which is the
  // behaviour, not a fault: the graph has to be the one the client already
  // uses. Set before parsing, to this test's own file.
  process.env["MEMORY_FILE_PATH"] = graphPath;
  const shipped = readFileSync("manifests/memory.yaml", "utf8");
  const source = shipped.replace(
    /servers:\n {2}memory:\n {4}command:.*\n {4}args:.*\n/,
    `servers:\n  memory:\n    command: "node"\n    args: ["${MEMORY_SERVER}"]\n`,
  );
  const manifest = parseManifest(source, "manifests/memory.yaml");

  const env = { MEMORY_FILE_PATH: graphPath };
  const upstream: Upstream = await connectStdioUpstream({
    name: "memory",
    command: "node",
    args: [MEMORY_SERVER],
    env,
    stderr: "ignore",
  });
  closers.push(() => upstream.close());

  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest,
    journal,
    gate: options.refuse === true ? refuseGate : autoApproveGate,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "adapter", version: "0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  closers.push(async () => {
    await client.close();
  });
  const runId = await proxy.ready;

  return {
    client,
    journal,
    router: createRouter([upstream], manifest),
    runId,
    graphPath,
    // Sorted: this server appends, so re-creating an entity that was deleted
    // puts it back at the end of the file. A byte comparison would call that a
    // failure when the graph is identical, and the graph is what anybody has.
    graph: () =>
      existsSync(graphPath)
        ? readFileSync(graphPath, "utf8").split("\n").filter((line) => line !== "").sort()
        : [],
  };
}

const entity = (name: string, type: string, observations: readonly string[]): string =>
  JSON.stringify({ type: "entity", name, entityType: type, observations });

const relation = (from: string, to: string, relationType: string): string =>
  JSON.stringify({ type: "relation", from, to, relationType });

describe(`the shipped memory policy, against server ${TESTED_AGAINST}`, () => {
  it("takes back what the agent added and leaves what was already there", async () => {
    const existing = [
      entity("Ada", "person", ["writes notes"]),
      entity("Synartesis", "project", ["an undo layer"]),
    ];
    const active = await bench({ seed: existing });

    await active.client.callTool({
      name: "create_entities",
      arguments: {
        entities: [{ name: "Grace", entityType: "person", observations: ["added by the agent"] }],
      },
    });
    expect(active.graph()).toHaveLength(3);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");

    // Both halves. Gone is easy; still there is the one that matters.
    expect(active.graph()).toEqual([...existing].sort());
  }, 60000);

  it("does not delete an entity the agent only tried to create", async () => {
    // This server ignores a create for a name it already holds, answering with
    // an empty list. An inverse written from the arguments rather than the
    // result would delete the original -- an agent's no-op costing somebody
    // data they had before it ran. The policy says `$result.entities[].name`
    // for exactly this reason; this is the test that the reason is real.
    const existing = [entity("Ada", "person", ["the original, worth keeping"])];
    const active = await bench({ seed: existing });

    await active.client.callTool({
      name: "create_entities",
      arguments: {
        entities: [{ name: "Ada", entityType: "person", observations: ["a duplicate"] }],
      },
    });
    // Nothing happened, which is what makes the undo below dangerous.
    expect(active.graph()).toEqual(existing);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(active.graph()).toEqual(existing);
  }, 60000);

  it("puts a deleted relation back", async () => {
    const existing = [
      entity("Ada", "person", []),
      entity("Synartesis", "project", []),
      relation("Ada", "Synartesis", "works_on"),
    ];
    const active = await bench({ seed: existing });

    await active.client.callTool({
      name: "delete_relations",
      arguments: { relations: [{ from: "Ada", to: "Synartesis", relationType: "works_on" }] },
    });
    expect(active.graph().some((line) => line.includes("works_on"))).toBe(false);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(active.graph()).toEqual([...existing].sort());
  }, 60000);

  it("takes back a relation the agent drew between things that already existed", async () => {
    // The last write path with an inverse of its own. Both entities are there
    // before the run, so undoing must remove the relation and nothing else --
    // a compensation that took the entities with it would be indistinguishable
    // from success in a test that created them too.
    const existing = [entity("Ada", "person", []), entity("Synartesis", "project", [])];
    const active = await bench({ seed: existing });

    await active.client.callTool({
      name: "create_relations",
      arguments: { relations: [{ from: "Ada", to: "Synartesis", relationType: "works_on" }] },
    });
    expect(active.graph().some((line) => line.includes("works_on"))).toBe(true);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");
    expect(active.graph()).toEqual([...existing].sort());
  }, 60000);

  it("stops a delete of an entity rather than pretending it could undo one", async () => {
    // Deleting an entity takes its observations and every relation touching it,
    // and a policy declares one inverse -- one call cannot put back both. So
    // the policy calls it irreversible and gated, and the entire value of that
    // is that it happens before the data is gone rather than after.
    const existing = [entity("Ada", "person", ["irreplaceable"])];
    const active = await bench({ seed: existing, refuse: true });

    const attempt = await active.client
      .callTool({ name: "delete_entities", arguments: { entityNames: ["Ada"] } })
      .catch((error: unknown) => error);

    expect(String(attempt)).toContain("holding this call for approval");
    // The point of the hold: the data is still there to be argued about.
    expect(active.graph()).toEqual(existing);
  }, 60000);
});
