import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { parse, stringify } from "yaml";

import { parseManifest } from "../src/manifest/load.js";

/**
 * Every policy the documentation shows, loaded.
 *
 * The user guide's only complete policy example did not parse -- `tools:` as a
 * map, names without their server, `${args.id}` -- and nothing noticed,
 * because nothing read it. Somebody copying the one example they were given
 * got an error for their trouble.
 *
 * Most blocks are fragments: one rule, or one section. Each is completed into a
 * policy the smallest way that can load -- a stand-in for every server it
 * names -- and then held to everything a real policy is held to.
 */
// The runbook shows commands, not policies, so it is not here.
const DOCS = ["README.md", "docs/synartesis-user-guide.md", "site/install.html"];

interface Block {
  readonly where: string;
  readonly text: string;
}

function unescape(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function blocksIn(file: string): Block[] {
  const text = readFileSync(file, "utf8");
  const found = file.endsWith(".html")
    ? [...text.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
        .map((match) => ({ at: match.index, body: unescape(match[1] ?? "") }))
        // Only the ones that are policy: a rule list or a policy section.
        .filter((one) => /^\s*(- match:|version:|servers:|tools:|pins:)/.test(one.body))
    : [...text.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((match) => ({
        at: match.index,
        body: match[1] ?? "",
      }));
  return found.map((one) => ({
    where: `${file}:${String(text.slice(0, one.at).split("\n").length)}`,
    text: one.body,
  }));
}

/** Every server a fragment mentions, so each can be given a stand-in. */
function serversNamed(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === "string") {
    const qualified = /^([A-Za-z0-9_-]+)\.[A-Za-z0-9_*]/.exec(value);
    if (qualified?.[1] !== undefined && !value.startsWith("$")) {
      into.add(qualified[1]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => serversNamed(item, into));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "match" || key === "tool") {
        serversNamed(item, into);
      } else if (typeof item === "object") {
        serversNamed(item, into);
      }
    }
  }
  return into;
}

/** A mapping, read as one, or an empty one. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function completed(text: string): string {
  const raw: unknown = parse(text);
  if (Array.isArray(raw)) {
    const servers = Object.fromEntries([...serversNamed(raw, new Set())].map((name) => [name, { command: "true" }]));
    return stringify({ version: 1, servers, tools: raw });
  }
  const section = record(raw);
  if ("version" in section) {
    return text;
  }
  const named = serversNamed(section["tools"] ?? [], new Set());
  for (const pinned of Object.keys(record(section["pins"]))) {
    named.add(pinned);
  }
  const stand = Object.fromEntries([...named].map((name) => [name, { command: "true" }]));
  return stringify({ version: 1, ...section, servers: { ...stand, ...record(section["servers"]) } });
}

describe.each(DOCS)("the policies shown in %s", (file) => {
  const blocks = blocksIn(file);

  it.each(blocks.map((block) => [block.where, block.text] as const))("%s loads", (_where, text) => {
    // Values that stand for a real secret or path are left alone: loading
    // never reads the environment.
    expect(() => parseManifest(completed(text), "doc.yaml")).not.toThrow();
  });
});

describe("finding them", () => {
  it("finds the blocks it is meant to be checking", () => {
    // A change to how the docs mark their code would otherwise make every
    // test above vanish and pass.
    expect(DOCS.map(blocksIn).flat().length).toBeGreaterThanOrEqual(10);
  });
});
