import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { connectStdioUpstream, type Upstream } from "../src/proxy/upstream.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});

/** Notes each start in a file, and announces itself when asked to. */
const SERVER = `
require("fs").appendFileSync(process.env.STARTS, "start\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      send({ jsonrpc: "2.0", id: message.id, result: { content: [] } });
    }
  }
});
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
`;

async function upstream(): Promise<{ upstream: Upstream; starts: () => number }> {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-shared-"));
  const script = join(dir, "server.js");
  const starts = join(dir, "starts");
  writeFileSync(script, SERVER);
  writeFileSync(starts, "");
  const connected = await connectStdioUpstream({
    name: "s",
    command: "node",
    args: [script],
    env: { STARTS: starts },
    stderr: "ignore",
  });
  cleanups.push(async () => {
    await connected.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { upstream: connected, starts: () => readFileSync(starts, "utf8").split("\n").filter(Boolean).length };
}

describe("an upstream replaced after its connection failed", () => {
  it("starts one replacement however many callers saw it fail", async () => {
    const { upstream: one, starts } = await upstream();
    const failed = one.client;
    await Promise.all([one.reconnect?.(failed), one.reconnect?.(failed), one.reconnect?.(failed)]);
    // And a caller that only finds out afterwards does not replace the new one.
    const replacement = one.client;
    await one.reconnect?.(failed);
    expect(one.client).toBe(replacement);
    expect(replacement).not.toBe(failed);
    expect(starts()).toBe(2);
  });

  it("goes on passing on what the server announces", async () => {
    const { upstream: one } = await upstream();
    const heard: string[] = [];
    one.onNotification?.((notification: Notification) => {
      heard.push(notification.method);
      return Promise.resolve();
    });
    await one.reconnect?.(one.client);
    await one.client.request({ method: "tools/call", params: { name: "x", arguments: {} } }, z.looseObject({}));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toContain("notifications/tools/list_changed");
  });
});
