import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openJournal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { serveHttp, type HttpServer } from "../src/proxy/http.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const TOKEN = "a-token-long-enough-to-pass";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

/** A server whose one tool takes a while and says nothing until it is done. */
async function slowServe(host: string, idleSeconds: number, workMs: number): Promise<HttpServer> {
  const tools = new McpServer({ name: "slow", version: "1" });
  tools.registerTool("build", {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, workMs));
    return { content: [{ type: "text", text: "built" }] };
  });
  const upstream = await inMemoryUpstream(tools, "work");
  const dir = mkdtempSync(join(tmpdir(), "synartesis-serve-"));
  const journal = openJournal(join(dir, "journal.db"));
  const manifest = parseManifest(
    'version: 1\nservers:\n  work:\n    command: "true"\ntools:\n  - match: "work.build"\n    class: readonly\n',
    "m.yaml",
  );
  const served = await serveHttp({
    port: 0,
    host,
    token: TOKEN,
    idleSeconds,
    create: () => createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate }),
    log: { info: () => undefined, warn: () => undefined },
  });
  cleanups.push(async () => {
    await served.close();
    await upstream.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return served;
}

async function agent(url: string): Promise<Client> {
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(
    // @ts-expect-error -- the SDK's sessionId typing under exactOptionalPropertyTypes, as in upstream.ts.
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  cleanups.push(() => client.close());
  return client;
}

describe("serving over http", () => {
  it("answers on an IPv6 loopback address", async () => {
    // The base URL was built without brackets, `new URL` refused it, and
    // every request came back as a 400.
    const served = await slowServe("::1", 60, 0);
    const client = await agent(`http://[::1]:${String(served.port)}/mcp`);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["build"]);
  });

  it("does not sweep a session while its call is still running", { timeout: 15000 }, async () => {
    // Quiet is not idle: a long call sends nothing while it works, and the
    // sweep ended its session under it.
    const served = await slowServe("127.0.0.1", 1, 3500);
    const client = await agent(`http://127.0.0.1:${String(served.port)}/mcp`);
    const result = await client.callTool({ name: "build", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "built" }]);
  });
});
