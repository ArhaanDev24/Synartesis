import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ManifestError } from "../src/errors.js";
import { openJournal } from "../src/journal/journal.js";
import { parseManifest } from "../src/manifest/load.js";
import { createProxyServer } from "../src/proxy/proxy.js";
import { createRouter } from "../src/proxy/routing.js";
import { connectUpstream, type Upstream } from "../src/proxy/upstream.js";
import { rollback } from "../src/rollback/rollback.js";
import { autoApproveGate } from "./helpers/harness.js";
import { hostedCrm, type Hosted } from "./helpers/hosted.js";

const TOKEN = "hosted-secret-token";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

/** The toy CRM's own rules, with its server swapped for a hosted one. */
function policyFor(url: string, headers = '{ Authorization: "Bearer ${CRM_TOKEN}" }'): string {
  const tools = readFileSync("manifests/toy-crm.yaml", "utf8");
  return tools.replace(
    /servers:\n  crm:\n    command: node\n    args: \["dist\/toy-crm.js"\]\n/,
    `servers:\n  crm:\n    url: "${url}"\n    transport: http\n    headers: ${headers}\n`,
  );
}

async function hosted(idleSeconds?: number): Promise<Hosted> {
  const server = await hostedCrm(TOKEN, idleSeconds);
  cleanups.push(() => server.close());
  return server;
}

async function reach(text: string, env: Record<string, string>): Promise<Upstream> {
  const manifest = parseManifest(text, "manifest.yaml");
  const spec = manifest.servers["crm"];
  if (spec === undefined) {
    throw new Error("no crm server");
  }
  const upstream = await connectUpstream("crm", spec, { env: { kind: "client", env, own: false } });
  cleanups.push(() => upstream.close());
  return upstream;
}

describe("a hosted server in the policy", () => {
  it("is written as a url and headers, and the headers hold names, not the token", () => {
    const manifest = parseManifest(policyFor("https://example.com/mcp"), "manifest.yaml");
    expect(manifest.servers["crm"]).toMatchObject({
      url: "https://example.com/mcp",
      transport: "http",
      headers: { Authorization: "Bearer ${CRM_TOKEN}" },
    });
  });

  it("refuses a server that says both how to start it and where to reach it", () => {
    expect(() =>
      parseManifest(
        'version: 1\nservers:\n  crm:\n    command: node\n    url: "https://example.com/mcp"\n',
        "m.yaml",
      ),
    ).toThrow(/command or url, not both/);
  });

  it("refuses plain http anywhere but this machine, since the url carries a token", () => {
    const plain = (url: string): string => `version: 1\nservers:\n  crm:\n    url: "${url}"\n`;
    expect(() => parseManifest(plain("http://example.com/mcp"), "m.yaml")).toThrow(ManifestError);
    expect(() => parseManifest(plain("http://127.0.0.1:9000/mcp"), "m.yaml")).not.toThrow();
  });
});

describe("governing a hosted server", () => {
  it("records a write and undoes it, with the token filled in from the environment", async () => {
    const server = await hosted();
    const text = policyFor(server.url);
    const upstream = await reach(text, { CRM_TOKEN: TOKEN });

    const dir = mkdtempSync(join(tmpdir(), "synartesis-remote-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const manifest = parseManifest(text, "manifest.yaml");
    const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "agent", version: "0" });
    await Promise.all([proxy.server.connect(st), agent.connect(ct)]);
    cleanups.push(() => agent.close());
    const runId = await proxy.ready;

    const before = server.store.__snapshot();
    const written = await agent.callTool({ name: "update_customer", arguments: { id: "c_001", notes: "remote" } });
    expect(written.isError).toBeFalsy();
    expect(server.store.__snapshot()).not.toEqual(before);
    expect(journal.getActions(runId)[0]).toMatchObject({ status: "applied", class: "reversible" });

    const report = await rollback({ journal, router: createRouter([upstream], manifest), runId });
    expect(report.status).toBe("rolled_back");
    expect(server.store.__snapshot()).toEqual(before);
  });

  it("says the credentials were refused, rather than that the server is broken", async () => {
    const server = await hosted();
    const refused = await reach(policyFor(server.url), { CRM_TOKEN: "wrong" }).then(
      () => "connected",
      (error: unknown) => String(error),
    );
    expect(refused).toContain("refused the credentials");
    expect(refused).not.toContain("wrong");
  });

  it("names the variable when the token is not set, and says where to set it", async () => {
    const server = await hosted();
    const missing = await reach(policyFor(server.url), {}).then(
      () => "connected",
      (error: unknown) => String(error),
    );
    expect(missing).toContain("${CRM_TOKEN}");
  });

  it("reads a refusal at the door as never sent, and an ended session as one to start again", async () => {
    const server = await hosted();
    const upstream = await reach(policyFor(server.url), { CRM_TOKEN: TOKEN });
    expect(upstream.classify?.(new StreamableHTTPError(401, "no"))).toBe("not-sent");
    expect(upstream.classify?.(new StreamableHTTPError(404, "gone"))).toBe("lost");
    // A network failure or a 5xx says nothing about whether the tool acted.
    expect(upstream.classify?.(new StreamableHTTPError(502, "bad gateway"))).toBeUndefined();
    expect(upstream.classify?.(new TypeError("fetch failed"))).toBeUndefined();
  });

  it("does not leave a write whose session ended as an outcome nobody knows", async () => {
    // An unknown outcome blocks undoing the whole session, so a request the
    // server refused unread must not be recorded as one.
    const server = await hosted(1);
    const text = policyFor(server.url);
    const upstream = await reach(text, { CRM_TOKEN: TOKEN });
    const dir = mkdtempSync(join(tmpdir(), "synartesis-remote-"));
    const journal = openJournal(join(dir, "journal.db"));
    cleanups.push(() => {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const manifest = parseManifest(text, "manifest.yaml");
    const proxy = createProxyServer({ upstreams: [upstream], manifest, journal, gate: autoApproveGate });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "agent", version: "0" });
    await Promise.all([proxy.server.connect(st), agent.connect(ct)]);
    cleanups.push(() => agent.close());
    const runId = await proxy.ready;

    // Swept after a second of quiet; the sweep runs every second.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const failed = await agent
      .callTool({ name: "send_email", arguments: { to: "a@b.c", subject: "s", body: "b" } })
      .then(
        (result) => (result.isError === true ? "error result" : "went through"),
        () => "threw",
      );
    expect(failed).not.toBe("went through");
    const statuses = journal.getActions(runId).map((action) => action.status);
    expect(statuses).not.toContain("pending");

    // And the session was started again, so the next call works.
    const after = await agent.callTool({ name: "get_customer", arguments: { id: "c_001" } });
    expect(after.isError).toBeFalsy();
  });
});
