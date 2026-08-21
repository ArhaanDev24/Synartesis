import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ManifestError } from "../src/errors.js";
import { openJournal, type Journal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createToyCrmServer } from "../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../fixtures/toy-crm/store.js";
import { autoApproveGate, inMemoryUpstream } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  // Reverse order: clients must disconnect before the journal they write to
  // on close is shut.
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function tempJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-multi-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return journal;
}

/** A second server with its own tools, prompts and resources. */
function createNotesServer(): McpServer {
  const server = new McpServer(
    { name: "toy-notes", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.registerTool(
    "get_customer",
    { description: "Deliberately collides with the CRM tool name.", inputSchema: {} },
    () => ({ content: [{ type: "text", text: "from-notes" }] }),
  );
  server.registerTool(
    "append_note",
    { description: "Append a note.", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text: `noted:${text}` }] }),
  );
  server.registerResource(
    "notes",
    "notes://all",
    { description: "All notes.", mimeType: "text/plain" },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "note one" }] }),
  );
  server.registerPrompt(
    "summarise",
    { description: "Summarise notes." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: "summarise" } }] }),
  );
  return server;
}

const MANIFEST = `version: 1
servers:
  crm: { command: node, args: [] }
  notes: { command: node, args: [] }
tools:
  - match: "crm.get_customer"
    class: readonly
  - match: "notes.get_customer"
    class: readonly
  - match: "notes.append_note"
    class: irreversible
`;

async function connectMulti(journal: Journal): Promise<{ client: Client; store: ToyCrmStore }> {
  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstreams = [
    await inMemoryUpstream(createToyCrmServer(store), "crm"),
    await inMemoryUpstream(createNotesServer(), "notes"),
  ];
  const proxy = createProxyServer({
    gate: autoApproveGate,
    upstreams,
    manifest: parseManifest(MANIFEST, "manifest.yaml"),
    journal,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "multi-client", version: "0.0.0" });
  await Promise.all([proxy.server.connect(st), client.connect(ct)]);
  await proxy.ready;
  cleanups.push(async () => {
    await client.close();
    for (const upstream of upstreams) {
      await upstream.close();
    }
  });
  return { client, store };
}

describe("multi-server namespacing", () => {
  it("prefixes every tool once more than one server is configured", async () => {
    const { client } = await connectMulti(tempJournal());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain("crm__get_customer");
    expect(names).toContain("notes__get_customer");
    expect(names).toContain("notes__append_note");
    // Nothing is exposed bare, so a name never changes meaning depending on
    // which other servers happen to be configured alongside it.
    expect(names.every((n) => n.includes("__"))).toBe(true);
  });

  it("keeps a colliding tool name usable on both servers", async () => {
    const { client, store } = await connectMulti(tempJournal());
    const fromNotes = await client.callTool({ name: "notes__get_customer", arguments: {} });
    expect(JSON.stringify(fromNotes.content)).toContain("from-notes");

    const fromCrm = await client.callTool({
      name: "crm__get_customer",
      arguments: { id: "c_001" },
    });
    expect(JSON.stringify(fromCrm.content)).toContain("Ada Lovelace");
    expect(store.__snapshot().customers["c_001"]?.name).toBe("Ada Lovelace");
  });

  it("journals the owning server and the unprefixed tool name", async () => {
    const journal = tempJournal();
    const { client } = await connectMulti(journal);
    await client.callTool({ name: "notes__append_note", arguments: { text: "hi" } });
    const runId = journal.listRuns()[0]?.id ?? "";
    const action = journal.getActions(runId)[0];
    expect(action?.server).toBe("notes");
    expect(action?.tool).toBe("append_note");
    expect(action?.class).toBe("irreversible");
  });

  it("aggregates resources and routes a read to the owning server", async () => {
    const { client } = await connectMulti(tempJournal());
    const uris = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(uris).toEqual(["crm://customers", "notes://all"]);
    const notes = await client.readResource({ uri: "notes://all" });
    expect(JSON.stringify(notes.contents)).toContain("note one");
    const customers = await client.readResource({ uri: "crm://customers" });
    expect(JSON.stringify(customers.contents)).toContain("Ada Lovelace");
  });

  it("advertises the union of upstream capabilities", async () => {
    const { client } = await connectMulti(tempJournal());
    const capabilities = client.getServerCapabilities();
    // Only the notes server has prompts; the union must still expose them.
    expect(capabilities?.prompts).toBeDefined();
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["notes__summarise"]);
  });

  it("reports a resource uri claimed by two servers instead of picking one", async () => {
    const journal = tempJournal();
    const storeA = new ToyCrmStore();
    const storeB = new ToyCrmStore();
    const upstreams = [
      await inMemoryUpstream(createToyCrmServer(storeA), "crm"),
      await inMemoryUpstream(createToyCrmServer(storeB), "crm2"),
    ];
    cleanups.push(async () => {
      for (const upstream of upstreams) {
        await upstream.close();
      }
    });
    const manifest = parseManifest(
      `version: 1
servers:
  crm: { command: node, args: [] }
  crm2: { command: node, args: [] }
tools: []
`,
      "manifest.yaml",
    );

    // A resource uri is an opaque identifier the client hands back verbatim, so
    // unlike a tool name it cannot be disambiguated by renaming it.
    const proxy = createProxyServer({ upstreams, manifest, journal, gate: autoApproveGate });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "clash", version: "0.0.0" });
    await Promise.all([proxy.server.connect(st), client.connect(ct)]);
    await proxy.ready;
    cleanups.push(async () => {
      await client.close();
    });

    await expect(client.listResources()).rejects.toThrow(/crm.*crm2|crm2.*crm/s);
  });

  it("rejects an upstream the manifest never declared", async () => {
    const journal = tempJournal();
    const upstream = await inMemoryUpstream(createToyCrmServer(new ToyCrmStore()), "ghost");
    cleanups.push(async () => {
      await upstream.close();
    });
    expect(() =>
      createProxyServer({
        gate: autoApproveGate,
        upstreams: [upstream],
        manifest: parseManifest(MANIFEST, "manifest.yaml"),
        journal,
      }),
    ).toThrow(ManifestError);
  });
});
