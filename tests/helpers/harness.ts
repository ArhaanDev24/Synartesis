import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createToyCrmServer } from "../../fixtures/toy-crm/server.js";
import { ToyCrmStore } from "../../fixtures/toy-crm/store.js";
import { openJournal, type Journal } from "../../src/journal/journal.js";
import { loadManifest, parseManifest } from "../../src/manifest/load.js";
import { createProxyServer } from "../../src/proxy/proxy.js";
import { createJournalGate, type Gate, type GateDecision } from "../../src/gate/gate.js";
import type { Upstream } from "../../src/proxy/upstream.js";

/**
 * Approves instantly. Used by tests whose subject is not the gate, so that
 * every other test does not also become a test of the approval flow.
 */
export const autoApproveGate: Gate = {
  decide: (): Promise<GateDecision> => Promise.resolve({ approved: true, by: "test" }),
};

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

export interface HarnessOptions {
  /** Manifest source to use instead of manifests/toy-crm.yaml. */
  readonly manifest?: string;
  /**
   * "journal" is the suspend-and-wait gate, "retry" the refuse-and-retry one
   * that the proxy now defaults to. Anything else approves instantly, so tests
   * about other behaviour are not all also tests of the gate.
   */
  readonly gate?: "journal" | "retry" | "auto-approve" | Gate;
  readonly gateTimeoutMs?: number;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-test-"));
  const journal = openJournal(join(dir, "journal.db"));

  const store = new ToyCrmStore({ now: () => "2026-01-01T00:00:00.000Z" });
  const upstream = await inMemoryUpstream(createToyCrmServer(store), "crm");
  const proxy = createProxyServer({
    upstreams: [upstream],
    manifest:
      options.manifest === undefined
        ? loadManifest("manifests/toy-crm.yaml")
        : parseManifest(options.manifest, "manifest.yaml"),
    journal,
    ...(options.gate === "retry"
      ? {}
      : {
          gate:
            options.gate === "journal"
              ? createJournalGate(journal, {
                  ...(options.gateTimeoutMs === undefined
                    ? {}
                    : { timeoutMs: options.gateTimeoutMs }),
                })
              : typeof options.gate === "object"
                ? options.gate
                : autoApproveGate,
        }),
    ...(options.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: options.gateTimeoutMs }),
  });
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
