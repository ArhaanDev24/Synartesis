import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { openJournal, type Journal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { connectStdioUpstream, type Upstream } from "../src/proxy/upstream.js";

/**
 * A client refusing to call a tool at all is the worst failure this proxy can
 * pass along, because nothing reaches it and there is nothing in the journal
 * to explain the silence.
 *
 * Found by using it: the official filesystem server declares its outputSchema
 * as draft-07, and a client whose validator only knows 2020-12 would not send
 * the call. The run sat open with zero actions. The real server is used here
 * rather than a fixture, because a fixture would only declare whatever dialect
 * this test decided to give it.
 */
const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

const dirs: string[] = [];
let journal: Journal | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
  journal?.close();
  journal = undefined;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function proxiedTools(): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-dialect-"));
  dirs.push(dir);
  journal = openJournal(join(dir, "journal.db"));
  upstream = await connectStdioUpstream({
    name: "fs",
    command: "node",
    args: [FS_SERVER, dir],
    stderr: "ignore",
  });
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest: parseManifest(
      `version: 1\nservers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${dir}"]\ntools:\n  - match: "fs.read_*"\n    class: readonly\n`,
      "manifest.yaml",
    ),
    journal,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([proxy.server.connect(serverTransport), client.connect(clientTransport)]);
  await proxy.ready;
  const { tools } = await client.listTools();
  return tools;
}

describe("schema dialects a client may refuse", () => {
  it("does not advertise an output dialect a client may refuse", async () => {
    const tools = await proxiedTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(JSON.stringify(tool["outputSchema"] ?? {})).not.toContain("$schema");
    }
  });

  it("leaves inputSchema exactly as the server wrote it", async () => {
    // Only the output schema was refused, and the proxy stays transparent
    // everywhere it can be. tests/proxy-stdio.test.ts holds it to that.
    const tools = await proxiedTools();
    const write = tools.find((tool) => tool.name === "write_file");
    expect(JSON.stringify(write?.["inputSchema"])).toContain("$schema");
  });

  it("changes nothing about the schema except the dialect it claims", async () => {
    const tools = await proxiedTools();
    const write = tools.find((tool) => tool.name === "write_file");
    // The shape the agent has to satisfy is exactly what the server asked for.
    expect(write?.["inputSchema"]).toMatchObject({
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    });
    expect(write?.["outputSchema"]).toEqual({
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    });
  });

  it("leaves the server's own tool names alone", async () => {
    const tools = await proxiedTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["write_file", "read_text_file"]));
  });
});
