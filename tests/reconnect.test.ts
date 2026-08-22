import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectStdioUpstream } from "../src/proxy/upstream.js";
import { createRouter } from "../src/proxy/routing.js";
import { parseManifest } from "../src/manifest/load.js";
import { runRead } from "../src/proxy/snapshot.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A server that answers, and dies on one tool. A real one dies on a response
 * too large for the stdio transport to carry; the effect on this side is the
 * same and this way it is deterministic.
 */
const FLAKY = `
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
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{ name: "peek", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      if (process.env.SYNARTESIS_TEST_DIE === "1" && !require("fs").existsSync(process.env.SYNARTESIS_TEST_FLAG)) {
        // Once, and only once: the flag survives the respawn.
        require("fs").writeFileSync(process.env.SYNARTESIS_TEST_FLAG, "died");
        process.exit(1);
      }
      reply(message.id, { content: [{ type: "text", text: "alive" }] });
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;

describe("an upstream whose connection dies", () => {
  it("comes back, instead of failing everything after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-reconnect-"));
    dirs.push(dir);
    const server = join(dir, "flaky.js");
    writeFileSync(server, FLAKY);
    const flag = join(dir, "died.flag");

    const upstream = await connectStdioUpstream({
      name: "flaky",
      command: "node",
      args: [server],
      env: { SYNARTESIS_TEST_DIE: "1", SYNARTESIS_TEST_FLAG: flag, PATH: process.env["PATH"] ?? "" },
      stderr: "ignore",
    });
    const manifest = parseManifest(
      `version: 1\nservers:\n  flaky:\n    command: "node"\ntools: []\n`,
      "manifest.yaml",
    );
    const router = createRouter([upstream], manifest);
    const read = { server: "flaky", tool: "peek", args: {} };

    // The first read kills the server. Without reconnecting, this and every
    // read after it fail with "Not connected" for the rest of the session.
    const result = await runRead(router, read, new AbortController().signal);
    expect(JSON.stringify(result)).toContain("alive");

    // And it keeps working afterwards.
    const again = await runRead(router, read, new AbortController().signal);
    expect(JSON.stringify(again)).toContain("alive");
    await upstream.close();
  });
});
