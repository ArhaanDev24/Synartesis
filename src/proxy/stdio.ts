#!/usr/bin/env node
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describe } from "../errors.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import { cliCommandFrom } from "../invocation.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../logging.js";
import { openJournal } from "../journal/journal.js";
import { loadManifest } from "../manifest/load.js";
import { verifyAgainstServers } from "../manifest/verify.js";
import { createProxyServer } from "./proxy.js";
import { connectStdioUpstream, type Upstream } from "./upstream.js";

/**
 * The manifest is the configuration (D3): it already declares every server and
 * how to start it, so there is nothing left for flags to say.
 *
 *   synartesis-proxy [--manifest synartesis.yaml] [--journal .synartesis/journal.db]
 *                    [--gate-timeout <seconds>] [--log-level <level>]
 */
interface Argv {
  readonly manifest: string;
  readonly journal: string;
  readonly gateTimeoutMs: number;
  readonly logLevel: LogLevel;
}

function parseArgv(argv: readonly string[]): Argv {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const known = ["--manifest", "--journal", "--gate-timeout", "--log-level"];
  const unknown = argv.find((token) => token.startsWith("--") && !known.includes(token));
  if (unknown !== undefined) {
    throw new Error(`unknown flag ${unknown}; expected one of ${known.join(", ")}`);
  }

  const rawTimeout = read("--gate-timeout");
  const seconds = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new Error("--gate-timeout needs a positive number of seconds");
  }

  const level = read("--log-level") ?? "info";
  if (!isLogLevel(level)) {
    throw new Error(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);
  }

  return {
    manifest: read("--manifest") ?? "synartesis.yaml",
    journal: read("--journal") ?? ".synartesis/journal.db",
    gateTimeoutMs: seconds === undefined ? DEFAULT_GATE_TIMEOUT_MS : seconds * 1000,
    logLevel: level,
  };
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const log = createLogger(argv.logLevel);
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

  // Never serve a request under a policy that calls tools the servers do not
  // have: at run time that is indistinguishable from a missing resource.
  await verifyAgainstServers(upstreams, manifest);

  log.info(
    {
      manifest: argv.manifest,
      journal: argv.journal,
      servers: upstreams.map((upstream) => upstream.name),
      policies: manifest.tools.length,
    },
    "proxy ready",
  );

  const proxy = createProxyServer({
    upstreams,
    manifest,
    journal,
    gateTimeoutMs: argv.gateTimeoutMs,
    logger: log,
    // Absolute, because whoever approves may be in any directory at all.
    approveHint: (actionId: string): string =>
      `${cliCommandFrom(import.meta.url)} approve ${actionId.slice(0, 8)} --journal ${resolve(argv.journal)}`,
  });

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
  // The pipe closing means no more requests are coming, not that the ones
  // already delivered can be dropped. The transport hands only a few buffered
  // frames to handlers per turn of the event loop, so wait until the proxy has
  // been quiet for several consecutive turns rather than yielding a fixed
  // number of times, which is guesswork. The cap stops a wedged upstream from
  // holding the process open.
  const pipeClosed = (): void => {
    const giveUpAt = Date.now() + 5000;
    let quiet = 0;
    const settle = (): void => {
      quiet = proxy.busy() ? 0 : quiet + 1;
      if (quiet >= 10 || Date.now() > giveUpAt) {
        shutdown(0);
        return;
      }
      setImmediate(settle);
    };
    setImmediate(settle);
  };
  process.stdin.on("end", pipeClosed);
  process.stdin.on("close", pipeClosed);

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
