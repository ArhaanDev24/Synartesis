import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { rollback } from "../src/rollback/rollback.js";
import { inspect, tally, verdict } from "../src/rollback/inspect.js";
import { inMemoryUpstream } from "./helpers/harness.js";

/**
 * "Not there" and "I could not look" are different answers, and only one of
 * them makes an undo safe to send. A policy says which errors mean the first;
 * everything else has to stay the second.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const POLICY = [
  "version: 1",
  "servers:",
  "  vault:",
  "    command: node",
  "    args: []",
  "tools:",
  '  - match: "vault.put"',
  "    class: reversible",
  "    snapshot:",
  '      tool: "vault.get"',
  "      args:",
  '        key: "$.key"',
  "      absent_when:",
  '        - "not found"',
  "    inverse:",
  '      tool: "vault.put"',
  "      args:",
  '        key: "$.key"',
  '        value: "$snapshot.value"',
  '  - match: "vault.get"',
  "    class: readonly",
].join("\n");

/** The read fails for a reason that has nothing to do with absence. */
async function withDeniedRead(): Promise<{
  journal: Journal;
  router: Router;
  runId: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-absence-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const server = new McpServer({ name: "vault", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.registerTool("put", { description: "Write.", inputSchema: { key: z.string(), value: z.string() } }, () => ({
    content: [{ type: "text", text: "written" }],
  }));
  server.registerTool("get", { description: "Read.", inputSchema: { key: z.string() } }, () => ({
    // Not "not found". The caller has no right to look, which says nothing
    // whatsoever about whether the value is there.
    content: [{ type: "text", text: "permission denied" }],
    isError: true,
  }));
  const upstream = await inMemoryUpstream(server, "vault");
  const router = createRouter([upstream], parseManifest(POLICY, "m.yaml"));

  const runId = journal.beginRun("agent");
  const action = journal.recordPending({
    runId,
    server: "vault",
    tool: "put",
    args: { key: "k", value: "new" },
    class: "reversible",
  });
  journal.markApplied(action.actionId, {
    result: {},
    inverse: { server: "vault", tool: "put", args: { key: "k", value: "old" } },
    // Recorded with its absence rule, exactly as the proxy stores it.
    verify: { server: "vault", tool: "get", args: { key: "k" }, absentWhen: ["not found"] },
    postSnapshot: { present: true, value: { value: "new" } },
  });
  return { journal, router, runId };
}

describe("a read that fails for a reason other than absence", () => {
  it("is not reported by inspection as unchanged", async () => {
    const { journal, router, runId } = await withDeniedRead();
    const found = await inspect({ journal, router, runId });
    // The stored rule says absence looks like "not found". This was
    // "permission denied", so nothing at all is known about the resource.
    expect(found.resources[0]?.condition).toBe("unknowable");
  });

  it("does not let undo send the inverse on a made-up absence", async () => {
    const { journal, router, runId } = await withDeniedRead();
    const report = await rollback({ journal, router, runId });
    // Treating the failure as absence made the post-state "match" and the
    // inverse go out over a resource nobody could see.
    expect(report.steps.some((step) => step.kind === "revert" && step.verified)).toBe(false);
    expect(report.status).toBe("partial");
  });
});

describe("what a summary is allowed to claim", () => {
  it("does not call a session it could not read one with nothing left applied", async () => {
    const { journal, router, runId } = await withDeniedRead();
    const found = await inspect({ journal, router, runId });
    const said = verdict(found);

    expect(tally(found).unknowable).toBe(1);
    // The most reassuring sentence available, about a resource nobody could
    // look at. Absence of evidence is not evidence of absence.
    expect(said).not.toMatch(/nothing here is still applied/);
    expect(said).toMatch(/could not be checked|unknown/i);
  });

  it("says the post-state is missing rather than blaming a pre-read that exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-absence-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const server = new McpServer({ name: "vault", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.registerTool("get", { description: "Read.", inputSchema: { key: z.string() } }, () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const upstream = await inMemoryUpstream(server, "vault");
    const router = createRouter([upstream], parseManifest(POLICY, "m.yaml"));

    const runId = journal.beginRun("agent");
    const action = journal.recordPending({
      runId, server: "vault", tool: "put", args: { key: "k" }, class: "reversible",
    });
    // A declared pre-read, and a post-read that failed. Reported as "no
    // pre-read was declared", which is a different problem with a different
    // fix and sends people looking at their policy for nothing.
    journal.markApplied(action.actionId, {
      result: {},
      inverse: { server: "vault", tool: "put", args: { key: "k" } },
      verify: { server: "vault", tool: "get", args: { key: "k" }, absentWhen: ["not found"] },
    });

    const found = await inspect({ journal, router, runId });
    expect(found.resources[0]?.note ?? "").toMatch(/post-state/);
    expect(found.resources[0]?.note ?? "").not.toMatch(/no pre-read was declared/);
  });
});
