#!/usr/bin/env node
/**
 * A real MCP client, for the demos.
 *
 * Piping every frame into a server at once is not what a client does, and the
 * difference is not cosmetic: it makes the server run both handlers at the
 * same time. The memory server does a load-modify-save with no lock, so two
 * overlapping calls lose one of the writes outright. Waiting for each reply
 * before sending the next is both what really happens and the only way to
 * demonstrate anything about a server rather than about a race inside it.
 *
 *   node dist/demo-agent.js <journal> <manifest> '<toolName> <jsonArgs>' ...
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { describe } from "../src/errors.js";

const said = z.looseObject({
  isError: z.boolean().default(false),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
});

function line(name: string, raw: unknown): string {
  const parsed = said.safeParse(raw);
  if (!parsed.success) {
    return `  called   ${name}`;
  }
  const text = parsed.data.content
    .map((block) => block.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ");
  return `  ${parsed.data.isError ? "refused " : "called  "} ${name}  ${text.slice(0, 110)}`;
}

/** process.env types every value as optional; the transport wants only the set ones. */
function inherited(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

const toolArgs = z.record(z.string(), z.unknown());

const [journal, manifest, ...calls] = process.argv.slice(2);
if (journal === undefined || manifest === undefined) {
  throw new Error("usage: demo-agent <journal> <manifest> '<tool> <jsonArgs>' ...");
}

const client = new Client({ name: "agent", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      join(dirname(fileURLToPath(import.meta.url)), "proxy.js"),
      "--manifest",
      manifest,
      "--journal",
      journal,
    ],
    stderr: "ignore",
    env: inherited(),
  }),
);

for (const call of calls) {
  const at = call.indexOf(" ");
  const name = at === -1 ? call : call.slice(0, at);
  const given: unknown = at === -1 ? {} : JSON.parse(call.slice(at + 1));
  const args = toolArgs.parse(given);
  try {
    process.stdout.write(`${line(name, await client.callTool({ name, arguments: args }))}\n`);
  } catch (error: unknown) {
    process.stdout.write(`  blocked  ${name}  ${describe(error).slice(0, 200)}\n`);
  }
}

await client.close();
