import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createJournalGate, type GateRequest } from "../../src/gate/gate.js";
import { openJournal, type Journal } from "../../src/journal/journal.js";
import { loadManifest } from "../../src/manifest/load.js";
import type { Manifest } from "../../src/manifest/types.js";
import { createProxyServer } from "../../src/proxy/proxy.js";
import { createRouter, SEPARATOR, type Router } from "../../src/proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "../../src/proxy/upstream.js";
import type { ProviderTool } from "../providers/types.js";
import { connectToolset, createToolset, TOOLSET_POLICY } from "./toolset.js";

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
  /**
   * Offer Synartesis's own operations to the model. On by default: being able
   * to ask what changed, in words, is most of why this app exists.
   */
  readonly ownTools?: boolean;
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
  /**
   * What one of Synartesis's own tools is called from the model's side.
   *
   * The proxy qualifies tool names whenever it fronts more than one server,
   * so `what_changed` reaches the model as `synartesis__what_changed`. Since
   * the toolset is always offered, this app is always past that threshold --
   * which makes the qualified form the stable one rather than something that
   * changes when a server is added. Callers ask rather than assume.
   */
  ownTool(bare: string): string;
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
  /**
   * Filled in once everything is up. A holder rather than two `let`s because
   * the toolset closes over these before they exist -- it needs the router to
   * read the world, and the router needs every upstream, including the toolset.
   */
  const live: { router?: Router; runId?: string } = {};
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

  // Synartesis's own operations, as an upstream like any other. Going through
  // the proxy rather than around it is deliberate: the policy below is what
  // makes list and preview readonly and undo_session gated, using exactly the
  // machinery every other server is held to.
  const offerOwnTools = options.ownTools ?? true;
  if (offerOwnTools) {
    const toolset = createToolset({
      journal,
      router: () => {
        if (live.router === undefined) {
          throw new Error("the router is not ready yet");
        }
        return live.router;
      },
      manifestPath: options.manifestPath,
      currentRun: () => live.runId,
    });
    upstreams.push(await connectToolset(toolset, "synartesis"));
  }

  // The manifest the proxy is given, not the one on disk: the user should not
  // have to write a policy for tools the app itself supplies.
  const covering: Manifest = offerOwnTools
    ? {
        ...manifest,
        servers: {
          ...manifest.servers,
          // Never started as a process -- it is already connected -- but the
          // router insists every upstream is declared, and that check has
          // caught real mistakes.
          synartesis: { command: "node", args: [] },
        },
        tools: [...TOOLSET_POLICY, ...manifest.tools],
      }
    : manifest;

  const proxy = createProxyServer({
    upstreams,
    manifest: covering,
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
  live.runId = runId;
  live.router = createRouter(upstreams, covering);

  return {
    client,
    journal,
    router: live.router,
    manifest: covering,
    runId,
    async tools() {
      const listed = await client.listTools();
      return listed.tools.map(asProviderTool);
    },
    ownTool(bare) {
      return offerOwnTools && upstreams.length > 1 ? `synartesis${SEPARATOR}${bare}` : bare;
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
      /*
       * A session in which nothing happened is not history, it is litter.
       *
       * Opening the window starts a run whether or not anybody says anything,
       * and every launch was leaving a row behind -- twelve of them in one
       * afternoon of testing, which is twelve lines of `synartesis list`
       * standing between somebody and the run they are looking for. This is
       * our own run and it recorded nothing, so it is safe to take back.
       *
       * Before the upstreams rather than after, and that ordering is the
       * whole of it: closing a server means waiting for a child process to
       * go, an application being quit has no patience for that, and the first
       * version of this tidy-up never ran because the process was gone by the
       * time it came round. Nothing can be recorded once the client is shut,
       * so the count is already final here.
       */
      try {
        if (journal.getActions(runId).length === 0) {
          journal.deleteRuns([runId]);
        }
      } catch {
        // A journal that cannot be tidied is not a reason to fail a shutdown.
      }
      for (const upstream of upstreams) {
        await upstream.close();
      }
      journal.close();
    },
  };
}
