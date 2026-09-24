import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { loadManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter, type Router } from "../src/proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "../src/proxy/upstream.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate } from "./helpers/harness.js";
import type { Gate } from "../src/gate/gate.js";

/**
 * What the shipped git policy actually does, against the real server.
 *
 * The README said for a long time that git was "checked only for tool
 * existence", and it was the truthful thing to say: `check` starts the server
 * and confirms every tool the policy names is there, which proves the policy
 * can be loaded and proves nothing at all about recovery. A compensation that
 * resolves to a real tool taking real arguments can still put nothing back,
 * and that failure reports `rolled_back`.
 *
 * So this stages real changes in a real repository, undoes them, and reads the
 * index back with git itself rather than through the server being tested.
 *
 * It is a smaller claim than the filesystem and memory files make, and that is
 * the policy's shape rather than this file's: one tool here is compensable and
 * the rest are permanent by construction. The permanent ones are worth a test
 * too -- "held" and "let through and reported" are behaviours somebody depends
 * on, and a policy that silently stopped doing either would pass every other
 * test in this suite.
 */

/**
 * The version these guarantees were established against. A server that has
 * changed its tools or the shape of its answers has not been tested here,
 * whatever this file says.
 */
const TESTED_AGAINST = "1.30.0";

/** Nobody is there to say yes, which is the state a held call starts in. */
const refuseGate: Gate = {
  decide: async () =>
    await Promise.resolve({ approved: false, awaiting: true, reason: "ask a person" }),
};

/**
 * The server is a Python package, so unlike the other two adapters it is not
 * sitting in node_modules. Missing, this file would skip -- and a proof that
 * quietly does not run is worth less than no proof, because the suite goes
 * green either way. It fails instead, with the one sentence that fixes it.
 */
function requireUvx(): void {
  try {
    execFileSync("uvx", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "the git adapter test needs `uvx` on PATH, because mcp-server-git is a " +
        "Python package: see https://docs.astral.sh/uv/getting-started/installation/",
    );
  }
}

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
  readonly repo: string;
  /** git itself, not the server under test, so the assertions have a witness. */
  readonly git: (...args: string[]) => string;
  /** Paths staged for the next commit, in git's order. */
  readonly staged: () => readonly string[];
  /** Paths changed in the working tree but not staged. */
  readonly unstaged: () => readonly string[];
}

/**
 * A repository with one commit in it, behind the policy exactly as it ships.
 *
 * Nothing is rewritten here. The other two adapters have to swap the server
 * command for the copy installed locally; this server takes `repo_path` per
 * call, so the file under `manifests/` is loaded as-is and the temporary
 * repository is named by the arguments instead.
 */
async function bench(options: { refuse?: boolean } = {}): Promise<Bench> {
  requireUvx();
  const root = mkdtempSync(join(tmpdir(), "synartesis-git-adapter-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  // Set locally: a machine whose global config has neither cannot commit, and
  // a test that depends on the developer's ~/.gitconfig is not a test.
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Synartesis test");
  writeFileSync(join(repo, "agent.txt"), "one\n");
  writeFileSync(join(repo, "human.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "seed");

  const journal = openJournal(join(root, "journal.db"));
  closers.push(() => {
    journal.close();
  });

  const manifest = loadManifest("manifests/git.yaml");
  const server = manifest.servers["git"];
  if (server?.url !== undefined || server === undefined) {
    throw new Error("the shipped git policy no longer declares a local `git` server");
  }
  const upstream: Upstream = await connectStdioUpstream({
    name: "git",
    command: server.command,
    args: server.args,
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

  const lines = (out: string): readonly string[] =>
    out.split("\n").filter((line) => line !== "");

  return {
    client,
    journal,
    router: createRouter([upstream], manifest),
    runId,
    repo,
    git,
    staged: () => lines(git("diff", "--cached", "--name-only")),
    unstaged: () => lines(git("diff", "--name-only")),
  };
}

describe(`the shipped git policy, against server ${TESTED_AGAINST}`, () => {
  it("takes the agent's staging back off the index", async () => {
    const active = await bench();
    writeFileSync(join(active.repo, "agent.txt"), "two\n");

    await active.client.callTool({
      name: "git_add",
      arguments: { repo_path: active.repo, files: ["agent.txt"] },
    });
    expect(active.staged()).toEqual(["agent.txt"]);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");

    // Both halves. Unstaged is the undo; the edit still being there is the
    // reason this is safe to do at all -- a "reset" that reached the working
    // tree would be destroying the work rather than unstaging it.
    expect(active.staged()).toEqual([]);
    expect(active.unstaged()).toEqual(["agent.txt"]);
    expect(active.git("show", "-s", "--format=%s", "HEAD").trim()).toBe("seed");
  }, 120000);

  it("takes a person's staging with it, which is why it is a compensation", async () => {
    // The policy's own comment says `git_reset` here unstages everything, not
    // only what the call staged. That is the sentence this test exists to keep
    // true: if a later server version gained a path-scoped reset and the
    // policy kept the old inverse, the compensation would be describable as an
    // undo and it still would not be one.
    const active = await bench();
    writeFileSync(join(active.repo, "agent.txt"), "two\n");
    writeFileSync(join(active.repo, "human.txt"), "two\n");

    active.git("add", "human.txt");
    expect(active.staged()).toEqual(["human.txt"]);

    await active.client.callTool({
      name: "git_add",
      arguments: { repo_path: active.repo, files: ["agent.txt"] },
    });
    expect(active.staged()).toEqual(["agent.txt", "human.txt"]);

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    expect(report.status).toBe("rolled_back");

    // The overreach, asserted rather than described. Nothing is lost -- both
    // edits are still in the working tree -- but a person's staging is gone,
    // and the report has to be honest about which of those two it did.
    expect(active.staged()).toEqual([]);
    expect(active.unstaged()).toEqual(["agent.txt", "human.txt"]);

    const step = report.steps.find((entry) => entry.tool === "git_add");
    expect(step?.kind).toBe("revert");
    // No read here can report the index as data, so nothing was compared
    // before acting. That is what `verified: false` means, and it is the flag
    // that stops this being presented as a checked restoration.
    expect(step?.verified).toBe(false);
  }, 120000);

  it("holds a commit rather than pretending it can be taken back", async () => {
    const active = await bench({ refuse: true });
    writeFileSync(join(active.repo, "agent.txt"), "two\n");
    active.git("add", "agent.txt");

    const attempt = await active.client
      .callTool({
        name: "git_commit",
        arguments: { repo_path: active.repo, message: "the agent's commit" },
      })
      .catch((error: unknown) => error);

    expect(String(attempt)).toContain("holding this call for approval");

    // The one that matters: the commit did not happen. A gate that reported a
    // hold after the call went out would be a worse failure than no gate.
    expect(active.git("show", "-s", "--format=%s", "HEAD").trim()).toBe("seed");
    expect(active.staged()).toEqual(["agent.txt"]);
  }, 120000);

  it("lets a branch switch through, and reports it as something undo cannot take back", async () => {
    // `gate: never` on an irreversible tool is a deliberate pairing and an
    // unusual one, so it is worth pinning from both ends: the call is not
    // held, and the undo does not claim to have reversed it.
    const active = await bench({ refuse: true });
    active.git("branch", "spare");

    const answer = await active.client.callTool({
      name: "git_checkout",
      arguments: { repo_path: active.repo, branch_name: "spare" },
    });
    expect(answer.isError ?? false).toBe(false);
    expect(active.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("spare");

    const report = await rollback({
      journal: active.journal,
      router: active.router,
      runId: active.runId,
    });
    // Reported and stepped over, not halted on: a permanent action is a fact
    // about the run, not an obstacle in it.
    expect(report.status).toBe("partial");
    const step = report.steps.find((entry) => entry.tool === "git_checkout");
    expect(step?.kind).toBe("permanent");
    expect(active.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("spare");
  }, 120000);

  it("is the policy that actually ships, not one written for this test", () => {
    // Unlike the other two adapters this bench rewrites nothing at all, so the
    // only thing to guard is that the rules still say what was tested above.
    const shipped = loadManifest("manifests/git.yaml");
    const byMatch = new Map(shipped.tools.map((tool) => [tool.match, tool] as const));

    const add = byMatch.get("git.git_add");
    expect(add?.class).toBe("compensable");
    expect(add?.inverse?.tool).toBe("git.git_reset");
    // No `verify`, so the compensation above is unverified by construction
    // rather than by accident.
    expect(add?.verify).toBeUndefined();

    expect(byMatch.get("git.git_commit")?.class).toBe("irreversible");
    expect(byMatch.get("git.git_commit")?.gate).toBe("always");
    expect(byMatch.get("git.git_checkout")?.class).toBe("irreversible");
    expect(byMatch.get("git.git_checkout")?.gate).toBe("never");
  });
});
