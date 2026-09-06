import { describe, expect, it } from "vitest";

import { readServers, writeServers } from "../src/install/toml.js";

/**
 * These files belong to the user, and this module edits them in place. Almost
 * every case here is about a byte that must not change.
 */

const CONFIG = [
  "model = \"something\"",
  "",
  "# A comment worth keeping.",
  "[mcp_servers.awkward]",
  'command = "thing"',
  'args = ["--flag", "a,b", "say \\"hi\\"", "back\\\\slash"]',
  "startup_timeout_sec = 120",
  "",
  "[mcp_servers.awkward.env]",
  "TOKEN = \"abc,def\"",
  "",
  "[mcp_servers.plain]",
  'command = "other"',
  'args = ["x"]',
  "",
].join("\n");

describe("reading a server list out of TOML", () => {
  it("keeps an argument that contains a comma in one piece", () => {
    // This is the bug that shipped: split(",") tore "a,b" in half and left the
    // quotes inside the values, so a server nobody had touched came back with
    // arguments it never had.
    expect(readServers(CONFIG)["awkward"]?.args).toEqual([
      "--flag",
      "a,b",
      'say "hi"',
      "back\\slash",
    ]);
  });

  it("does not mistake the env subtable for a server", () => {
    expect(Object.keys(readServers(CONFIG)).sort()).toEqual(["awkward", "plain"]);
  });

  it("reads an array of tables as nothing of ours", () => {
    const text = ['[[mcp_servers.wrong]]', 'command = "x"'].join("\n");
    expect(readServers(text)).toEqual({});
  });
});

describe("writing a server list back", () => {
  it("leaves every table it was not asked to change exactly as it found it", () => {
    const parsed = readServers(CONFIG);
    const after = writeServers(CONFIG, {
      ...parsed,
      plain: { command: "synartesis", args: ["proxy", "--server", "plain"] },
    });

    const before = CONFIG.split("\n");
    const changed = after
      .split("\n")
      .map((line, index) => (line === before[index] ? undefined : index))
      .filter((index): index is number => index !== undefined);
    // Only the two lines belonging to `plain`.
    expect(changed).toHaveLength(2);
    expect(after).toContain('args = ["--flag", "a,b", "say \\"hi\\"", "back\\\\slash"]');
  });

  it("keeps comments, subtables and unrelated keys", () => {
    const after = writeServers(CONFIG, {
      plain: { command: "synartesis", args: ["proxy"] },
    });
    expect(after).toContain("# A comment worth keeping.");
    expect(after).toContain("startup_timeout_sec = 120");
    expect(after).toContain('TOKEN = "abc,def"');
    expect(after).toContain('model = "something"');
  });

  it("survives a round trip through itself", () => {
    const parsed = readServers(CONFIG);
    const wrapped = writeServers(CONFIG, {
      ...parsed,
      awkward: { command: "synartesis", args: ["proxy", "--server", "awkward"] },
    });
    // Putting the original entry back must give the original file.
    expect(writeServers(wrapped, { ...readServers(wrapped), awkward: parsed["awkward"] ?? {} })).toBe(
      CONFIG,
    );
  });

  it("adds an args line where a table had none", () => {
    const text = ["[mcp_servers.bare]", 'command = "thing"', ""].join("\n");
    const after = writeServers(text, { bare: { command: "synartesis", args: ["proxy"] } });
    expect(after).toContain('args = ["proxy"]');
    expect(readServers(after)["bare"]?.args).toEqual(["proxy"]);
  });
});
