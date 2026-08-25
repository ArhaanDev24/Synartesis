import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROXY = resolve("dist/proxy.js");
const FIXTURE = resolve("dist/toy-crm.js");
const TOKEN = "a-token-long-enough-to-pass";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function workspace(): { manifest: string; journal: string } {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-http-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const manifest = join(dir, "synartesis.yaml");
  writeFileSync(
    manifest,
    `version: 1\nservers:\n  crm:\n    command: node\n    args: ["${FIXTURE}"]\ntools:\n  - match: "crm.get_customer"\n    class: readonly\n`,
  );
  return { manifest, journal: join(dir, "journal.db") };
}

async function serve(extra: readonly string[] = []): Promise<{ port: number; child: ChildProcess }> {
  const space = workspace();
  const port = 9200 + Math.floor(Math.random() * 400);
  const child = spawn(
    "node",
    [PROXY, "--manifest", space.manifest, "--journal", space.journal, "--http", String(port), ...extra],
    { stdio: "ignore" },
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  // Wait for the port to answer rather than guessing at a delay.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/mcp`, { method: "POST" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, child };
}

function post(port: number, body: unknown, token: string | undefined, session?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(session === undefined ? {} : { "mcp-session-id": session }),
    },
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
};

describe("serving over http, for clients that will not start a process", () => {
  it("refuses to start without a token, because this is write access on a socket", async () => {
    const space = workspace();
    const child = spawn("node", [PROXY, "--manifest", space.manifest, "--journal", space.journal, "--http", "9199"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    cleanups.push(() => {
    child.kill("SIGKILL");
  });
    const said = await new Promise<string>((resolve_) => {
      let text = "";
      child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      child.on("exit", () => {
        resolve_(text);
      });
    });
    expect(said).toMatch(/--token/);
    expect(said).toMatch(/16 characters/);
  });

  it("turns away a request with no token, and one with the wrong token", async () => {
    const { port } = await serve(["--token", TOKEN]);
    expect((await post(port, INIT, undefined)).status).toBe(401);
    expect((await post(port, INIT, "wrong-but-long-enough")).status).toBe(401);
  });

  it("serves the same tools it serves over stdio", async () => {
    const { port } = await serve(["--token", TOKEN]);
    const opened = await post(port, INIT, TOKEN);
    expect(opened.status).toBe(200);
    const session = opened.headers.get("mcp-session-id");
    expect(session).toBeTruthy();

    await post(port, { jsonrpc: "2.0", method: "notifications/initialized" }, TOKEN, session ?? "");
    const listed = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, TOKEN, session ?? "");
    expect(await listed.text()).toContain("get_customer");
  });
});

describe("a session whose client vanished", () => {
  it("is swept, rather than held for the life of the process", { timeout: 20000 }, async () => {
    // Sessions were removed only on a clean close. A client that drops -- a
    // network blip, a connector that gives up -- left its entry, and its proxy
    // and upstream handles, in the map forever. stdio cannot leak this way;
    // a long-running http server can.
    const { port } = await serve(["--token", TOKEN, "--http-idle", "1"]);
    const opened = await post(port, INIT, TOKEN);
    const session = opened.headers.get("mcp-session-id") ?? "";
    expect(session).toBeTruthy();

    // Alive while it is being used.
    await post(port, { jsonrpc: "2.0", method: "notifications/initialized" }, TOKEN, session);
    const early = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, TOKEN, session);
    expect(early.status).toBe(200);

    // Then abandoned, with no DELETE and no close.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const late = await post(port, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, TOKEN, session);
    expect(late.status).toBe(400);
    expect(await late.text()).toMatch(/no such session/i);
  });
});
