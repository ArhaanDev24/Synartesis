import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";

import { openJournal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { CALL_TIMEOUT_MS } from "../src/proxy/upstream.js";
import { autoApproveGate, createHarness, inMemoryUpstream } from "./helpers/harness.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

/** A tool that reports how far it has got, as a long build or upload does. */
function worker(): McpServer {
  const server = new McpServer({ name: "worker", version: "1" });
  server.registerTool("build", { annotations: { readOnlyHint: true } }, async (extra) => {
    const token = extra._meta?.progressToken;
    if (token !== undefined) {
      for (const progress of [1, 2]) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total: 2, message: `step ${String(progress)}` },
        });
      }
    }
    return { content: [{ type: "text", text: "built" }] };
  });
  return server;
}

async function agentThroughProxy(): Promise<{ agent: Client; requested: Record<string, unknown>[] }> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-progress-"));
  const journal = openJournal(join(dir, "journal.db"));
  cleanups.push(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const upstream = await inMemoryUpstream(worker(), "work");
  const requested: Record<string, unknown>[] = [];
  const client = upstream.client;
  const real = client.request.bind(client);
  client.request = ((request, schema, options) => {
    if (request.method === "tools/call") {
      requested.push({ ...(options ?? {}) });
    }
    return real(request, schema, options);
  });
   
  const manifest = parseManifest(
    'version: 1\nservers:\n  work:\n    command: "true"\ntools:\n  - match: "work.build"\n    class: readonly\n',
    "m.yaml",
  );
  const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "agent", version: "0" });
  await Promise.all([proxy.server.connect(st), agent.connect(ct)]);
  await proxy.ready;
  cleanups.push(async () => {
    await agent.close();
    await upstream.close();
  });
  return { agent, requested };
}

describe("a long tool call", () => {
  it("passes the tool's progress back to the agent", async () => {
    const { agent } = await agentThroughProxy();
    const seen: Progress[] = [];
    const result = await agent.callTool({ name: "build", arguments: {} }, undefined, {
      onprogress: (progress) => {
        seen.push(progress);
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "built" }]);
    expect(seen.map((one) => one.progress)).toEqual([1, 2]);
    expect(seen[1]?.message).toBe("step 2");
  });

  it("is not cut off by the proxy after a minute while it is still working", async () => {
    const { agent, requested } = await agentThroughProxy();
    await agent.callTool({ name: "build", arguments: {} });
    expect(requested[0]).toMatchObject({ timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});

describe("a write the agent cancels", () => {
  it("is settled by reading the resource, not left as an outcome nobody knows", async () => {
    // The read-back used the agent's signal, already aborted by the cancel,
    // so it failed before it was sent: every cancelled write became unknown,
    // and an unknown blocks undoing the whole session.
    const harness = await createHarness();
    cleanups.push(() => harness.dispose());
    const client = harness.upstream.client;
    const real = client.request.bind(client);
    client.request = ((request, schema, options) => {
      if (request.method === "tools/call" && request.params?.["name"] === "update_customer") {
        // Never reaches the tool; gives up only when the caller does.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("This operation was aborted"));
          });
        });
      }
      return real(request, schema, options);
    });
     

    const cancel = new AbortController();
    const call = harness.proxied
      .callTool({ name: "update_customer", arguments: { id: "c_001", plan: "free" } }, undefined, {
        signal: cancel.signal,
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    cancel.abort();
    await call;

    const runId = harness.journal.listRuns()[0]?.id ?? "";
    let status: string | undefined;
    for (let i = 0; i < 50 && (status === undefined || status === "pending"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = harness.journal.getActions(runId).find((row) => row.tool === "update_customer")?.status;
    }
    expect(status).toBe("failed");
  });
});
