#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describe } from "../errors.js";
import { openJournal } from "../journal/journal.js";
import { loadManifest } from "../manifest/load.js";
import { createProxyServer } from "./proxy.js";
import { connectStdioUpstream, type Upstream } from "./upstream.js";

/**
 * The manifest is the configuration (D3): it already declares every server and
 * how to start it, so there is nothing left for flags to say.
 *
 *   synartesis-proxy [--manifest synartesis.yaml] [--journal .synartesis/journal.db]
 */
interface Argv {
  readonly manifest: string;
  readonly journal: string;
}

function parseArgv(argv: readonly string[]): Argv {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const unknown = argv.find(
    (token, index) =>
      token.startsWith("--") && !["--manifest", "--journal"].includes(token) && index >= 0,
  );
  if (unknown !== undefined) {
    throw new Error(`unknown flag ${unknown}; expected --manifest or --journal`);
  }
  return {
    manifest: read("--manifest") ?? "synartesis.yaml",
    journal: read("--journal") ?? ".synartesis/journal.db",
  };
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  // Loaded before anything is spawned: never start with a broken policy.
  const manifest = loadManifest(argv.manifest);
  const journal = openJournal(argv.journal);

  const upstreams: Upstream[] = [];
  for (const [name, spec] of Object.entries(manifest.servers)) {
    upstreams.push(
      await connectStdioUpstream({
        name,
        command: spec.command,
        args: spec.args,
        ...(spec.env === undefined ? {} : { env: spec.env }),
      }),
    );
  }

  const proxy = createProxyServer({ upstreams, manifest, journal });

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void (async (): Promise<void> => {
      // Let in-flight calls settle before tearing the connection down. An
      // aborted write leaves the journal unable to say whether it applied.
      await Promise.race([
        proxy.whenIdle(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
      await proxy.server.close();
      for (const upstream of upstreams) {
        await upstream.close();
      }
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
  // survives its own client, holding every upstream child open until whoever
  // spawned us escalates to a signal.
  process.stdin.on("end", () => {
    shutdown(0);
  });
  process.stdin.on("close", () => {
    shutdown(0);
  });

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
