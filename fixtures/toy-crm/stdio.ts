#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createToyCrmServer } from "./server.js";
import { PLANS, ToyCrmStore, type ToyCrmOptions } from "./store.js";

/**
 * Runs the fixture as a real stdio MCP server so the proxy can spawn it the
 * same way it will spawn a production server.
 *
 *   toy-crm [--state <path>]
 *
 * Without --state the store lives only for the life of the process. With it,
 * state survives across processes, which is what makes a cross-process undo
 * demonstrable at all: the rollback runs long after the agent's proxy exited.
 */
const stateSchema = z.object({
  customers: z.record(
    z.string(),
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      plan: z.enum(PLANS),
      notes: z.string(),
    }),
  ),
  outbox: z.array(
    z.object({ to: z.string(), subject: z.string(), body: z.string(), sentAt: z.string() }),
  ),
});

const at = process.argv.indexOf("--state");
const statePath = at === -1 ? undefined : process.argv[at + 1];

const options: ToyCrmOptions = {};
const store = new ToyCrmStore(
  statePath === undefined
    ? options
    : {
        afterWrite: (): void => {
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, JSON.stringify(store.__snapshot(), null, 2));
        },
      },
);

if (statePath !== undefined && existsSync(statePath)) {
  store.__restore(stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))));
}

const server = createToyCrmServer(store);

// Exit when the pipe closes; the SDK's stdio transport does not do this for
// us, and a fixture that outlives its client makes tests hang.
process.stdin.on("end", () => {
  process.exit(0);
});

await server.connect(new StdioServerTransport());
