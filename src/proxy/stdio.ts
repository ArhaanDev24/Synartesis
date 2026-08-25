#!/usr/bin/env node
/**
 * better-sqlite3 requires Node 22, and on Node 20 it does not fail politely:
 * it segfaults the moment a database is opened. Saying so is better than
 * letting somebody meet exit code 139.
 */
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  process.stderr.write(
    `synartesis: needs Node 22 or newer, and this is ${process.version}.\n`,
  );
  process.exit(2);
}

import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { serveHttp } from "./http.js";

import { describe } from "../errors.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import { cliCommandFrom } from "../invocation.js";
import { findJournal, findManifest } from "../locate.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../logging.js";
import { mark } from "../style.js";
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
  /** Whether --gate-timeout was actually typed, as against defaulted. */
  readonly gateTimeoutGiven: boolean;
  /** Serve over http instead of stdio, for a client that will not start one. */
  readonly http?: {
    readonly port: number;
    readonly host: string;
    readonly token: string;
    readonly idleSeconds: number;
  };
  readonly logLevel: LogLevel;
}

function parseArgv(argv: readonly string[]): Argv {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const known = ["--manifest", "--journal", "--gate-timeout", "--log-level", "--http", "--http-host", "--http-idle", "--token"];
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

  const httpPort = read("--http");
  let http: Argv["http"];
  if (httpPort !== undefined) {
    const port = Number(httpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("--http needs a port number");
    }
    // Refused rather than defaulted. What is served here can write through
    // every server in the policy, and a default of "no auth" is the kind of
    // convenience that ends up on someone's public tunnel.
    const token = read("--token") ?? process.env["SYNARTESIS_TOKEN"];
    if (token === undefined || token.length < 16) {
      throw new Error(
        "--http needs --token, or SYNARTESIS_TOKEN, of at least 16 characters: this serves write access over a socket",
      );
    }
    const rawIdle = read("--http-idle");
    const idleSeconds = rawIdle === undefined ? 1800 : Number(rawIdle);
    if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) {
      throw new Error("--http-idle needs a positive number of seconds");
    }
    http = { port, host: read("--http-host") ?? "127.0.0.1", token, idleSeconds };
  }

  const manifest = findManifest(read("--manifest"));
  return {
    manifest,
    journal: findJournal(read("--journal"), manifest),
    gateTimeoutMs: seconds === undefined ? DEFAULT_GATE_TIMEOUT_MS : seconds * 1000,
    gateTimeoutGiven: seconds !== undefined,
    ...(http === undefined ? {} : { http }),
    logLevel: level,
  };
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const log = createLogger(argv.logLevel);
  if (argv.gateTimeoutGiven) {
    // Accepted, validated, threaded through, and read by nothing: this proxy
    // refuses a held call straight away rather than holding the connection
    // open, so there is no wait for a timeout to cut short. Saying so is
    // better than a flag that quietly does nothing, and better than rejecting
    // one that earlier versions took.
    log.warn(
      "--gate-timeout has no effect: a held call is refused immediately and the agent makes it again once you approve",
    );
  }
  // Only on a real terminal. A client collecting our stderr into a log file
  // wants the structured records and nothing else.
  if (process.stderr.isTTY) {
    process.stderr.write(mark());
  }
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

  const build = (): ReturnType<typeof createProxyServer> =>
    createProxyServer({
      upstreams,
      manifest,
      journal,
      gateTimeoutMs: argv.gateTimeoutMs,
      logger: log,
      // Absolute, because whoever approves may be in any directory at all.
      approveHint: (actionId: string): string =>
        `${cliCommandFrom(import.meta.url)} approve ${actionId.slice(0, 8)} --journal ${resolve(argv.journal)}`,
    });

  if (argv.http !== undefined) {
    // One server, many sessions. Each session is a connection and a connection
    // is a run, so each gets a proxy of its own; the upstreams and the journal
    // are shared, which is what makes them one story.
    const served = await serveHttp({
      ...argv.http,
      create: build,
      log: {
        info: (data, message) => {
          log.info(data, message);
        },
        warn: (message) => {
          log.warn(message);
        },
      },
    });
    const stop = (): void => {
      void (async (): Promise<void> => {
        await served.close();
        for (const upstream of upstreams) {
          await upstream.close();
        }
        journal.close();
        process.exit(0);
      })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  const proxy = build();

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
