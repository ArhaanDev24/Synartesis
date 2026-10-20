import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = resolve("dist/cli.js");
const FIXTURE = resolve("dist/toy-crm.js");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a policy with one server that will not start", () => {
  it("still serves the others, rather than taking them all away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "synartesis-partial-"));
    dirs.push(dir);
    const manifest = join(dir, "synartesis.yaml");
    writeFileSync(
      manifest,
      [
        "version: 1",
        "servers:",
        "  crm:",
        "    command: node",
        `    args: ["${FIXTURE}", "--state", "${join(dir, "crm.json")}"]`,
        "  gone:",
        "    command: synartesis-test-no-such-command",
        "tools:",
        '  - match: "crm.get_customer"',
        "    class: readonly",
        '  - match: "gone.anything"',
        "    class: readonly",
        "",
      ].join("\n"),
    );
    const client = new Client({ name: "agent", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [CLI, "proxy", "--manifest", manifest, "--journal", join(dir, "journal.db")],
        stderr: "ignore",
      }),
    );
    try {
      const { tools } = await client.listTools();
      // Named as they would be with both running: one failing renames nothing.
      expect(tools.map((tool) => tool.name)).toContain("crm__get_customer");
      const read = await client.callTool({ name: "crm__get_customer", arguments: { id: "c_001" } });
      expect(read.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
