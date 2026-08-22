import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { parseManifest } from "../src/manifest/load.js";
import { createRouter } from "../src/proxy/routing.js";
import type { Upstream } from "../src/proxy/upstream.js";
import type { Manifest } from "../src/manifest/types.js";

/** A real client, never connected: routing only ever reads the name. */
function upstream(name: string): Upstream {
  return {
    name,
    client: new Client({ name: "test", version: "1" }),
    close: () => Promise.resolve(),
  };
}

function manifestFor(...names: readonly string[]): Manifest {
  const servers = names.map((name) => `  ${name}:\n    command: "true"\n`).join("");
  return parseManifest(`version: 1\nservers:\n${servers}tools: []\n`, "manifest.yaml");
}

describe("naming a tool when only one server is guarded", () => {
  const router = createRouter([upstream("fs")], manifestFor("fs"));

  it("still takes the bare name, which is what it advertises", () => {
    const route = router.route("write_file");
    expect(route?.tool).toBe("write_file");
    expect(route?.upstream.name).toBe("fs");
  });

  it("takes the qualified name too, so adding a second server does not rename everything", () => {
    // Guarding one server advertises `write_file`; guarding two advertises
    // `fs__write_file`. A client written against either should keep working,
    // and the qualified form is the one that can always be written down.
    const route = router.route("fs__write_file");
    expect(route?.tool).toBe("write_file");
    expect(route?.upstream.name).toBe("fs");
  });

  it("leaves a name qualified by some other server alone", () => {
    // Not ours to unwrap: crm is not this server, so the name is passed on as
    // it was given rather than silently becoming write_file.
    expect(router.route("crm__write_file")?.tool).toBe("crm__write_file");
  });
});

describe("naming a tool when several servers are guarded", () => {
  const router = createRouter([upstream("fs"), upstream("memory")], manifestFor("fs", "memory"));

  it("routes a qualified name to its server", () => {
    expect(router.route("memory__read_graph")).toMatchObject({ tool: "read_graph" });
    expect(router.route("fs__write_file")).toMatchObject({ tool: "write_file" });
  });

  it("refuses a bare name, which could mean either server", () => {
    expect(router.route("write_file")).toBeUndefined();
  });
});
