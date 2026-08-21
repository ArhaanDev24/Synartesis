import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createToyCrmServer } from "../../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../../src/journal/journal.js";
import { createProxyServer } from "../../src/proxy/proxy.js";
import type { Upstream } from "../../src/proxy/upstream.js";

export interface Harness {
  /** A client wired straight to the fixture, for identity comparisons. */
  readonly direct: Client;
  /** A client wired to the fixture through the proxy. */
  readonly proxied: Client;
  readonly store: ToyCrmStore;
  readonly journal: Journal;
  readonly upstream: Upstream;
  dispose(): Promise<void>;
}

async function link(server: McpServer, name: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function inMemoryUpstream(server: McpServer, name: string): Promise<Upstream> {
  const client = await link(server, "synartesis-proxy");
  return {
    name,
    client,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}

export async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-test-"));
  const journal = openJournal(join(dir, "journal.db"));

  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const proxy = createProxyServer({ upstream, journal });
  const proxied = await link(proxy.server, "test-client");
  // The run opens when the session initializes; awaiting it keeps every
  // journal assertion deterministic instead of racing the handshake.
  await proxy.ready;

  const directStore = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const direct = await link(createToyCrmServer(directStore), "test-client");

  return {
    direct,
    proxied,
    store,
    journal,
    upstream,
    dispose: async (): Promise<void> => {
      await proxied.close();
      await direct.close();
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
