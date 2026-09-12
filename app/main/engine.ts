import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createJournalGate, type GateRequest } from "../../src/gate/gate.js";
import { openJournal, type Journal } from "../../src/journal/journal.js";
import { loadManifest } from "../../src/manifest/load.js";
import type { Manifest } from "../../src/manifest/types.js";
import { createProxyServer } from "../../src/proxy/proxy.js";
import { createRouter, type Router } from "../../src/proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "../../src/proxy/upstream.js";
import type { ProviderTool } from "../providers/types.js";

/**
 * The whole reason this app is not another chat client.
 *
 * The model's MCP client is connected to the Synartesis proxy rather than to
 * the servers themselves, over an in-memory transport -- no pipe, no port, no
 * child process. So every tool the model calls already arrives with the state
 * it replaced captured beside it, and undo is not a feature this app has to
 * build. It is a function it can call.
 *
 * `tests/helpers/harness.ts` wires the same three pieces for the test suite;
 * this is that wiring with the app's lifetime around it.
 */

export interface EngineOptions {
  readonly manifestPath: string;
  readonly journalPath: string;
  /** The agent's name in the journal, so a session is identifiable later. */
  readonly label?: string;
  /**
   * A call needs a person. The journal gate waits rather than refusing, so
   * this raises a card and the tool stays parked until somebody answers --
   * which is what a window can do and a terminal cannot.
   */
  readonly onApprovalNeeded?: (request: GateRequest) => void;
  /** How long a held call waits before giving up. */
  readonly gateTimeoutMs?: number;
}

export interface Engine {
  readonly client: Client;
  readonly journal: Journal;
  readonly router: Router;
  readonly manifest: Manifest;
  /** The session every call in this conversation is recorded under. */
  readonly runId: string;
  /** Every tool the model may call, already in provider-neutral shape. */
  tools(): Promise<readonly ProviderTool[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; failed: boolean }>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP describes a tool exactly as a provider needs to hear about it. */
function asProviderTool(tool: {
  name: string;
  // Widened to match the SDK's own optionality under exactOptionalPropertyTypes.
  description?: string | undefined;
  inputSchema?: unknown;
}): ProviderTool {
  const schema: Record<string, unknown> = isRecord(tool.inputSchema)
    ? tool.inputSchema
    : { type: "object", properties: {} };
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: schema,
  };
}

/**
 * A tool result as one string, plus whether it went wrong.
 *
 * Every provider wants the result as text and the failure as a flag, and the
 * flag is the half that matters: a model told an error is ordinary prose
 * learns to carry on as though nothing happened.
 */
function flatten(result: unknown): { text: string; failed: boolean } {
  const record: Record<string, unknown> = isRecord(result) ? result : {};
  const failed = record["isError"] === true;
  const content = record["content"];
  if (!Array.isArray(content)) {
    return { text: JSON.stringify(result), failed };
  }
  const said = content
    .map((block: unknown) => {
      if (!isRecord(block)) {
        return "";
      }
      const text = block["text"];
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
  return { text: said === "" ? JSON.stringify(content) : said, failed };
}

export async function startEngine(options: EngineOptions): Promise<Engine> {
  const manifest = loadManifest(options.manifestPath);
  const journal = openJournal(options.journalPath);

  const upstreams: Upstream[] = [];
  for (const [name, spec] of Object.entries(manifest.servers)) {
    try {
      upstreams.push(
        await connectStdioUpstream({
          name,
          command: spec.command,
          args: spec.args,
          stderr: "capture",
          ...(spec.env === undefined ? {} : { env: spec.env }),
        }),
      );
    } catch {
      // One server that will not start is a fact about that server, not a
      // reason the app cannot open. The tools it would have offered are
      // simply absent, which the model is told by their absence.
    }
  }

  const proxy = createProxyServer({
    upstreams,
    manifest,
    journal,
    gate: createJournalGate(journal, {
      ...(options.gateTimeoutMs === undefined ? {} : { timeoutMs: options.gateTimeoutMs }),
      ...(options.onApprovalNeeded === undefined ? {} : { notify: options.onApprovalNeeded }),
    }),
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: options.label ?? "synartesis-desktop", version: "0.1.0" });
  await Promise.all([proxy.server.connect(serverSide), client.connect(clientSide)]);
  const runId = await proxy.ready;

  return {
    client,
    journal,
    router: createRouter(upstreams, manifest),
    manifest,
    runId,
    async tools() {
      const listed = await client.listTools();
      return listed.tools.map(asProviderTool);
    },
    async call(name, args) {
      try {
        return flatten(await client.callTool({ name, arguments: args }));
      } catch (error: unknown) {
        // A refusal from the proxy -- a held call, a blocked write -- arrives
        // as a thrown protocol error. The model has to be told, in the words
        // the proxy chose, or it will try the same thing again.
        return { text: error instanceof Error ? error.message : String(error), failed: true };
      }
    },
    async close() {
      await client.close();
      await proxy.server.close();
      for (const upstream of upstreams) {
        await upstream.close();
      }
      journal.close();
    },
  };
}
