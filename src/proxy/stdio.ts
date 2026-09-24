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

import { PROXY_FLAGS } from "./flags.js";
import { serveHttp } from "./http.js";

import { describe } from "../errors.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import { cliCommandFrom } from "../invocation.js";
import { findJournal, findManifest } from "../locate.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../logging.js";
import { mark } from "../style.js";
import { openJournal } from "../journal/journal.js";
import { loadManifest } from "../manifest/load.js";
import { toolShapes, verifyAgainstServers, withoutMissingTools } from "../manifest/verify.js";
import { ungoverned, untested, warnUntested } from "../manifest/standing.js";
import { createProxyServer } from "./proxy.js";
import { connectUpstream, type Upstream } from "./upstream.js";
import { declaredNames, fingerprint, upstreamEnv } from "./environment.js";
import { clientEnvFor } from "../install/entry-env.js";

/**
 * The manifest is the configuration (D3): it already declares every server and
 * how to start it, so there is nothing left for flags to say.
 *
 *   synartesis-proxy [--manifest synartesis.yaml] [--journal .synartesis/journal.db]
 *                    [--server <name>] [--gate-timeout <seconds>] [--log-level <level>]
 *
 * `--server` connects one of the manifest's servers rather than all of them.
 * A proxy carrying two servers has to qualify tool names to keep them apart
 * (see routing.ts), which renames every tool the agent already knows. One
 * policy covering everything, and one entry per server in the client's config,
 * keeps the names and the single file both.
 */
interface Argv {
  readonly manifest: string;
  readonly journal: string;
  /** Connect only this server from the manifest; all of them when absent. */
  readonly server?: string;
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
  const known: readonly string[] = PROXY_FLAGS;
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

  const server = read("--server");
  if (argv.includes("--server") && (server === undefined || server.startsWith("--"))) {
    throw new Error("--server needs the name of a server declared in the manifest");
  }

  const manifest = findManifest(read("--manifest"));
  return {
    manifest,
    journal: findJournal(read("--journal"), manifest),
    ...(server === undefined ? {} : { server }),
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

  // Before anything is connected. Whoever reads this log is the person who
  // will be relying on undo, and a policy that has never met its server is the
  // one most likely to disappoint them -- so it is said even on a start that
  // goes on to fail, which is the likeliest outcome for an untried adapter.
  const unproven = untested(manifest);
  if (unproven.length > 0) {
    log.warn({ servers: unproven }, warnUntested(unproven));
  }

  const journal = openJournal(argv.journal);

  const declared = Object.entries(manifest.servers);
  const wanted =
    argv.server === undefined ? declared : declared.filter(([name]) => name === argv.server);
  if (wanted.length === 0) {
    // Named but absent. Starting with every server instead would silently
    // expose more than was asked for, under renamed tools.
    throw new Error(
      `--server ${String(argv.server)} is not declared in ${argv.manifest}; it has: ${declared
        .map(([name]) => name)
        .join(", ")}`,
    );
  }

  // Under --server this process's environment is the one the client meant
  // for that one server -- install copied the entry's `env` onto this entry,
  // and the client started us with it -- so the server inherits it and runs
  // as it did before it was wrapped. Serving several servers from one
  // hand-written entry, whose variable is whose cannot be known, so each gets
  // only what the policy declares for it.
  const source = argv.server === undefined ? ({ kind: "manifest" } as const) : ({ kind: "inherit" } as const);
  const upstreams: Upstream[] = [];
  // What each server was started with, fingerprinted rather than kept, so
  // that an undo run later from a terminal can check it is about to act on
  // the same store the session wrote to. Recorded against each run below.
  const key = journal.fingerprintKey();
  const startedWith = new Map<string, { cwd: string; fingerprints: Record<string, string> }>();
  for (const [name, spec] of wanted) {
    upstreams.push(await connectUpstream(name, spec, { env: source }));
    let client: Readonly<Record<string, string>> | undefined;
    try {
      client = source.kind === "inherit" ? clientEnvFor(argv.manifest, name)?.env : undefined;
    } catch {
      // Two differing entries for one server. Only the undo that later reads
      // this needs to refuse over it; the session itself runs as the client
      // started it.
      client = undefined;
    }
    startedWith.set(name, {
      cwd: process.cwd(),
      fingerprints: fingerprint(key, upstreamEnv(name, spec, source), declaredNames(spec, client)),
    });
  }

  // Never serve a request under a policy that calls tools the servers do not
  // have: at run time that is indistinguishable from a missing resource. With
  // --server the policy still describes the others, so only the connected
  // server's half of it can be checked.
  //
  // Except where the server moved rather than the policy being wrong: a rule
  // whose snapshot or inverse names a tool the server no longer has is held
  // instead, and the proxy starts. See withoutMissingTools for why refusing
  // took whole servers down for people whose policies used to work. What is
  // served from here on is the degraded policy, never the original.
  const { manifest: served, disabled } = await withoutMissingTools(upstreams, manifest);
  for (const line of disabled) {
    log.warn(line);
  }
  await verifyAgainstServers(
    upstreams,
    argv.server === undefined
      ? served
      : {
          ...served,
          tools: served.tools.filter((rule) => rule.match.startsWith(`${String(argv.server)}.`)),
        },
  );

  // Named at startup for the same reason `check` names them: these are the
  // calls that will stop and wait for a person, and the operator reading this
  // line is the one who can write a policy before that happens rather than
  // after. Warn, not info: it is the only thing here that predicts an
  // interruption.
  const uncovered = ungoverned(
    served,
    new Map(await Promise.all(upstreams.map(async (upstream) => [
      upstream.name,
      (await toolShapes(upstream)).map((tool) => tool.name),
    ] as const))),
  );
  for (const entry of uncovered) {
    log.warn(
      { server: entry.server, tools: entry.tools },
      "no policy covers these tools; they will be held for approval when called",
    );
  }

  log.info(
    {
      manifest: argv.manifest,
      journal: argv.journal,
      servers: upstreams.map((upstream) => upstream.name),
      policies: served.tools.length,
      held: disabled.length,
      ungoverned: uncovered.reduce((sum, entry) => sum + entry.tools.length, 0),
    },
    "proxy ready",
  );

  const build = (): ReturnType<typeof createProxyServer> => {
    const proxy = createProxyServer({
      upstreams,
      manifest: served,
      journal,
      logger: log,
      // Absolute, because whoever approves may be in any directory at all.
      approveHint: (actionId: string): string =>
        `${cliCommandFrom(import.meta.url)} approve ${actionId.slice(0, 8)} --journal ${resolve(argv.journal)}`,
    });
    // Best effort, and never at the session's expense: without this row an
    // undo simply has nothing to compare against, which is how it was before.
    proxy.ready
      .then((runId) => {
        for (const [server, started] of startedWith) {
          journal.recordRunServer(runId, server, started.cwd, started.fingerprints);
        }
      })
      .catch((error: unknown) => {
        log.warn({ error: describe(error) }, "could not record what this session's servers were started with");
      });
    return proxy;
  };

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
