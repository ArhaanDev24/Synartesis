/**
 * When a server was last used, as `status` reports it.
 *
 * This was read off the newest five hundred actions, which answers a narrower
 * question than the one asked. A server whose last use had scrolled out of
 * that window came back with no timestamp at all, and the line a person reads
 * became "covered, nothing through it yet" -- not merely wrong but reassuring,
 * because it reads as though the connection were new rather than busy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { stateOf, type Connection } from "../src/install/connections.js";
import type { ConfigSite } from "../src/install/clients.js";

const dirs: string[] = [];
let journal: Journal | undefined;
afterEach(() => {
  journal?.close();
  journal = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A journal where `quiet` was used once, long before `busy` filled the window. */
function crowded(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-seen-"));
  dirs.push(dir);
  const open = openJournal(join(dir, "j.db"));
  journal = open;
  const run = open.beginRun("agent");
  const write = (server: string): void => {
    const held = open.recordPending({
      runId: run,
      server,
      tool: "write_file",
      args: { path: `/tmp/${server}.txt` },
      class: "reversible",
    });
    open.markApplied(held.actionId, { result: null });
  };
  write("quiet");
  // Comfortably past the five hundred the old window read.
  for (let at = 0; at < 600; at += 1) {
    write("busy");
  }
  return open;
}

const SITE: ConfigSite = {
  client: "claude-code",
  label: "Claude Code",
  format: "json",
  path: "/tmp/nowhere.json",
  scope: "user",
  at: ["mcpServers"],
};

function connection(server: string, lastSeen: string | undefined): Connection {
  return {
    client: "claude-code",
    scope: "user",
    path: SITE.path,
    server,
    covered: true,
    missing: false,
    ...(lastSeen === undefined ? {} : { lastSeen }),
    site: SITE,
  };
}

describe("when a server was last used", () => {
  it("finds a use that has fallen out of the recent window", () => {
    const open = crowded();
    const seen = open.lastSeenPerServer();
    expect(seen.get("quiet")).toBeDefined();
    expect(seen.get("busy")).toBeDefined();
  });

  it("does not call a long-used server one that has never been used", () => {
    const open = crowded();
    const lastSeen = open.lastSeenPerServer().get("quiet");
    const said = stateOf(connection("quiet", lastSeen));
    expect(said).not.toContain("nothing through it yet");
    expect(said).toContain("covered");
  });

  it("still says so for a server nothing has ever gone through", () => {
    const open = crowded();
    expect(open.lastSeenPerServer().get("never")).toBeUndefined();
    expect(stateOf(connection("never", undefined))).toContain("nothing through it yet");
  });
});
