import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { openJournal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { listAll } from "../src/manifest/verify.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

function withTool(name: string): McpServer {
  const server = new McpServer({ name, version: "1" });
  server.registerTool(`${name}_tool`, {}, () => ({ content: [] }));
  return server;
}

function resourcesOnly(): McpServer {
  const server = new McpServer({ name: "docs", version: "1" });
  server.registerResource("readme", "docs://readme", {}, () => ({ contents: [{ uri: "docs://readme", text: "hi" }] }));
  return server;
}

describe("a server with nothing to say about tools", () => {
  it("does not stop the others' tools being read at start-up", async () => {
    const docs = await inMemoryUpstream(resourcesOnly(), "docs");
    const work = await inMemoryUpstream(withTool("work"), "work");
    cleanups.push(() => docs.close(), () => work.close());
    const listed = await listAll([docs, work]);
    expect(listed.get("docs")).toEqual([]);
    expect(listed.get("work")?.map((tool) => tool.name)).toEqual(["work_tool"]);
  });
});

describe("one server failing to list its tools", () => {
  it("leaves out only that server's tools, not everybody's", async () => {
    const a = await inMemoryUpstream(withTool("a"), "a");
    const b = await inMemoryUpstream(withTool("b"), "b");
    const real = b.client.request.bind(b.client);
    b.client.request = ((request, schema, options) =>
      request.method === "tools/list"
        ? Promise.reject(new Error("Connection closed"))
        : real(request, schema, options));
    const dir = mkdtempSync(join(tmpdir(), "synartesis-spared-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const manifest = parseManifest(
      'version: 1\nservers:\n  a:\n    command: "true"\n  b:\n    command: "true"\n',
      "m.yaml",
    );
    const proxy = createProxyServer({ upstreams: [a, b], manifest, journal, gate: autoApproveGate });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "agent", version: "0" });
    await Promise.all([proxy.server.connect(st), agent.connect(ct)]);
    cleanups.push(() => agent.close(), () => a.close(), () => b.close());

    const { tools } = await agent.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["a__a_tool"]);
  });
});

describe("two servers whose tools come out with the same name", () => {
  it("lists the name once, rather than offering a name that goes to only one of them", async () => {
    const one = new McpServer({ name: "a", version: "1" });
    one.registerTool("_x", {}, () => ({ content: [] }));
    const two = new McpServer({ name: "a_", version: "1" });
    two.registerTool("x", {}, () => ({ content: [] }));
    const a = await inMemoryUpstream(one, "a");
    const b = await inMemoryUpstream(two, "a_");
    const dir = mkdtempSync(join(tmpdir(), "synartesis-collide-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const manifest = parseManifest('version: 1\nservers:\n  a:\n    command: "true"\n  a_:\n    command: "true"\n', "m.yaml");
    const proxy = createProxyServer({ upstreams: [a, b], manifest, journal, gate: autoApproveGate });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "agent", version: "0" });
    await Promise.all([proxy.server.connect(st), agent.connect(ct)]);
    cleanups.push(() => agent.close(), () => a.close(), () => b.close());

    const names = (await agent.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "a___x")).toHaveLength(1);
  });
});
