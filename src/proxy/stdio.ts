#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describe } from "../errors.js";
import { openJournal } from "../journal/journal.js";
import { createProxyServer } from "./proxy.js";
import { connectStdioUpstream } from "./upstream.js";

/**
 * Phase 1 takes the upstream from argv:
 *
 *   synartesis-proxy --name crm [--journal path] -- node dist/toy-crm.js
 *
 * The manifest replaces this in Phase 2; until the manifest exists, reading a
 * config file would mean inventing its format twice.
 */
interface Argv {
  readonly name: string;
  readonly journal: string;
  readonly command: string;
  readonly args: readonly string[];
}

function parseArgv(argv: readonly string[]): Argv {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("usage: synartesis-proxy --name <server> [--journal <path>] -- <command> [args...]");
  }

  const flags = argv.slice(0, separator);
  const rest = argv.slice(separator + 1);
  const command = rest[0];
  if (command === undefined) {
    throw new Error("no upstream command given after --");
  }

  const read = (flag: string): string | undefined => {
    const at = flags.indexOf(flag);
    return at === -1 ? undefined : flags[at + 1];
  };

  const name = read("--name");
  if (name === undefined) {
    throw new Error("--name is required; it is the key the manifest uses for this server");
  }

  return {
    name,
    journal: read("--journal") ?? ".synartesis/journal.db",
    command,
    args: rest.slice(1),
  };
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const journal = openJournal(argv.journal);
  const upstream = await connectStdioUpstream({
    name: argv.name,
    command: argv.command,
    args: argv.args,
  });
  const proxy = createProxyServer({ upstream, journal });

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async (): Promise<void> => {
      await proxy.server.close();
      await upstream.close();
      journal.close();
      process.exit(code);
    })();
  };

  process.on("SIGINT", () => {
    shutdown(0);
  });
  process.on("SIGTERM", () => {
    shutdown(0);
  });

  // StdioServerTransport only reports a close that we initiate; it never
  // reacts to the parent closing the pipe. Without these listeners the proxy
  // survives its own client, holding the upstream child open until whoever
  // spawned us escalates to a signal.
  process.stdin.on("end", () => {
    shutdown(0);
  });
  process.stdin.on("close", () => {
    shutdown(0);
  });

  // When the client hangs up, the upstream child must die with us. Without
  // this the proxy leaks one orphaned server process per disconnect.
  const inner = proxy.server.server;
  const onclose = inner.onclose;
  inner.onclose = (): void => {
    onclose?.();
    shutdown(0);
  };

  await proxy.server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (error: unknown) {
  // stdout carries protocol frames only; diagnostics must not corrupt it.
  process.stderr.write(`synartesis: ${describe(error)}\n`);
  process.exit(1);
}
