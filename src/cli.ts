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

import { platform } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { loadManifest, parseManifest } from "./manifest/load.js";
import type { Manifest, ServerSpec } from "./manifest/types.js";
import {
  labelFor,
  openJournal,
  wasRefused,
  type ActionClass,
  type ActionRow,
  type Journal,
  type RunRow,
  type RunStatus,
  type RunTally,
} from "./journal/journal.js";
import { listAll, verifyAgainstServers, toolShapes } from "./manifest/verify.js";
import { allowAlways, PolicyEditError } from "./manifest/edit.js";
import { fingerprint as pinFingerprint, pinBlock, type ToolShape } from "./manifest/pin.js";
import { createPolicyResolver } from "./manifest/match.js";
import { splitQualified } from "./manifest/types.js";
import {
  describeStanding,
  LIVE_IS_NOT_RECOVERY,
  standing,
  trustsMarks,
  ungoverned,
  untested,
  warnUntested,
} from "./manifest/standing.js";
import { createRouter, type Router } from "./proxy/routing.js";
import { connectUpstream, startAll, startTogether, type Upstream } from "./proxy/upstream.js";
import { clientEnvFor } from "./install/entry-env.js";
import { differing, fingerprint, upstreamEnv, type EnvSource } from "./proxy/environment.js";
import { PROXY_FLAGS } from "./proxy/flags.js";
import { rollback, type RollbackReport, type StepKind } from "./rollback/rollback.js";
import { inspect, verdict, type Resource } from "./rollback/inspect.js";
import { banner, counted, NOTHING_RECORDED_YET, rule, style } from "./style.js";
import { findJournal, findManifest } from "./locate.js";
import { canNotify, desktopNotifier } from "./notify.js";
import {
  afterStatus,
  didYouMean,
  firstOf,
  heldCalls,
  hintLine,
  hintsWanted,
  LEAVE_IT_RUNNING,
  notPinned,
  shortList,
  whatChanged,
  type Hint,
  type Where,
} from "./hints.js";
import { watch } from "./watch.js";
import { openConsole } from "./console.js";
import { cliCommand, proxyCommand } from "./invocation.js";
import { ago, fullTime, shortTime } from "./clock.js";
import { plainly, subject, summariseArgs } from "./describe.js";
import {
  CLIENT_IDS,
  ConfigError,
  discover,
  isClientId,
  LOOKED_FOR,
  type ClientId,
  type ConfigSite,
} from "./install/clients.js";
import { needsConnecting, scan, stateOf } from "./install/connections.js";
import { applyInstall, applyUninstall, invokerFor, planInstall } from "./install/install.js";
import { findDesktop, whereToGetIt } from "./desktop.js";

const COMMANDS = `
  synartesis                                      start here. Live activity,
                                                  what is waiting for you, and
                                                  undo -- all in one place, with
                                                  the arrow keys. Everything
                                                  below can be done from it.
  synartesis install [--client <name>] [--remote] [--dry-run] [--print]
  synartesis uninstall [--client <name>]
  synartesis status
  synartesis init <server> -- <command> [args...]  [--manifest <path>]
  synartesis check [--manifest <path>]
  synartesis pin [--manifest <path>]
  synartesis list [--journal <path>]
  synartesis show <runId> [--full] [--live] [--journal <path>]
  synartesis gates [--journal <path>]
  synartesis close [runId] [--journal <path>]
  synartesis prune [--older-than <days>] [--dry-run] [--journal <path>]
  synartesis proxy --manifest <path> [--server <name>]    what your agent runs
                  [--journal <path>]
                  [--http <port> --token <secret>]      for a client that
                                                        cannot start one
  synartesis desktop
  synartesis watch [--by <name>] [--journal <path>]
  synartesis approve [actionId|--all] [--by <name>] [--journal <path>]
  synartesis deny [actionId|--all] [--by <name>] [--reason <text>] [--journal <path>]
  synartesis allow [<server.tool> --for <30m|2h> | --always | --stop]
  synartesis resolve [actionId] --applied|--failed [--by <name>] [--reason <text>]
  synartesis notify --test
  synartesis undo [runId] [--to <seq>] [--dry-run] [--replan] [--force [--yes]]
                          [--manifest <path>] [--journal <path>]

install is the short way in: it finds what Claude Code, Claude Desktop,
Cursor, Codex, Gemini CLI, Copilot CLI, Antigravity and Devin Desktop (or
Windsurf) already list, writes a policy covering all of it -- using the ones
that ship where they fit -- and points each entry at the proxy. The original config
is copied aside first, and uninstall puts it back. status says what is covered.
A hosted server (a url rather than a command) is covered only with --remote,
through mcp-remote, which opens your browser to sign in.

desktop opens the window, if it is installed. It is a separate download --
shipping it through npm would put a browser engine inside every install of
this command. Both share one journal, so either can undo what the other did.

close ends a run left active by a proxy that was killed; nothing guesses at
that, since several proxies can share one journal.

resolve settles a call whose outcome was never established -- a proxy killed
mid-write, or a server that answered too late. undo stops at one of those
rather than guess, and stopping there used to be permanent: it blocked
everything older in the same run. Only a person can say which way it went, so
this records that they said it, and who. An action resolved as applied still
has no inverse, so undo will report it as something it cannot put back and
carry on with the rest.

prune reclaims space. Putting a file back means keeping what was in it, so a
journal grows at several times what an agent writes and never shrinks by
itself. Nothing still active or still waiting on a person is ever pruned.

Ids may be shortened to any unambiguous prefix. show and undo default to the
most recent run; approve and deny default to the only request waiting. init
adds to an existing manifest rather than replacing it.

watch is the one to leave running. Anything held for approval appears there,
and a and d answer it without a second terminal or an id to copy.

undo stops when somebody has changed the resource since, rather than writing
over them. Three ways past that, and it prints all three: leave it, put the
resource back as the run left it and --replan, or --force to overwrite.

  --client    claude-code, claude-desktop, cursor, codex, gemini-cli,
              copilot-cli, antigravity, devin or windsurf; all by default
  --print     show the entries install would write, and write nothing
  --full      show every argument, snapshot and inverse in full, nothing elided
  --live      read each resource as it is now and say what has changed since
  --server    serve one server from the manifest, keeping its tool names
  --manifest  synartesis.yaml, looked for here and upwards, then in the home
  --journal   beside the manifest, or the one in the home
  --to        lowest sequence to undo; earlier actions are left alone
  --by        who is deciding; defaults to the logged-in user
  --all       approve or deny everything currently waiting
  --once      watch prints the current state and exits
  --json      machine-readable output for list, show and gates
  --dry-run   read current state and print the plan without changing anything
  --unattended  approve with no terminal, from a script. Recorded as unattended,
              so it can be told apart from a yes a person typed
  --applied   resolve: the call did land, though nothing recorded it
  --failed    resolve: the call never landed
  --replan    rebuild each undo from the current manifest, for a run recorded
              under a policy that turned out to be wrong
  --force     undo even where the resource changed after the run. On its own it
              prints the lines it would write over and stops; add --yes to do it
  --older-than  days of history prune keeps; defaults to 30
  --version   print the version and exit

Neither path usually needs giving. A policy that belongs to a project sits in
it and is found from any directory inside it, the way a version control tool
finds its root; anything else lives in ~/.synartesis, which is where the
journal is too. Set SYNARTESIS_HOME to put that somewhere else.

Most commands end by naming the one thing worth doing next, worked out from
what is actually in the journal rather than from what was typed. Set
SYNARTESIS_NO_HINTS to turn that off; --json never carries it.

Exit codes: 0 did what was asked, 1 stopped or left something in place,
            2 bad usage or configuration.
`;

class UsageError extends Error {
  /**
   * Whether the command list helps.
   *
   * It does for a mistyped flag or command. It does not for "there is nothing
   * here to act on", which is a fact about the journal rather than about what
   * was typed -- and answering that with forty lines of unrelated commands
   * buries the one sentence that matters.
   */
  readonly listCommands: boolean;

  constructor(message: string, listCommands = true) {
    super(message);
    this.listCommands = listCommands;
  }
}

/**
 * Everything before a bare `--`. Past it the words belong to the command init
 * is starting, and reading them as ours is how `init db -- some-server
 * --manifest audit.yaml` came to write our policy to the server's path: the
 * server was handed the flag correctly and we took it as well. positional()
 * and rejectUnknownFlags() have always stopped here; this did not.
 */
function ours(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return end === -1 ? argv : argv.slice(0, end);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const mine = ours(argv);
  const at = mine.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const value = mine[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

/**
 * The flags that are followed by a value.
 *
 * One set, because three separate things have to agree about it and they kept
 * not doing: positional() must not read the value as a command name,
 * rejectUnknownFlags() must not read it as a flag of its own -- which made
 * `deny --reason "-see ticket 42"` answer "unknown flag -see ticket 42" -- and
 * FLAGS must accept the flag itself. A test holds the last of those.
 */
const TAKES_VALUE = new Set([
  "--manifest",
  "--journal",
  "--to",
  "--by",
  "--reason",
  "--older-than",
  "--client",
  "--for",
  "--confirm",
]);

function positional(argv: readonly string[]): string[] {
  const values: string[] = [];
  const mine = ours(argv);
  for (let i = 0; i < mine.length; i += 1) {
    const token = mine[i] ?? "";
    if (TAKES_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      values.push(token);
    }
  }
  return values;
}

/**
 * Start a server the way the client that wraps it would, from a terminal that
 * is not that client.
 *
 * Everything a person runs by hand -- undo above all, but also check and pin
 * -- used to start servers with only what the policy declared, so an undo
 * could not authenticate against any server whose token the client held, and
 * a memory server came up on its default file rather than the one the session
 * wrote to. The environment and working directory now come from the client
 * entry that wraps the server; with no such entry, from the policy, as before.
 */
async function startAsTheClientWould(
  manifestPath: string,
  name: string,
  spec: ServerSpec,
  session?: { readonly journal: Journal; readonly runId: string },
): Promise<Upstream> {
  const client = clientEnvFor(manifestPath, name);
  const source: EnvSource =
    client === undefined ? { kind: "manifest" } : { kind: "client", env: client.env };

  // Before acting for a session, check this is the server that session used.
  // Reading the environment from the client entry is right, but the entry can
  // have changed since -- a memory server now pointed at another file -- and
  // then the inverse goes to a store the session never touched, and the undo
  // says it worked. Refusing names the variable; nothing is printed of any
  // value.
  const recorded = session?.journal.runServer(session.runId, name);
  if (session !== undefined && recorded !== undefined) {
    const now = fingerprint(
      session.journal.fingerprintKey(),
      upstreamEnv(name, spec, source),
      Object.keys(recorded.fingerprints),
    );
    const changed = differing(recorded.fingerprints, now);
    if (changed.length > 0) {
      const one = changed.length === 1;
      throw new ConfigError(
        `${changed.join(", ")} ${one ? "is" : "are"} not what this session's ${name} server was started with, ` +
          `so undoing through it now could act on a different store from the one the session wrote to. ` +
          `Set ${one ? "it" : "them"} back as ${one ? "it was" : "they were"} in ${client?.from ?? "the client config"} to undo this session.`,
      );
    }
  }

  // The directory the session's server actually ran in wins over the entry's:
  // the entry may not name one, and the terminal this was typed in is not it.
  const cwd = recorded?.cwd ?? client?.cwd;
  return await connectUpstream(name, spec, {
    env: source,
    stderr: "capture",
    ...(cwd === undefined ? {} : { cwd }),
  });
}

/**
 * Prints the `pins:` block for the servers this manifest names.
 *
 * It prints rather than writes. Pinning is a person vouching for what a tool
 * does today, and a command that silently rewrote the policy file would let
 * that happen without anyone reading it -- which is the whole value gone. What
 * comes out is meant to be looked at, pasted in, and seen in a diff.
 */
async function runPin(argv: readonly string[]): Promise<number> {
  const path = findManifest(flag(argv, "--manifest"));
  const manifest = loadManifest(path);

  let shapes: ReadonlyMap<string, readonly ToolShape[]> = new Map();
  const upstreams: Upstream[] = [];
  try {
    upstreams.push(
      ...(await startAll(Object.entries(manifest.servers), ([name, spec]) =>
        startAsTheClientWould(path, name, spec),
      )),
    );
    shapes = await listAll(upstreams);
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }

  const block = pinBlock(shapes, manifest);
  out("");
  out(`  ${style.label("pins for")}  ${style.strong(path)}`);
  out("");
  for (const line of block.split("\n")) {
    out(`  ${line}`);
  }
  out("");
  out(`  ${style.quiet("Paste this into the manifest. From then on a tool whose shape")}`);
  out(`  ${style.quiet("changes stops the proxy instead of quietly keeping its old policy.")}`);
  out("");
  return 0;
}

/**
 * Loads a manifest and checks it against the servers it names, without
 * touching a journal or serving anything. This is what you run before wiring
 * a policy into a client, rather than finding out from a client that will not
 * start.
 */
/**
 * `--client`, checked against the clients this actually knows.
 *
 * Unvalidated, a typo filtered every site away and install then reported "No
 * MCP client config was found on this machine" -- a statement about the
 * machine, when the fault was the word just typed. Uninstall was worse: it
 * said "Nothing was covered, so nothing was changed", which reads as
 * confirmation that there was nothing to undo. Everywhere else this CLI goes
 * to real trouble over a typo; this was the one place it blamed the user's
 * setup for the user's spelling.
 */
function namedClient(argv: readonly string[]): ClientId | undefined {
  const typed = flag(argv, "--client");
  if (typed === undefined) {
    return undefined;
  }
  if (!isClientId(typed)) {
    const near = didYouMean(typed, CLIENT_IDS);
    throw new UsageError(
      `--client ${typed} is not a client this knows${near === undefined ? "" : `; did you mean ${near}?`}` +
        `\nIt knows: ${CLIENT_IDS.join(", ")}`,
    );
  }
  return typed;
}

async function runCheck(argv: readonly string[]): Promise<number> {
  const path = findManifest(flag(argv, "--manifest"));
  const manifest = loadManifest(path);

  // Before connecting, not after. This is a property of the policy rather than
  // of the servers, and the adapter most worth warning about is the one whose
  // server is least likely to be installed -- so a warning that waited for a
  // successful connect would stay silent in exactly that case.
  const unproven = untested(manifest);
  if (unproven.length > 0) {
    out("");
    for (const line of wrapped(warnUntested(unproven), 74)) {
      out(`  ${style.accent(line)}`);
    }
  }

  // A header written out in full is almost always a token sitting in a file
  // that gets committed and shared. Said, not refused: a public key for a
  // public server is a real case.
  for (const [name, spec] of Object.entries(manifest.servers)) {
    for (const [header, value] of Object.entries(spec.url === undefined ? {} : (spec.headers ?? {}))) {
      if (!value.includes("${")) {
        out("");
        for (const line of wrapped(
          `${name}'s ${header} header is written into the policy itself. If it is a token, move it to the client entry's env and write "\${NAME}" here instead.`,
          74,
        )) {
          out(`  ${style.accent(line)}`);
        }
      }
    }
  }

  const upstreams: Upstream[] = [];
  // Every tool each server offers, kept rather than discarded. verify reads
  // the same list to check the policies against the servers; reading it twice
  // would mean two round trips for one answer.
  const offered = new Map<string, readonly string[]>();
  // No rule, but marked read-only by a server whose marks are trusted: read as
  // reads, not held, so not listed as held below.
  const trustedReads = new Map<string, readonly string[]>();
  try {
    upstreams.push(
      ...(await startAll(Object.entries(manifest.servers), ([name, spec]) =>
        startAsTheClientWould(path, name, spec),
      )),
    );
    const listed = await listAll(upstreams);
    await verifyAgainstServers(upstreams, manifest, listed);
    const resolver = createPolicyResolver(manifest);
    for (const upstream of upstreams) {
      const shapes = listed.get(upstream.name) ?? [];
      const trusted = shapes
        .filter(
          (tool) =>
            tool.readOnly === true &&
            trustsMarks(manifest, upstream.name) &&
            !resolver.resolve(`${upstream.name}.${tool.name}`).matched,
        )
        .map((tool) => tool.name);
      offered.set(
        upstream.name,
        shapes.map((tool) => tool.name).filter((tool) => !trusted.includes(tool)),
      );
      if (trusted.length > 0) {
        trustedReads.set(upstream.name, trusted);
      }
    }
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }

  const counts = new Map<string, number>();
  for (const policy of manifest.tools) {
    counts.set(policy.class, (counts.get(policy.class) ?? 0) + 1);
  }
  const gated = manifest.tools.filter((policy) => policy.gate !== "never").length;

  out("");
  out(`  ${style.label("policy")}  ${style.strong(path)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("servers ")} ${Object.keys(manifest.servers).join(", ")}`);
  for (const entry of standing(manifest)) {
    const said = describeStanding(entry);
    out(
      `  ${style.quiet("        ")} ${style.strong(entry.server)} ${
        entry.provenance === "documented" ? style.accent(said) : style.quiet(said)
      }`,
    );
  }
  // Once, under the servers, where somebody reading a `live` next to their own
  // server is deciding how much that word is worth.
  if (standing(manifest).some((entry) => entry.provenance === "live")) {
    for (const line of wrapped(LIVE_IS_NOT_RECOVERY, 66)) {
      out(`  ${style.quiet("        ")} ${style.quiet(line)}`);
    }
  }
  out(`  ${style.quiet("policies")} ${[...counts].map(([k, v]) => `${String(v)} ${k}`).join(", ")}`);
  out(`  ${style.quiet("guarded ")} ${style.accent(String(gated))}`);

  // Said either way. Silence when nothing is pinned would leave the safer
  // state and the unchecked one looking identical from here.
  const pinned = Object.entries(manifest.pins ?? {});
  const servers = Object.keys(manifest.servers);
  const unpinned = servers.filter((name) => !pinned.some(([held]) => held === name));
  out(
    `  ${style.quiet("pinned  ")} ${
      pinned.length === 0
        ? style.quiet("nothing -- run `synartesis pin`")
        : pinned
            .map(([name, tools]) => `${name} (${String(Object.keys(tools).length)})`)
            .join(", ") + (unpinned.length === 0 ? "" : style.quiet(`; not ${unpinned.join(", ")}`))
    }`,
  );
  out("");
  // Named, not summarised. "Anything not mentioned here is guarded" was true
  // and unusable: it described a rule while the list it applied to sat one
  // round trip away, so the way to find out which tools it meant was to watch
  // an agent stop on one.
  const uncovered = ungoverned(manifest, offered);
  if (uncovered.length === 0) {
    out(`  ${style.quiet("Every tool these servers offer has a policy.")}`);
  } else {
    const total = uncovered.reduce((sum, entry) => sum + entry.tools.length, 0);
    out(
      `  ${style.accent("guarded by default")} ${style.quiet(
        `${String(total)} tool${total === 1 ? "" : "s"} here ${total === 1 ? "has" : "have"} no policy, so ${total === 1 ? "it is" : "they are"} treated as`,
      )}`,
    );
    out(`  ${style.quiet("irreversible and held for a person every time an agent calls")}`);
    out(`  ${style.quiet(`${total === 1 ? "it" : "one"}. Write a policy, or allow it, for any you would rather it got on with.`)}`);
    out("");
    for (const entry of uncovered) {
      for (const line of wrapped(entry.tools.join(", "), 60)) {
        out(`  ${style.quiet(entry.server.padEnd(8))} ${style.strong(line)}`);
      }
    }
  }
  // Said, because it is trust extended to the server: a person should be able
  // to see exactly which tools are let through on the server's own say-so.
  if (trustedReads.size > 0) {
    out("");
    out(
      `  ${style.label("read as reads")} ${style.quiet("no rule, but the server marks these read-only, so they are not held:")}`,
    );
    for (const [server, tools] of trustedReads) {
      for (const line of wrapped(tools.join(", "), 60)) {
        out(`  ${style.quiet(server.padEnd(8))} ${line}`);
      }
    }
    out(`  ${style.quiet("trust_annotations: false on a server turns this off for it.")}`);
  }
  out("");
  // A policy that loads is not a policy anything is running through yet, and
  // the gap between those two is where somebody stalls: check says everything
  // is fine and nothing says what fine leads to.
  //
  // Pinning comes after something has run through it. It guards a policy you
  // have come to rely on against a server changing under it; offered first,
  // it sent people to vouch for tool shapes before they had seen a single
  // undo, which is the wrong way round.
  const used = existsSync(findJournal(flag(argv, "--journal"), path));
  hint(
    firstOf(
      () => (used ? notPinned(manifest) : undefined),
      () => ({
        why: "this is sound; to see which clients it covers",
        run: "status",
        needs: ["manifest", "journal"],
      }),
    ),
  );
  return 0;
}

/**
 * Wrapping every server your MCP client already has, in one command.
 *
 * Doing this by hand meant reading the client's JSON, retyping the command
 * into `init`, then editing the JSON back to point at the proxy -- twice per
 * server, across two files. That is the whole barrier to anyone getting far
 * enough to see an undo work.
 */
async function runInstall(argv: readonly string[]): Promise<number> {
  const manifestPath = findManifest(flag(argv, "--manifest"));
  const only = namedClient(argv);
  const dryRun = argv.includes("--dry-run");
  const printOnly = argv.includes("--print");

  const sites = discover(process.cwd()).filter(
    (site) => only === undefined || site.client === only,
  );
  if (sites.length === 0) {
    out("");
    out(`  ${style.quiet("No MCP client config was found on this machine.")}`);
    out(`  ${style.quiet(LOOKED_FOR)}`);
    out("");
    return 0;
  }

  const invoker = invokerFor(version(), fileURLToPath(import.meta.url));
  // Starting a server can take a while -- npx may be downloading it -- and a
  // command that said nothing until the last one answered looked hung. Said
  // on stderr, so --print's output stays only what it printed.
  const { plans, yaml } = await planInstall(sites, manifestPath, invoker, undefined, {
    remote: argv.includes("--remote"),
    start: !printOnly,
    starting: (name) => {
      process.stderr.write(`  ${style.quiet(`starting ${name} to see what it offers...`)}\n`);
    },
  });
  const total = plans.reduce((sum, plan) => sum + plan.servers.length, 0);

  out("");
  if (invoker.note !== undefined && total > 0) {
    out(`  ${style.accent("note")}  ${style.quiet(invoker.note)}`);
  }
  out(`  ${style.label(dryRun || printOnly ? "would cover" : "covering")}  ${style.strong(manifestPath)}`);
  out(`  ${rule(60)}`);
  for (const plan of plans) {
    out("");
    out(`  ${style.strong(plan.site.label)} ${style.quiet(plan.site.scope)}`);
    out(`  ${style.quiet(plan.site.path)}`);
    for (const server of plan.servers) {
      const note =
        server.again === true
          ? style.quiet("already in your policy from an earlier install; covered again")
          : server.unstarted === true
            ? style.quiet(
                server.adopted === undefined
                  ? "not started here; a policy is drafted when you install"
                  : `not started here; the policy that ships for ${server.adopted} would be used`,
              )
          : server.adopted === undefined
            ? style.accent("drafted, every tool held until you say how to undo it")
            : style.quiet(`the policy that ships for ${server.adopted} (${String(server.tools ?? 0)} tools)`);
      out(`    ${style.strong(server.name.padEnd(18))} ${note}`);
      // Said at the moment of adoption, where a person is choosing to rely on
      // it, rather than left in the file for them to find afterwards.
      if (server.provenance === "documented") {
        out(
          `    ${" ".repeat(18)} ${style.accent("never run against the real server -- check it before trusting undo")}`,
        );
      }
      if (server.direct !== undefined) {
        for (const line of [
          `hosted at ${server.direct}, reached directly with the headers your`,
          "client gave it. They now sit in this entry's env; the policy names them.",
        ]) {
          out(`    ${" ".repeat(18)} ${style.quiet(line)}`);
        }
      }
      // Who holds the sign-in is the first thing to know about a bridge.
      if (server.bridged !== undefined) {
        for (const line of [
          `hosted at ${server.bridged}, reached through mcp-remote,`,
          "which signs you in and keeps that sign-in itself; synartesis never sees it.",
          "Hosted tools are named differently from local packages, so no shipped",
          "policy applies: its writes are held until you write rules for them.",
        ]) {
          out(`    ${" ".repeat(18)} ${style.quiet(line)}`);
        }
      }
    }
    for (const skip of plan.skipped) {
      // Wrapped, not cut: the end of a reason is usually the server's own
      // words about what it needs.
      for (const [at, line] of wrapped(skip.why, 58).entries()) {
        out(`    ${style.quiet((at === 0 ? skip.name : "").padEnd(18))} ${style.quiet(line)}`);
      }
    }
    if (plan.servers.length === 0 && plan.skipped.length === 0) {
      out(`    ${style.quiet("no servers listed")}`);
    }
  }

  if (printOnly) {
    out("");
    out(`  ${style.label("entries")}`);
    for (const plan of plans) {
      for (const server of plan.servers) {
        out(`  ${JSON.stringify({ [server.name]: server.wrapped }, undefined, 2)}`);
      }
    }
    out("");
    return 0;
  }
  if (total === 0) {
    out("");
    out(`  ${style.quiet("Nothing to do; everything found is already covered.")}`);
    out("");
    return 0;
  }
  if (dryRun) {
    out("");
    out(`  ${style.quiet("Nothing was written. Run without --dry-run to apply.")}`);
    out("");
    return 0;
  }

  const applied = applyInstall(plans, manifestPath, yaml);
  out("");
  for (const entry of applied) {
    out(`  ${style.quiet("backed up to")} ${entry.backup}`);
  }
  out("");
  out(`  ${style.quiet("Restart your client, and its servers now run through Synartesis.")}`);
  out("");
  out(`  ${style.quiet("One command shows everything and does everything:")}`);
  out(`  ${style.accent(cliCommand())}`);
  out("");
  out(
    `  ${style.quiet("Live activity, what is held for approval, and undo, all from there.")}`,
  );
  out(`  ${style.quiet("You do not need a second terminal unless you want one.")}`);
  out("");
  return 0;
}

async function runUninstall(argv: readonly string[]): Promise<number> {
  const manifestPath = findManifest(flag(argv, "--manifest"));
  const only = namedClient(argv);
  const sites = discover(process.cwd()).filter(
    (site) => only === undefined || site.client === only,
  );
  const restored = applyUninstall(sites, manifestPath);

  out("");
  if (restored.length === 0) {
    out(`  ${style.quiet("Nothing was covered, so nothing was changed.")}`);
    out("");
    return 0;
  }
  out(`  ${style.label("restored")}`);
  out(`  ${rule(60)}`);
  for (const entry of restored) {
    out("");
    out(`  ${style.strong(entry.site.label)} ${style.quiet(entry.site.scope)}`);
    for (const name of entry.servers) {
      out(`    ${style.strong(name)}`);
    }
    for (const name of entry.unknown) {
      // Removing it would delete a server nobody can put back.
      out(
        `    ${style.accent(name)} ${style.quiet("is wrapped but its original was not recorded; left as it is")}`,
      );
    }
    if (entry.backup !== "") {
      out(`    ${style.quiet(`backed up to ${entry.backup}`)}`);
    }
  }
  out("");
  out(`  ${style.quiet("The policy and journal were left alone.")}`);
  out("");
  return await Promise.resolve(0);
}

/**
 * The journal if there is one. The connections view is useful before an agent
 * has ever run, and refusing to scan because no journal exists yet would make
 * it useless at exactly the moment somebody is setting this up.
 */
function openIfPresent(journalPath: string): Journal | undefined {
  try {
    return existsSync(journalPath) ? openJournal(journalPath, { mustExist: true }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap the servers the reader picked, and say what happened in one line.
 *
 * The same plan-and-apply the install command runs, narrowed to a chosen few:
 * pressing a key in a list should do exactly what the command does, not a
 * second implementation of it that drifts.
 */
async function connectThese(
  targets: readonly { readonly site: ConfigSite; readonly server: string }[],
  manifestPath: string,
): Promise<string> {
  const invoker = invokerFor(version(), fileURLToPath(import.meta.url));
  const wanted = new Map<string, Set<string>>();
  const sites = new Map<string, ConfigSite>();
  for (const target of targets) {
    const key = `${target.site.path}${target.site.scope}`;
    sites.set(key, target.site);
    (wanted.get(key) ?? wanted.set(key, new Set()).get(key))?.add(target.server);
  }

  // Only what was asked for, decided before anything is started. A scan may
  // have found five uncovered servers and the reader may have chosen one.
  const { plans, yaml } = await planInstall(
    [...sites.values()],
    manifestPath,
    invoker,
    (site, name) => wanted.get(`${site.path}${site.scope}`)?.has(name) === true,
    // Picked by name from the list, which is the asking.
    { remote: true },
  );
  const applied = applyInstall(plans, manifestPath, yaml);
  const count = applied.reduce((sum, entry) => sum + entry.servers.length, 0);
  if (count === 0) {
    return "nothing was connected; see the reasons above";
  }
  return `connected ${String(count)}${count === 1 ? " server" : " servers"} \u00b7 restart the client to pick it up`;
}

/** What is covered, what is not, and how big the journal has grown. */
function runStatus(argv: readonly string[]): number {
  const manifestPath = findManifest(flag(argv, "--manifest"));
  const journalPath = findJournal(flag(argv, "--journal"), manifestPath);

  out("");
  out(
    `  ${style.label("policy")}   ${
      existsSync(manifestPath) ? style.strong(manifestPath) : style.quiet(`${manifestPath} (none yet)`)
    }`,
  );
  out(
    `  ${style.label("journal")}  ${
      bytesOf(journalPath) === undefined
        ? style.quiet(`${journalPath} (none yet)`)
        : `${style.strong(journalPath)} ${style.quiet(sizeOf(journalPath))}`
    }`,
  );
  out("");

  const journal = openIfPresent(journalPath);
  try {
    const groups = scan(journal, process.cwd());
    if (groups.length === 0) {
      out(`  ${style.quiet("No MCP client config found.")}`);
      out(`  ${style.quiet(LOOKED_FOR)}`);
      out("");
      return 0;
    }
    const now = new Date();
    for (const group of groups) {
      out(`  ${style.strong(group.label)} ${style.quiet(group.scope)}`);
      if (group.problem !== undefined) {
        out(`      ${style.accent(group.problem)}`);
      } else if (group.connections.length === 0) {
        out(`      ${style.quiet("no servers listed")}`);
      }
      for (const connection of group.connections) {
        const state = stateOf(connection, now);
        out(
          `    ${connection.server.padEnd(20)} ${
            connection.covered ? style.quiet(state) : style.accent(state)
          }`,
        );
      }
      out("");
    }
    const waiting = needsConnecting(groups).length;
    out(
      waiting === 0
        ? `  ${style.quiet("Everything found is covered.")}`
        : `  ${style.accent(`${String(waiting)} not covered.`)} ${style.quiet(`${cliCommand()} install covers them.`)}`,
    );
    out("");
    // Only once there is nothing left to wire up. Two suggestions at once,
    // one of them about coverage and one about a session, is the help page
    // again in miniature.
    // No journal is the state right after installing, and it is the state
    // where somebody most needs telling what to do with the thing they have
    // just wired up. It has no sessions to name, so there is only one answer.
    if (waiting === 0) {
      hint(afterStatus(journal));
    }
  } finally {
    journal?.close();
  }
  return 0;
}

async function runInit(argv: readonly string[]): Promise<number> {
  const name = positional(argv)[1];
  const separator = argv.indexOf("--");
  const command = separator === -1 ? undefined : argv[separator + 1];
  if (name === undefined || command === undefined) {
    throw new UsageError("init needs a server name and a command, as: init crm -- npx -y some-mcp-server");
  }
  if (name.includes(".") || name.includes("__")) {
    throw new UsageError(`server name ${name} may not contain "." or "__"; both qualify tool names`);
  }

  // The home unless a project already has one above where you are standing.
  // Setting a server up should not mean choosing a directory to keep it in.
  const path = findManifest(flag(argv, "--manifest"));
  const force = argv.includes("--force");
  const present = existsSync(path);
  if (present && force) {
    throw new UsageError(
      `--force would discard ${path}. Delete it yourself if that is what you want; init will otherwise add to it.`,
    );
  }

  const draft = await draftManifest({
    name,
    command,
    args: argv.slice(separator + 2),
    ...(present ? { existing: readFileSync(path, "utf8") } : {}),
  });

  // Never write a manifest that would not start: a drafted policy that fails
  // to load is worse than no policy, because it looks finished.
  parseManifest(draft.yaml, path);
  // 0700: the journal that lands in here holds the previous contents of every
  // file an agent writes, and the directory is the first thing guarding it.
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(path, draft.yaml);

  out("");
  out(`  ${style.label(present ? "extended" : "wrote")}  ${style.strong(path)}`);
  out(`  ${rule(54)}`);
  out("");
  if (draft.adopted === undefined) {
    out(`  ${style.quiet("Every tool is guarded until you say how to undo it.")}`);
    out(`  ${style.quiet("Work through the TODOs, then point your MCP client at:")}`);
  } else {
    out(
      `  ${style.quiet(`Recognised ${String(draft.adopted.tools)} tools, so the policy that ships for`)} ` +
        `${style.strong(draft.adopted.server)} ${style.quiet("was used.")}`,
    );
    out(`  ${style.quiet("Read it before you trust it, then point your MCP client at:")}`);
  }
  out("");
  out(`  ${style.accent(`${proxyCommand()} --manifest ${resolve(path)}`)}`);
  out("");
  return 0;
}

/**
 * Ids are uuids, and copying one between two terminals is the clunkiest part
 * of using this. Any unambiguous prefix will do, and where there is only one
 * sensible answer, no id is needed at all.
 */
interface Noun {
  readonly one: string;
  readonly many: string;
}

/**
 * `newest` is for the commands whose default is a run rather than the only
 * candidate. show and undo have always been documented as defaulting to the
 * most recent run; without this that held only until a second run existed,
 * after which both refused and listed every id -- offering --all, which
 * neither of them takes. approve and deny stay strict: "the only one waiting"
 * is a different promise, and guessing which of several to allow is not a
 * guess anything should make.
 */
function pick<T extends { id: string }>(
  candidates: readonly T[],
  given: string | undefined,
  noun: Noun,
  newest = false,
): T {
  const listed = (items: readonly T[]): string =>
    items.map((item) => `  ${item.id}`).join("\n");

  if (given === undefined) {
    const [only, ...rest] = candidates;
    if (only === undefined) {
      throw new UsageError(`there is no ${noun.one} to act on`, false);
    }
    if (rest.length > 0 && !newest) {
      throw new UsageError(
        `there are ${String(candidates.length)} ${noun.many}; name one, or use --all:\n${listed(candidates)}`,
        false,
      );
    }
    return only;
  }

  // An empty id prefix-matches every candidate, which reported an ambiguity
  // with nothing in its subject: "synartesis:  matches 2 runs:". It is nearly
  // always an unset shell variable rather than a person, and it is refused
  // rather than read as absent, because absent means the newest run and for
  // undo that is the wrong thing to do quietly.
  if (given === "") {
    throw new UsageError(`no ${noun.one} was named; an empty id is usually an unset variable`, false);
  }

  const exact = candidates.find((item) => item.id === given);
  if (exact !== undefined) {
    return exact;
  }
  const matches = candidates.filter((item) => item.id.startsWith(given));
  const [first, ...rest] = matches;
  if (first === undefined) {
    throw new UsageError(`no ${noun.one} matches ${given}`, false);
  }
  if (rest.length > 0) {
    throw new UsageError(
      `${given} matches ${String(matches.length)} ${noun.many}:\n${listed(matches)}`,
      false,
    );
  }
  return first;
}

const RUN: Noun = { one: "run", many: "runs" };
const WAITING: Noun = { one: "action awaiting approval", many: "actions awaiting approval" };
const UNSETTLED: Noun = { one: "action whose outcome is unknown", many: "actions whose outcome is unknown" };

// Piping into head or less closes the pipe early. That is the reader saying it
// has seen enough, not an error, and a stack trace there is pure noise.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The one next thing, if there is one.
 *
 * Every caller passes candidates in the order that suits what it just printed,
 * and this says at most the first of them.
 *
 * Nothing here checks --json. The two commands that take it print their object
 * and return before reaching any of this, which is the guard that matters: a
 * sentence addressed to a person is a syntax error to the parser reading that
 * stream, so it has to be impossible rather than merely suppressed. A second
 * check here would be a condition that cannot fire, and the sort that stops
 * being true quietly.
 */
function hint(candidate: Hint | undefined): void {
  if (candidate === undefined || !hintsWanted()) {
    return;
  }
  out(hintLine(candidate, pathArgs(candidate.needs)));
  out("");
}

/**
 * The shortest prefix that still tells these runs apart.
 *
 * Eight is what every other view prints and what a person copies, and any
 * unambiguous prefix is accepted -- but "unambiguous" is a property of the set
 * on screen, not a constant. Widened where it has to be rather than printing
 * thirty-six characters on every line against the chance of a collision.
 */
function idWidth(runs: readonly RunRow[]): number {
  for (let width = 8; width < 36; width += 1) {
    const seen = new Set(runs.map((run) => run.id.slice(0, width)));
    if (seen.size === runs.length) {
      return width;
    }
  }
  return 36;
}

/**
 * What a session did, in the words the rest of the views already use.
 *
 * This is the column the command exists for and it was not there. Three
 * sessions a second apart, one of which wrote a file, one read one and one did
 * nothing, printed as three identical rows distinguished only by a uuid --
 * so the command you run to find the session you want told you nothing about
 * which session you want.
 *
 * `subject` and `plainly` are the console's and watch's, deliberately: a
 * fourth vocabulary for the same facts would be a fourth thing to keep true.
 */
interface Did {
  /** What the session touched, or why there is nothing to name. */
  readonly what: string;
  /** Where that leaves it, and whether it is still the reader's problem. */
  readonly state: string;
}

function didWhat(journal: Journal, run: RunRow, total: number): Did {
  const write = journal.lastWrite(run.id);
  if (write === undefined) {
    // Not a failure and not an omission. A session that only read is one there
    // is nothing to undo in, which is the most useful thing to know about it.
    return {
      what: style.quiet(total === 0 ? "nothing" : "read only"),
      state: style.quiet(run.status === "active" ? "still open" : ""),
    };
  }
  const what = subject(write.args);
  const said = plainly(write);
  const rest = total - 1;
  return {
    what:
      `${style.strong(write.tool)}${what === "" ? "" : ` ${what}`}` +
      (rest > 0 ? style.quiet(`  +${String(rest)} more`) : ""),
    // A run still open outranks whatever its last action did. `complete` was
    // dropped as a column because it is true of nearly every line, but
    // `active` is not -- it is a proxy still working or one that was killed,
    // and it is the whole reason `close` exists. Losing it with the column it
    // shared would have been a real loss hidden inside a tidier table.
    //
    // Otherwise the action's own state, and always, not only when it asks
    // something of the reader: a run that has been undone and one that has not
    // look identical otherwise, and which of the two this is happens to be the
    // question the command gets asked.
    state:
      run.status === "active"
        ? style.accent("still open")
        : said.needs
          ? style.accent(said.text)
          : style.quiet(said.text),
  };
}

/**
 * One cell, exactly `width` printable characters wide.
 *
 * Pads and truncates both, because a column that only pads breaks the moment
 * something longer than expected turns up -- "changed since; not safe to undo"
 * is thirty-one characters and pushed every column after it out of line. The
 * escape codes carry no width, so they are measured out and then left in
 * place; truncation cuts at the end, where a trailing reset does no harm.
 */
function laid(text: string, width: number): string {
  const codes = /\u001b\[[0-9;]*m/g;
  const bare = text.replace(codes, "");
  if (bare.length <= width) {
    return text + " ".repeat(width - bare.length);
  }
  // Rebuilt rather than sliced: slicing the styled string would cut through an
  // escape sequence and spill it onto the screen.
  let kept = "";
  let shown = 0;
  let at = 0;
  for (const match of text.matchAll(codes)) {
    const plain = text.slice(at, match.index);
    const room = width - 1 - shown;
    if (plain.length >= room) {
      return `${kept}${plain.slice(0, room)}\u2026\u001b[0m`;
    }
    kept += plain + match[0];
    shown += plain.length;
    at = match.index + match[0].length;
  }
  return `${kept}${text.slice(at, at + width - 1 - shown)}\u2026`;
}

function runList(journal: Journal, asJson: boolean, journalPath: string): number {
  // Most recent first: the run someone wants to undo is nearly always the last
  // thing that happened.
  const runs = [...journal.listRuns()].reverse();
  // Counted in sql. Reading every action of every run to print three numbers
  // meant this command grew with the size of the snapshots it never looked at.
  const tally = journal.tallyRuns();
  const counted = (id: string): RunTally =>
    tally.get(id) ?? { actions: 0, unknown: 0, waiting: 0, applied: 0 };
  // The id stays full length: this is what scripts read, and the display's
  // shortening is a display decision.
  //
  // `actions` here is a count; in `show --json` it is the array of actions.
  // One name, two types, across the two commands a script uses together --
  // which is a trap, but renaming it is not the way out: this shape is a
  // stability promise with a test holding it, and quietly changing what a
  // script already reads would be a worse fault than the one being fixed.
  //
  // So `actionCount` is added rather than swapped in, and `show --json` emits
  // it too. A new script can use one name that means the same thing in both
  // places; an old one keeps working.
  if (asJson) {
    out(
      JSON.stringify(
        runs.map((run) => {
          const actions = counted(run.id).actions;
          return { ...run, actions, actionCount: actions };
        }),
      ),
    );
    return 0;
  }
  if (runs.length === 0) {
    out("no runs recorded");
    return 0;
  }
  const width = idWidth(runs);
  out("");
  out(`  ${style.label("sessions")}  ${style.quiet("most recent first")}`);
  out(`  ${rule(88)}`);
  out("");
  out(
    style.quiet(
      `  ${"session".padEnd(width)}  ${"started".padEnd(13)}  ${"did".padEnd(26)}  ${"state".padEnd(26)}  agent`,
    ),
  );
  // Consecutive sessions with nothing in them are folded into one line.
  // Clients open a session every time they start, whether or not anything is
  // called, and the journal this was found against had 107 empty sessions
  // among 114: the seven that did something were a scroll away, between rows
  // saying nothing happened. Only in this table -- `--json` is a contract
  // scripts read, and it still lists every one.
  let quiet: RunRow[] = [];
  const flushQuiet = (): void => {
    if (quiet.length === 1) {
      const [only] = quiet;
      if (only !== undefined) {
        const did = didWhat(journal, only, 0);
        out(
          `  ${style.strong(only.id.slice(0, width))}  ${style.quiet(shortTime(only.startedAt).trimEnd().padEnd(13))}  ` +
            `${laid(did.what, 26)}  ${laid(did.state, 26)}  ${style.quiet(only.label ?? "-")}`,
        );
      }
    } else if (quiet.length > 1) {
      const newest = quiet[0];
      const oldest = quiet[quiet.length - 1];
      if (newest !== undefined && oldest !== undefined) {
        out(
          `  ${style.quiet(
            `${"".padEnd(width)}  ${String(quiet.length)} sessions with nothing in them, ` +
              `${shortTime(oldest.startedAt).trim()} to ${shortTime(newest.startedAt).trim()}`,
          )}`,
        );
      }
    }
    quiet = [];
  };
  for (const run of runs) {
    const actions = counted(run.id);
    if (actions.actions === 0) {
      quiet.push(run);
      continue;
    }
    flushQuiet();
    const { unknown, waiting } = actions;
    // Only what the state column has not already said. It is drawn from the
    // last action, so it says "waiting for you" about one held call -- and a
    // note beside it saying "1 awaiting approval" is the same fact twice.
    const notes = [
      unknown === 0 ? "" : `${String(unknown)} of unknown outcome`,
      waiting > 1 ? `${String(waiting)} awaiting approval` : "",
    ].filter((note) => note !== "");
    const note =
      notes.length === 0 ? "" : `  ${style.accent(`(${notes.join("; ")})`)}`;
    // The run's own status is gone as a column. `complete` on nearly every
    // line is a column of noise that pushes the one that varies off the edge,
    // and what a reader wants from it -- was this undone, is it waiting on me
    // -- is said better by the action than by the run.
    const did = didWhat(journal, run, actions.actions);
    out(
      `  ${style.strong(run.id.slice(0, width))}  ${style.quiet(shortTime(run.startedAt).trimEnd().padEnd(13))}  ` +
        `${laid(did.what, 26)}  ${laid(did.state, 26)}  ${style.quiet(run.label ?? "-")}${note}`,
    );
  }
  flushQuiet();
  out("");
  // Only once it is big enough to be worth a sentence. Keeping what was in
  // every file an agent wrote adds up quietly, and finding out from df is
  // finding out too late.
  if ((bytesOf(journalPath) ?? 0) > PRUNE_NAG_BYTES) {
    out(`  ${style.quiet(`This journal is ${sizeOf(journalPath)}; synartesis prune reclaims what is old enough to lose.`)}`);
    out("");
  }
  // A screen of uuids with no verb on it. Whichever of these applies is the
  // reason somebody ran this, and it names the session rather than leaving
  // them to pick one out of forty by eye.
  hint(firstOf(
    () => heldCalls(journal),
    () => whatChanged(journal),
  ));
  return 0;
}

async function runShow(argv: readonly string[], journal: Journal, asJson: boolean): Promise<number> {
  const full = argv.includes("--full");
  const runs = [...journal.listRuns()].reverse();
  // With no id, the newest session that recorded anything -- for the reason
  // bare `undo` looks past empty ones: a client opens a session every time it
  // starts, so the newest is usually one with nothing in it, and "no actions
  // recorded" was the answer most people got to `synartesis show`.
  const given = positional(argv)[1];
  const tally = journal.tallyRuns();
  const run =
    (given === undefined
      ? runs.find((one) => (tally.get(one.id)?.actions ?? 0) > 0)
      : undefined) ?? pick(runs, given, RUN, true);
  const runId = run.id;

  // The journal says what the agent did. It cannot say what has happened to
  // those resources since, because nothing a person does by hand comes
  // through the proxy -- and until this, the only way to find out was to
  // attempt an undo and have it refuse.
  // Nothing recorded means nothing to read, and starting every server the
  // manifest names to discover that is a slow way to say so.
  const inspection =
    argv.includes("--live") && journal.getActions(runId).length > 0
      ? await withUpstreams(
          findManifest(flag(argv, "--manifest")),
          async (router) => await inspect({ journal, router, runId }),
          serversUsedBy(journal, runId),
          { journal, runId },
        )
      : undefined;

  if (asJson) {
    out(
      JSON.stringify({
        run,
        actions: journal.getActions(runId),
        // The same name means the same thing in `list --json`, where `actions`
        // has always been a count and cannot change.
        actionCount: journal.getActions(runId).length,
        ...(inspection === undefined ? {} : { live: inspection.resources }),
      }),
    );
    return 0;
  }

  out("");
  out(`  ${style.label("session")}  ${style.strong(run.label ?? "an agent")}`);
  out(`  ${style.quiet(run.id)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("agent  ")} ${run.label ?? "-"}`);
  out(`  ${style.quiet("started")} ${fullTime(run.startedAt)}  ${style.quiet(ago(run.startedAt))}`);
  out(
    `  ${style.quiet("status ")} ${RUN_STATUS[run.status]}` +
      (run.endedAt === undefined ? "" : style.quiet(`  ended ${fullTime(run.endedAt)}`)),
  );

  const actions = journal.getActions(runId);
  if (actions.length === 0) {
    out("");
    out("no actions recorded");
    return 0;
  }

  out("");
  out(`  ${style.label("timeline")}`);
  out(`  ${rule(72)}`);
  out("");
  const live = new Map((inspection?.resources ?? []).map((found) => [found.seq, found]));
  for (const action of actions) {
    const now = live.get(action.seq);
    out(
      `  ${style.quiet(String(action.seq).padStart(3))}  ${style.strong(`${action.server}.${action.tool}`)}`,
    );
    // The old row started the tool at column 38 after its sequence, class and status.
    // Put those facts beneath it so long server names do not hide what ran.
    // Padded only where a third column follows it, which is a --live reading
    // of the resource and usually absent.
    const alongside = now !== undefined;
    out(
      `       ${badgeOf(action, alongside)} ${statusOf(action, alongside)}` +
        (now === undefined ? "" : `  ${conditionOf(now)}`),
    );
    if (now?.diff !== undefined) {
      for (const line of now.diff.split("\n")) {
        out(`       ${style.quiet(line)}`);
      }
    }
    // Readable by default, complete on request. Truncated JSON was neither:
    // you could not see what the call did, nor what had been removed.
    if (full) {
      out(`       ${style.quiet("arguments")}`);
      for (const line of block(action.args)) {
        out(`         ${line}`);
      }
    } else {
      out(`       ${style.quiet(summariseArgs(action.args, 96))}`);
    }
    if (action.approvedAt !== undefined) {
      // labelFor, not the raw status: a row retired because its approval was
      // spent on the call that actually ran is stored as `denied`, and reading
      // that literally printed "denied by <name>" about the person who had
      // just said yes to a call that then went through.
      const verb = labelFor(action) === "denied" ? "denied" : "approved";
      out(
        `       ${style.accent(`${verb} by ${action.approvedBy ?? "nobody"}`)} ${style.quiet(`at ${fullTime(action.approvedAt)}`)}`,
      );
    }
    if (action.error !== undefined) {
      out(`       ${style.quiet(`note: ${full ? action.error : truncate(action.error, 200)}`)}`);
    }
    if (action.snapshot !== undefined && full) {
      out(`       ${style.quiet("what it replaced")}`);
      for (const line of block(action.snapshot)) {
        out(`         ${line}`);
      }
    }
    if (action.inverse !== undefined) {
      if (full) {
        out(`       ${style.quiet("undo")}`);
        for (const line of block(action.inverse)) {
          out(`         ${line}`);
        }
      } else {
        out(`       ${style.quiet("undo:")} ${style.strong(summariseArgs(inverseArgs(action.inverse), 90))}`);
      }
    }
    // Space belongs between calls, not between an action and its recovery data.
    out("");
  }

  out(`  ${summarise(actions)}`);
  if (inspection !== undefined) {
    out("");
    const spoiled = inspection.resources.some((found) => found.condition === "changed");
    out(`  ${spoiled ? style.accent(verdict(inspection)) : style.quiet(verdict(inspection))}`);
    if (spoiled) {
      out(
        `  ${style.quiet("undo stops at the first of them; ")}${style.strong(`${cliCommand()} undo ${runId.slice(0, 8)} --force`)}${style.quiet(" shows what it would write")}`,
      );
    } else if (actions.some((action) => action.status === "applied" && action.inverse !== undefined)) {
      // The whole point of having just read every resource is that the answer
      // is now known: nothing has moved, so the undo would go through. Saying
      // that and stopping leaves somebody holding a verdict and no verb.
      //
      // Guarded on there being something to undo, and not on the drift check
      // alone. A session whose every call was held, or denied, or already
      // rolled back also has nothing that has moved -- and offering to undo
      // one of those is a hint that is wrong in the one case where somebody
      // has gone to the trouble of asking.
      out("");
      hint({
        // Not a restatement of the verdict directly above it, which has just
        // said in its own words that nothing has moved. A hint that repeats
        // the line above is a line nobody reads twice.
        why: "to see the plan, before anything is written",
        run: `undo ${runId.slice(0, 8)} --dry-run`,
        needs: ["manifest", "journal"],
      });
    }
  } else {
    out("");
    out(
      `  ${style.quiet("has anything changed since? ")}${style.strong(`${cliCommand()} show ${runId.slice(0, 8)} --live`)}`,
    );
  }
  out("");
  return 0;
}

/** What the world says about this action now, as against what the journal says. */
function conditionOf(found: Resource): string {
  switch (found.condition) {
    case "changed":
      return style.accent("changed since");
    case "unchanged":
      return style.quiet("unchanged");
    case "restored":
      return style.quiet(found.note === undefined ? "back to before" : `back to before, ${found.note}`);
    case "superseded":
      return style.quiet("older write to the same thing");
    case "not-applied":
      return style.quiet(`never applied (${found.note ?? "settled"})`);
    default:
      return style.quiet(found.note ?? "cannot tell");
  }
}

const CLASS_MARK: Record<ActionClass, string> = {
  readonly: "\u00b7",
  reversible: "\u2190",
  compensable: "\u2248",
  irreversible: "!",
  unclassified: "?",
};

/** Wide enough for the longest class name plus its marker. */
const BADGE_WIDTH = "irreversible".length + 2;

/**
 * Padded before it is coloured: escape codes are not printable width.
 *
 * `pad` is required rather than defaulted, because it is off in the ordinary
 * case. The padding exists to line the next column up, and once the tool name
 * moved to a line of its own there was no next column -- so every action
 * carried a tail of spaces inside its own escape codes, where trimming the
 * finished line could not reach them. A default of true would be the wrong
 * answer more often than the right one, and one no call site asks for.
 */
/** A session's status in the words the rest of the screen uses. */
const RUN_STATUS: Readonly<Record<RunStatus, string>> = {
  active: "still running",
  complete: "finished",
  rolled_back: "undone",
  partial: "partly undone",
};

function badgeOf(action: ActionRow, pad: boolean): string {
  const name = `${CLASS_MARK[action.class]} ${action.class}`;
  const plain = pad ? name.padEnd(BADGE_WIDTH) : name;
  return action.class === "irreversible" ? style.accent(plain) : style.quiet(plain);
}

function statusOf(action: ActionRow, pad: boolean): string {
  // The words list, watch and the console already use. This printed the
  // stored status -- "applied", "unrecoverable" -- which is the journal's
  // vocabulary, not the reader's, and the one screen people open to find out
  // what happened was the one that made them translate it.
  const label = plainly(action).text;
  const text = pad ? label.padEnd(22) : label;
  if (wasRefused(action)) {
    return style.accent(text);
  }
  if (action.status === "gated") {
    return style.accent(text);
  }
  return style.quiet(text);
}

/**
 * Broken over lines rather than cut off. The reason a call is being held ends
 * with the server's own words, so truncating it removes the only part that
 * says anything the tool name did not already.
 */
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines;
}

/** Pretty-printed and never shortened, for --full. */
function block(value: unknown): string[] {
  return JSON.stringify(value, undefined, 2).split("\n").map((line) => style.quiet(line));
}

/** An inverse is a call; what a reader wants from it is the arguments. */
function inverseArgs(inverse: unknown): unknown {
  if (typeof inverse === "object" && inverse !== null && "args" in inverse) {
    return (inverse as { args?: unknown }).args;
  }
  return inverse;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function summarise(actions: readonly ActionRow[]): string {
  const counts = new Map<string, number>();
  for (const action of actions) {
    // Counted under the name the timeline shows, or the footer disagreed with
    // the rows above it about how many calls anybody refused.
    const label = labelFor(action);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${String(v)} ${k}`);
  const undoable = actions.filter((a) => a.inverse !== undefined).length;
  return `${counted(actions.length, "action")}: ${parts.join(", ")} | ${String(undoable)} with a recorded undo`;
}

/**
 * Repeated back in any command this prints, because whoever copies the line may
 * well be in a different directory than the one it was printed from -- and,
 * more to the point, may be looking at a journal that is not the default one.
 * Empty when the path was found rather than given, so an ordinary line stays
 * short.
 */
let journalArg = "";
let manifestArg = "";

/** The paths a hinted command has to be told about, in the order they read. */
function pathArgs(needs: readonly Where[] | undefined): string {
  if (needs === undefined) {
    return "";
  }
  return needs.map((what) => (what === "journal" ? journalArg : manifestArg)).join("");
}

/** Past this, a journal is worth mentioning without being asked. */
const PRUNE_NAG_BYTES = 100 * 1024 * 1024;

/** Undefined rather than zero, so "cannot read it" stays distinct from "empty". */
function bytesOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** Bytes as something a person reads, since this is the point of the command. */
function sizeOf(path: string): string {
  const bytes = bytesOf(path);
  if (bytes === undefined) {
    return "unknown";
  }
  if (bytes < 1024 * 1024) {
    return `${String(Math.max(1, Math.round(bytes / 1024)))} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PRUNE_DEFAULT_DAYS = 30;

/**
 * A hundred years, which is not a limit anybody will meet and is well inside
 * the range a Date can hold. Without a ceiling, --older-than 999999999 puts
 * the cutoff before the earliest representable date, toISOString throws a
 * RangeError, and the user is told "Invalid time value" -- which names neither
 * the flag nor the problem, and exits 1 as though the prune had failed partway
 * rather than 2 as though they had mistyped a flag.
 */
const PRUNE_MAX_DAYS = 36500;

/**
 * Every write keeps the file as it was, the file as it became, and the call
 * that did it, so a journal grows at several times the bytes an agent writes
 * and never shrinks on its own. This is the way to get that space back.
 *
 * It is asked for, never automatic. A tool whose whole purpose is that you can
 * still undo what happened has no business deleting that history on a timer.
 */
function runPrune(argv: readonly string[], journal: Journal, journalPath: string): number {
  const given = flag(argv, "--older-than");
  const days = given === undefined ? PRUNE_DEFAULT_DAYS : Number(given);
  if (!Number.isFinite(days) || days < 0 || days > PRUNE_MAX_DAYS) {
    throw new UsageError(
      `--older-than takes a number of days from 0 to ${String(PRUNE_MAX_DAYS)}, not ${given ?? ""}`,
    );
  }

  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stale = journal.prunableRuns(before);
  const planned = argv.includes("--dry-run");
  const sizeBefore = sizeOf(journalPath);

  out("");
  out(`  ${style.label(planned ? "would prune" : "prune")}  ${style.quiet(`older than ${String(days)} days`)}`);
  out(`  ${rule(54)}`);
  out("");
  // Named, because a journal is found by walking up from here and this is the
  // one command that throws history away. Being told afterwards which file
  // that was is too late.
  out(`  ${style.quiet(journalPath)}`);
  out("");

  if (stale.length === 0) {
    out(`  ${style.quiet(`Nothing is older than ${String(days)} days and finished with.`)}`);
    out("");
    out(`  ${style.quiet(`The journal is ${sizeBefore}. Runs still active, and any`)}`);
    out(`  ${style.quiet("holding a call that is waiting or in flight, are never pruned.")}`);
    out("");
    return 0;
  }

  let actions = 0;
  for (const run of stale) {
    actions += run.actions;
    out(
      `  ${style.strong((run.label ?? "an agent").padEnd(24))} ` +
        `${style.quiet(run.at.slice(0, 19).replace("T", " "))}  ` +
        `${style.quiet(run.status.padEnd(11))} ${style.quiet(counted(run.actions, "action"))}`,
    );
  }
  out("");

  if (planned) {
    out(
      `  ${style.accent(counted(stale.length, "run"))} ${style.quiet(`and ${counted(actions, "action")} would go. Nothing was changed.`)}`,
    );
    out("");
    return 0;
  }

  const removed = journal.deleteRuns(stale.map((run) => run.id));
  // After the delete and outside its transaction, which is the only place
  // VACUUM can run -- and without it the file stays exactly as big as it was.
  journal.vacuum();

  out(
    `  ${style.accent(counted(removed.runs, "run"))} ${style.quiet(`and ${counted(removed.actions, "action")} removed.`)}`,
  );
  out(`  ${style.quiet(`Journal ${sizeBefore} \u2192 ${sizeOf(journalPath)}.`)}`);
  out("");
  return 0;
}

/**
 * Settles an outcome the machine could not establish, on a person's word.
 *
 * `pending` is the one status that means "a call went out and nobody knows
 * what it did", and undo stops at one rather than producing a state that is
 * neither the before nor the after. That is right, and until now it was
 * also permanent: nothing in this CLI could settle such a row, so a single
 * interrupted call blocked the undo of everything older in its run for ever,
 * and the only way past was `--to` above it, which abandons the rest.
 *
 * The machine cannot answer the question, so this asks the one party who
 * can, records what they said and who they were, and stops there. Settling
 * one as `applied` does not invent an inverse for it -- none was ever
 * resolved -- so undo will report it as something it cannot put back and go
 * on to the rest of the run. That is the whole point: unblocking the run and
 * undoing the action are different things, and only the first is on offer.
 */
function runResolve(argv: readonly string[], journal: Journal): number {
  const applied = argv.includes("--applied");
  const failed = argv.includes("--failed");
  if (applied === failed) {
    throw new UsageError(
      "resolve needs exactly one of --applied (the call landed) or --failed (it never did)",
    );
  }
  const by = flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";
  const why = flag(argv, "--reason");
  const given = positional(argv)[1];

  // Among every action first, so a row somebody already settled is told what
  // became of it rather than "no such action" -- the same courtesy approve
  // pays, and for the same reason: the id came from somewhere.
  if (given !== undefined) {
    const already = journal.getAction(given);
    if (already !== undefined && already.status !== "pending") {
      process.stderr.write(
        `synartesis: ${given} is not waiting to be resolved (it is ${labelFor(already)})\n`,
      );
      return 1;
    }
  }

  const action = pick(journal.listPending(), given, UNSETTLED);
  const outcome = applied ? "applied" : "failed";
  // Who said so and why, on the row, because this is the one status in the
  // journal that was decided by a person rather than observed. An audit that
  // cannot tell those apart is worse than one that records less.
  const note =
    `resolved as ${outcome} by ${by}` + (why === undefined ? "" : `: ${why}`);
  if (!journal.settleByHand(action.id, outcome, note)) {
    const now = journal.getAction(action.id);
    process.stderr.write(
      `synartesis: ${action.id} was settled by the proxy first (it is ${now?.status ?? "gone"})\n`,
    );
    return 1;
  }

  out("");
  out(
    `  ${style.accent(outcome)} ${style.strong(`${action.server}.${action.tool}`)} ${style.quiet(action.id.slice(0, 8))}`,
  );
  out("");
  out(
    `  ${style.quiet(
      applied
        ? "Undo will now pass it, and report it as something it cannot put back:"
        : "Undo will now pass it, as a call that never applied:",
    )}`,
  );
  out(`  ${style.strong(`${cliCommand()} undo ${action.runId.slice(0, 8)}`)}`);
  out("");
  return 0;
}

function runClose(argv: readonly string[], journal: Journal): number {
  // Left active by a proxy that was killed rather than disconnected. Nothing
  // can tell that apart from a run still going, so this is asked for, never
  // guessed: several proxies can share one journal.
  const all = journal.listRuns();
  const given = positional(argv)[1];
  // Resolved against every run, not only the active ones. Picking from the
  // active list meant naming a run that had already finished answered "no run
  // matches", which is untrue of a run sitting in `list` and sends people
  // hunting for a problem they do not have. closeAbandonedRun only touches a
  // run that is still active, so it is left to say no, and the branch below
  // reports which of the two mistakes it was.
  const active = [...all.filter((candidate) => candidate.status === "active")].reverse();
  // Nothing left open is the ordinary state, not a mistake. Falling through to
  // pick() made `synartesis close` -- which is what somebody runs to check --
  // answer a tidy journal with a usage error and forty lines of help.
  if (given === undefined && active.length === 0) {
    out("");
    out(`  ${style.quiet("nothing is open; every run has ended cleanly")}`);
    out("");
    hint(firstOf(
    () => heldCalls(journal),
    () => whatChanged(journal),
  ));
    return 0;
  }
  const run =
    given === undefined ? pick(active, undefined, RUN, true) : pick([...all].reverse(), given, RUN, true);
  const closed = journal.closeAbandonedRun(run.id);
  out("");
  out(
    closed
      ? `  ${style.label("closed")}  ${style.strong(run.id)}`
      : `  ${style.quiet(`${run.id} was not active.`)}`,
  );
  out("");
  return closed ? 0 : 1;
}

function runGates(journal: Journal, asJson: boolean): number {
  const waiting = journal.listGated();
  if (asJson) {
    out(JSON.stringify(waiting));
    return 0;
  }
  if (waiting.length === 0) {
    out("");
    out(`  ${style.quiet("Nothing is waiting for a decision.")}`);
    out("");
    // An empty answer to a question is the one place where saying nothing
    // else reads as a failure rather than as a clean result.
    hint(firstOf(
      () => whatChanged(journal),
      () => LEAVE_IT_RUNNING,
    ));
    return 0;
  }
  out("");
  out(`  ${style.label("awaiting approval")}`);
  out(`  ${rule(72)}`);
  out("");
  for (const action of waiting) {
    out(`  ${style.strong(action.id)}  ${style.quiet(action.ts)}`);
    out(`  ${style.accent(`${action.server}.${action.tool}`)}  ${style.quiet(truncate(JSON.stringify(action.args), 88))}`);
    // The reason, because approving is the decision this screen exists for and
    // it was being made on a tool name and a bag of arguments alone.
    for (const [at, line] of wrapped(action.error ?? "held by policy", 76).entries()) {
      out(`  ${at === 0 ? style.quiet(action.class) : " ".repeat(action.class.length)}  ${style.quiet(line)}`);
    }
    out("");
  }
  const self = cliCommand();
  out(
    `  ${style.quiet(`${self} approve`)} ${style.accent(waiting[0]?.id.slice(0, 8) ?? "<id>")} ${style.quiet(`--by <name>${journalArg}`)}`,
  );
  out(`  ${style.quiet(`${self} approve --all --by <name>${journalArg}`)}`);
  out("");
  return 0;
}

function runDecision(argv: readonly string[], journal: Journal, approving: boolean): number {
  // A yes needs a person at a terminal. An agent with a shell -- Claude Code,
  // Codex -- runs commands without one, and until 0.9 it was handed the exact
  // approve command to relay, which it could simply run itself, recorded as
  // whoever was logged in. The command no longer reaches the agent at all;
  // this is the second, smaller half: an agent that finds the command anyway
  // is refused. It is a speed bump, not a wall -- a process running as you can
  // write the journal directly -- and the changelog says so. Denying needs no
  // such check: a no never lets anything through.
  //
  // The message is read by whoever ran this, which may be the agent, so it
  // does not name the way past; --help does.
  const unattended = argv.includes("--unattended");
  if (approving && !process.stdin.isTTY && !unattended) {
    throw new UsageError(
      "approve needs a person at a terminal, so that an agent with a shell cannot approve its own calls. " +
        "Run it in your terminal, or answer it in synartesis watch. For approving from a script, see synartesis --help.",
      false,
    );
  }
  const waiting = journal.listGated();
  const given = positional(argv)[1];
  // "unknown" is a poor thing to find in an audit trail when the machine knows
  // perfectly well who is logged in. --by still wins, for approving on behalf
  // of someone else. An approval given with no terminal says so, so it can be
  // told apart from one a person typed.
  const named =
    flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";
  const by = approving && unattended ? `${named} (unattended)` : named;
  const reason = flag(argv, "--reason") ?? "denied by operator";

  // Looked up among everything first, so an action that has already been
  // settled gets told what became of it rather than "no such action".
  if (given !== undefined) {
    const settled = journal.getAction(given);
    // Changing your mind. A person's no stands against the agent's retries
    // for an hour; approving the same row is how it is taken back, and the
    // row goes back to waiting for the agent's next attempt as any approval
    // does. Only a person's denial -- a spent approval is denied too, and
    // reversing one of those would authorise a call a second time.
    if (approving && settled?.status === "denied" && journal.reverseDenial(settled.id, by)) {
      out(
        `  ${style.accent("approved")} ${style.strong(`${settled.server}.${settled.tool}`)} ${style.quiet(settled.id)} ${style.quiet("(was denied)")}`,
      );
      out("");
      hint({ why: "the agent can make that call again now, and it will go through" });
      return 0;
    }
    if (settled !== undefined && settled.status !== "gated") {
      process.stderr.write(
        `synartesis: ${given} is no longer awaiting approval (it is ${labelFor(settled)})\n`,
      );
      return 1;
    }
  }

  const targets = argv.includes("--all")
    ? waiting
    : [pick(waiting, given, WAITING)];
  if (targets.length === 0) {
    out("nothing is awaiting approval");
    return 0;
  }

  let failed = 0;
  let settled = 0;
  for (const action of targets) {
    const changed = approving
      ? journal.approve(action.id, by)
      : journal.denyByPerson(action.id, by, reason);
    if (!changed) {
      // A decision that lands after the action settled must not look like it
      // took effect.
      const now = journal.getAction(action.id);
      process.stderr.write(
        `synartesis: ${action.id} is no longer awaiting approval (it is ${now?.status ?? "gone"})\n`,
      );
      failed += 1;
      continue;
    }
    settled += 1;
    out(
      `  ${style.accent(approving ? "approved" : "denied")} ${style.strong(`${action.server}.${action.tool}`)} ${style.quiet(action.id)}`,
    );
  }
  // What approving does is the question this command never answered. Nothing
  // is called from here -- the agent retries and the approval is spent on that
  // retry -- so somebody who approves and then watches for something to happen
  // is waiting on a thing that has already been handed back to the agent.
  //
  // Only when a decision actually landed. Every target can fail: a proxy can
  // settle the last held call between listGated and approve, and the branch
  // above exists precisely so that "must not look like it took effect". A
  // sentence on stdout saying the agent may go ahead, under a line on stderr
  // saying nothing was approved, is that care undone.
  if (settled > 0) {
    out("");
    hint(
      firstOf(
        () => heldCalls(journal),
        () =>
          approving
            ? { why: "the agent can make that call again now, and it will go through" }
            : settled === 1
              ? {
                  why: "refused; if the agent asks again it is told you said no. Changed your mind?",
                  run: `approve ${targets[0]?.id.slice(0, 8) ?? ""}`,
                  needs: ["journal"],
                }
              : { why: "refused; if the agent asks again it is told you said no" },
      ),
    );
  }
  return failed === 0 ? 0 : 1;
}

/** The longest `allow --for` takes: a working day, not a standing policy. */
const ALLOW_MAX_MINUTES = 24 * 60;

function allowFor(given: string): number {
  const found = /^(\d+)(m|h)$/.exec(given.trim());
  const minutes = found === null ? NaN : Number(found[1]) * (found[2] === "h" ? 60 : 1);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > ALLOW_MAX_MINUTES) {
    throw new UsageError(
      `--for takes minutes or hours up to a day, like 30m or 2h, not ${given}. For good, use --always.`,
    );
  }
  return minutes;
}

/**
 * `allow`: stop being asked about one tool, for a while or for good.
 *
 * Before this, "stop asking me" meant editing the policy by hand and
 * restarting the client, in the middle of whatever the agent was doing -- so
 * people approved the same harmless call over and over, which is exactly how
 * an approval prompt becomes something clicked through without reading.
 *
 * --for is a row in the journal: no reload, in force on the next call, and it
 * runs out by itself. --always edits the policy, keeps the tool's class, and
 * takes effect when the client next starts the server. Neither says anything
 * about a call whose outcome is unknown; that is still asked about.
 *
 * Granting needs a person at a terminal, as approving does. Taking one back
 * never does: a no never lets anything through.
 */
async function runAllow(argv: readonly string[], journalPath: string): Promise<number> {
  const given = positional(argv)[1];
  const forFlag = flag(argv, "--for");
  const always = argv.includes("--always");
  const stop = argv.includes("--stop");
  const now = new Date();

  if (given === undefined) {
    if (forFlag !== undefined || always || stop) {
      throw new UsageError("allow needs the tool, as server.tool -- for example crm.send_email");
    }
    const journal = openJournalOrExplain(journalPath);
    try {
      const current = journal.listAllowances(now.toISOString());
      out("");
      if (current.length === 0) {
        out(`  ${style.quiet("Nothing is being let through without asking.")}`);
      }
      for (const one of current) {
        out(
          `  ${style.strong(`${one.server}.${one.tool}`)}  ${style.quiet(`until ${shortTime(one.until, now)}, allowed by ${one.by}`)}`,
        );
      }
      out("");
      return 0;
    } finally {
      journal.close();
    }
  }

  const named = splitQualified(given);
  if (named === undefined) {
    throw new UsageError(`${given} is not a tool name; write it as server.tool, for example crm.send_email`);
  }
  if ([forFlag !== undefined, always, stop].filter(Boolean).length !== 1) {
    throw new UsageError(
      `say how long: allow ${given} --for 1h, allow ${given} --always, or allow ${given} --stop`,
    );
  }
  const who = flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";

  if (stop) {
    const journal = openJournalOrExplain(journalPath);
    try {
      const stopped = journal.stopAllowance(named.server, named.tool, who, now.toISOString());
      out(
        stopped
          ? `  ${style.accent("stopped")} ${style.strong(given)} ${style.quiet("is held again from its next call")}`
          : `  ${style.quiet(`${given} was not being let through`)}`,
      );
      if (stopped) {
        out(`  ${style.quiet("A rule written with --always stays in the policy; edit it there.")}`);
      }
      return 0;
    } finally {
      journal.close();
    }
  }

  const unattended = argv.includes("--unattended");
  const interactive = process.stdin.isTTY;
  if (!interactive && !unattended) {
    throw new UsageError(
      "allow needs a person at a terminal, so that an agent with a shell cannot allow its own calls. " +
        "Run it in your terminal. For allowing from a script, see synartesis --help.",
      false,
    );
  }
  const by = unattended ? `${who} (unattended)` : who;
  const manifestPath = findManifest(flag(argv, "--manifest"));
  const manifest = loadManifest(manifestPath);
  const spec = manifest.servers[named.server];
  if (spec === undefined) {
    const near = didYouMean(named.server, Object.keys(manifest.servers));
    throw new UsageError(
      `${manifestPath} has no server called ${named.server}${near === undefined ? "" : `; did you mean ${near}?`}`,
    );
  }
  const { policy } = createPolicyResolver(manifest).resolve(given);

  if (forFlag !== undefined) {
    const minutes = allowFor(forFlag);
    const until = new Date(now.getTime() + minutes * 60_000).toISOString();
    const journal = openJournalOrExplain(journalPath);
    try {
      journal.allow(named.server, named.tool, by, until);
    } finally {
      journal.close();
    }
    out("");
    out(
      `  ${style.accent("allowed")} ${style.strong(given)} ${style.quiet(`until ${shortTime(until, now)} -- its calls go out without asking, and are still recorded`)}`,
    );
    if (policy.gate !== "always" && policy.gate !== "on_write") {
      out(`  ${style.quiet("(the policy was not holding it anyway)")}`);
    } else if (policy.class === "irreversible") {
      out(`  ${style.quiet("These cannot be undone. Nothing will ask before each one goes out.")}`);
    }
    out(`  ${style.quiet(`Takes effect on its next call. To end it sooner: synartesis allow ${given} --stop`)}`);
    out("");
    return 0;
  }

  // --always. The pin, only when the server is pinned and this tool is not:
  // a rule that newly matches it would stop the proxy starting otherwise.
  const text = readFileSync(manifestPath, "utf8");
  const pins = manifest.pins?.[named.server];
  let pin: string | undefined;
  if (pins !== undefined && pins[named.tool] === undefined) {
    const upstream = await startAsTheClientWould(manifestPath, named.server, spec);
    try {
      const shape = (await toolShapes(upstream)).find((tool) => tool.name === named.tool);
      if (shape === undefined) {
        throw new UsageError(`${named.server} has no tool called ${named.tool}`);
      }
      pin = pinFingerprint(shape.inputSchema);
    } finally {
      await upstream.close();
    }
  }
  let edit;
  try {
    edit = allowAlways({
      text,
      file: manifestPath,
      server: named.server,
      tool: named.tool,
      by,
      date: now.toISOString().slice(0, 10),
      ...(pin === undefined ? {} : { pin }),
    });
  } catch (error: unknown) {
    if (error instanceof PolicyEditError) {
      process.stderr.write(`synartesis: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  if (edit.how === "already") {
    out(`  ${style.quiet(`${given} is already let through by ${manifestPath}`)}`);
    return 0;
  }

  // For good, on a tool that cannot be undone, is the one decision here that
  // deserves more than a keypress: the name typed out, so it is read.
  if (edit.policy.class === "irreversible") {
    const confirmed = unattended
      ? flag(argv, "--confirm")
      : await ask(`  ${given} cannot be undone. Type its name to stop holding it for good: `);
    if (confirmed?.trim() !== given) {
      process.stderr.write(`synartesis: not confirmed, so ${manifestPath} was not changed\n`);
      return 1;
    }
  }

  // Written beside and moved into place, so a crash leaves the old policy or
  // the new one and never half of each -- and refused if somebody else wrote
  // the file while this was deciding.
  if (readFileSync(manifestPath, "utf8") !== text) {
    process.stderr.write(`synartesis: ${manifestPath} changed while this was running; nothing was written\n`);
    return 1;
  }
  const beside = `${manifestPath}.${String(process.pid)}.tmp`;
  writeFileSync(beside, edit.text, { mode: statSync(manifestPath).mode });
  renameSync(beside, manifestPath);

  out("");
  out(
    `  ${style.accent("allowed")} ${style.strong(given)} ${style.quiet(`for good -- ${edit.how === "added" ? "a rule was added to" : "its rule was changed in"} ${manifestPath}`)}`,
  );
  if (edit.policy.class === "irreversible") {
    out(`  ${style.quiet("It still cannot be undone: each call is recorded, and none is held.")}`);
  }
  if (pin !== undefined) {
    out(`  ${style.quiet("Pinned at the shape it has now, as the rest of the server is.")}`);
  }
  out(`  ${style.quiet("Takes effect when your client next starts the server. Until then:")}`);
  out(`  ${style.quiet(`synartesis allow ${given} --for 1h`)}`);
  out("");
  return 0;
}

/** One line from a person at the terminal. */
async function ask(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

/**
 * `alreadyForcing` suppresses the menu of ways on: somebody who typed --force
 * has chosen one already, and offering it back to them is noise.
 *
 * `as` is the rest of what was typed -- --replan, --force --yes -- so that the
 * command offered after a dry run is the command that was just planned. Built
 * by the caller rather than read back off the report, because the report says
 * what happened and not what it was asked for: a plan rebuilt from the current
 * manifest looks exactly like one taken from the recorded inverses.
 */
/** What each step is, in words, and in the conditional for a dry run. */
function stepWords(kind: StepKind, dryRun: boolean): string {
  switch (kind) {
    case "revert":
      return dryRun ? "would put back" : "put back";
    case "skip":
      return "nothing to undo";
    case "already-reverted":
      return "already undone";
    case "permanent":
      return "cannot undo";
    case "kept":
      return "left alone";
    case "halt":
      return "stopped";
  }
}

/**
 * The result line. A dry run that ended `rolled_back` was the one line in the
 * output that read as the thing having happened.
 */
function resultWords(status: RollbackReport["status"], dryRun: boolean): string {
  switch (status) {
    case "rolled_back":
      return dryRun ? "would all be undone (nothing was written)" : "all undone";
    case "partial":
      return dryRun ? "would be partly undone (nothing was written)" : "partly undone";
  }
}

function report(result: RollbackReport, alreadyForcing = false, as = ""): number {
  out("");
  out(`  ${style.label(result.dryRun ? "dry run" : "undo")}  ${style.strong(result.runId)}`);
  out(`  ${rule(72)}`);
  out("");
  let separated = false;
  // A session that mostly read printed a line per read, each saying there was
  // nothing to undo, and buried the two lines that were the undo. Consecutive
  // reads are one line with a count.
  let reads = 0;
  const flushReads = (): void => {
    if (reads > 0) {
      out(`       ${style.quiet(`${String(reads)} read${reads === 1 ? "" : "s"}, nothing to undo`)}`);
      reads = 0;
    }
  };
  for (const step of result.steps) {
    if (step.kind === "skip" && step.reason === "readonly") {
      reads += 1;
      continue;
    }
    flushReads();
    // Set apart by a rule rather than mixed in: these are the ones --to is
    // leaving alone, and reading them as part of the plan would invert what
    // they mean.
    if (step.kind === "kept" && !separated) {
      separated = true;
      out("");
      out(`  ${style.quiet("left alone")}`);
    }
    const unverified =
      step.kind === "revert" && !step.verified ? `  ${style.accent("[unverified]")}` : "";
    const said = stepWords(step.kind, result.dryRun);
    const kind =
      step.kind === "halt" || step.kind === "permanent"
        ? style.accent(said.padEnd(16))
        : said.padEnd(16);
    out(
      `  ${style.quiet(String(step.seq).padStart(3))}  ${kind} ` +
        `${style.strong(`${step.server}.${step.tool}`)}  ${style.quiet(step.reason)}${unverified}`,
    );
    // Under the line it qualifies, and in the attention colour, because the
    // whole failure this fixes was a line that looked exactly like a sound
    // one. A caveat rendered quietly enough to skip is the same bug again.
    if (step.note !== undefined && step.kind !== "halt") {
      // Wrapped, not truncated, for the reason the gates screen wraps: the
      // tail of this is the server's own words about what went wrong, and
      // cutting it removes the only part that says anything new.
      for (const [at, line] of wrapped(step.note, 62).entries()) {
        out(`       ${at === 0 ? style.accent("caveat") : "      "}  ${style.quiet(line)}`);
      }
    }
    if (step.plan !== undefined && step.kind === "revert") {
      const verb = `${step.replanned === true ? "replanned, " : ""}${result.dryRun ? "would call" : "called"}`;
      out(
        `       ${style.quiet(verb)} ${step.plan.server}.${step.plan.tool} ` +
          // summariseArgs, not truncated json: the raw form spent its whole
          // budget on a long path's leading directories and cut off before
          // the filename, so every step read "would call fs.write_file
          // {path: /Users/.../very/long/pre..." and named nothing.
          style.quiet(summariseArgs(step.plan.args, 120)),
      );
    }
  }
  flushReads();
  if (result.halted !== undefined) {
    const halt = result.halted;
    out("");
    out(
      `  ${style.accent("halted")} ${style.quiet(`at ${String(halt.seq)}`)}  ${halt.reason}\n  ${style.quiet("nothing was written here")}`,
    );
    if (halt.detail !== "") {
      out("");
      for (const line of halt.detail.split("\n")) {
        out(`  ${style.quiet(line)}`);
      }
    }
    if (halt.overwrites !== undefined && halt.overwrites !== "") {
      out("");
      out(`  ${style.accent("undoing anyway would write:")}`);
      for (const line of halt.overwrites.split("\n")) {
        out(`  ${style.quiet(line)}`);
      }
    }
    // A halt with no way past it is half an answer. Both ways are one line
    // each and both are commands, because a person reading this is looking
    // for what to type next, not for a paragraph about why it stopped.
    if (halt.conflict === true && !alreadyForcing) {
      const self = cliCommand();
      const id = result.runId.slice(0, 8);
      out("");
      // "put it back as the run left it: synartesis undo --replan" read as
      // though the flag did the putting back. It does not: it rebuilds each
      // inverse from the current manifest, and the drift check then runs
      // again on a resource nobody has touched, so somebody who followed that
      // line got the same halt printing the same three options, including
      // the one they had just chosen. The restoring is the reader's half, as
      // --help has always said, and the label now says which half is theirs.
      //
      // Padded rather than spaced by hand: the gaps were counted out in the
      // source and the middle one came to two spaces where the others had
      // three, which is enough to stop a menu reading as a menu.
      const ways: readonly (readonly [string, string])[] = [
        ["keep the change, drop the undo:", style.quiet("nothing to do")],
        ["put the resource back, then:", style.strong(`${self} undo ${id} --replan`)],
        ["undo anyway, losing the change:", style.strong(`${self} undo ${id} --force`)],
      ];
      const column = Math.max(...ways.map(([label]) => label.length));
      for (const [label, command] of ways) {
        out(`  ${style.quiet(label.padEnd(column))}   ${command}`);
      }
    }
  }
  const permanent = result.steps.filter((step) => step.kind === "permanent");
  if (permanent.length > 0) {
    out("");
    out(
      `  ${style.quiet(`${String(permanent.length)} action${permanent.length === 1 ? "" : "s"} could not be undone and ${permanent.length === 1 ? "was" : "were"} left in place.`)}`,
    );
  }
  out("");
  const outcome = resultWords(result.status, result.dryRun);
  out(
    `  ${style.label("result")}  ${result.status === "rolled_back" ? outcome : style.accent(outcome)}`,
  );
  out("");
  // A dry run that says `rolled_back` is the one line in this output that can
  // be read as the thing having happened. It has not; the whole point of the
  // flag is that nothing was written, and the command that writes it is one
  // word shorter than the one just typed.
  if (result.dryRun && result.status === "rolled_back") {
    hint({
      why: "nothing was written; to do exactly this for real",
      run: `undo ${result.runId.slice(0, 8)}${as}`,
      needs: ["manifest", "journal"],
    });
  }
  // Not read off the status. `partial` is the right word for the run -- it was
  // not fully reversed -- but a floor makes every --to undo partial by
  // construction, so a command that did precisely what it was asked exited 1
  // and no script could tell it from one that halted on somebody's edit. The
  // question the exit code answers is whether anything stopped it, and that is
  // exactly these two.
  return result.halted === undefined && permanent.length === 0 ? 0 : 1;
}

/**
 * Starting every server the manifest names, undoing, and shutting them down
 * again. Shared, because the console does exactly this when somebody presses
 * u and there must not be two answers to what undo means.
 */
/**
 * Starting the servers, doing one thing with them, and shutting them down.
 *
 * `only` is the set of servers the work actually needs. One policy covers
 * every AI on the machine, so a manifest routinely names servers that have
 * nothing to do with the session in hand -- and starting all of them meant one
 * broken entry made every session unreadable and unundoable. A server that
 * will not start is now skipped and reported, the way install already treats
 * one; whether that matters is decided per action, by the code that goes
 * looking for it.
 *
 * Starting a subset is safe here because rollback and inspect address an
 * upstream by name and call the bare tool on it. Neither goes through the
 * qualifying that depends on how many servers are connected.
 */
async function withUpstreams<T>(
  manifestPath: string,
  use: (router: Router, manifest: Manifest) => Promise<T>,
  only?: ReadonlySet<string>,
  session?: { readonly journal: Journal; readonly runId: string },
): Promise<T> {
  const manifest = loadManifest(manifestPath);
  const wanted = Object.entries(manifest.servers).filter(([name]) => only === undefined || only.has(name));
  const { started, failed } = await startTogether(wanted, ([name, spec]) =>
    startAsTheClientWould(manifestPath, name, spec, session),
  );
  const upstreams: Upstream[] = [...started];
  const missing = failed.map(({ item: [name], error }) => `${name}: ${describe(error)}`);
  try {
    if (upstreams.length === 0 && missing.length > 0) {
      throw new ManifestError(`no server could be started. ${missing.join("; ")}`);
    }
    for (const why of missing) {
      process.stderr.write(`synartesis: ${why}; anything through it cannot be reached\n`);
    }
    return await use(createRouter(upstreams, manifest), manifest);
  } finally {
    for (const upstream of upstreams) {
      await upstream.close();
    }
  }
}

/**
 * Ctrl-C, answered between actions rather than in the middle of one.
 *
 * There was no signal handling here at all, so an interrupt during an undo
 * was node's default: the process dies wherever it happens to be. Do that
 * while an inverse is in flight and the row stays claimed with nobody able
 * to say whether the call landed -- the one state this tool has no way back
 * from, one keystroke away, on the command whose whole job is getting back.
 *
 * So the first Ctrl-C asks the rollback to stop at the next clean point and
 * says so, because a keypress that appears to do nothing is a keypress people
 * press again. The second is the operating system's, and by then the thing
 * being protected is whatever is still in the air, which nothing here can
 * protect anyway.
 */
function stopOnInterrupt(): AbortSignal {
  const stopping = new AbortController();
  let asked = false;
  for (const sign of ["SIGINT", "SIGTERM"] as const) {
    process.once(sign, () => {
      if (asked) {
        process.exit(130);
      }
      asked = true;
      stopping.abort();
      out("");
      out(`  ${style.quiet("stopping after this action; press again to stop now")}`);
    });
  }
  return stopping.signal;
}

/** The servers a session actually went to, which are the only ones it needs. */
function serversUsedBy(journal: Journal, runId: string): ReadonlySet<string> {
  return new Set(journal.getActions(runId).map((action) => action.server));
}

async function performUndo(
  manifestPath: string,
  journal: Journal,
  runId: string,
  options: {
    dryRun: boolean;
    toSeq?: number;
    replan?: boolean;
    force?: boolean;
  },
): Promise<RollbackReport> {
  return await withUpstreams(
    manifestPath,
    async (router, manifest) =>
      await rollback({
        journal,
        router,
        runId,
        ...(options.toSeq === undefined ? {} : { toSeq: options.toSeq }),
        ...(options.replan === true ? { replanWith: manifest } : {}),
        dryRun: options.dryRun,
        ...(options.force === true ? { force: true } : {}),
        interrupt: stopOnInterrupt(),
      }),
    // A replan re-resolves inverses from the current policy, which may name a
    // server this run never used; everything else needs only what it touched.
    options.replan === true ? undefined : serversUsedBy(journal, runId),
    { journal, runId },
  );
}

async function runUndo(argv: readonly string[], journal: Journal): Promise<number> {
  // Before anything is chosen or printed. This used to sit below the line that
  // says which session was picked, so `undo --to 0` announced "no session
  // named, so the most recent: a42bf93a" and only then refused -- which reads
  // as though something had been acted on.
  const rawTo = flag(argv, "--to");
  const toSeq = rawTo === undefined ? undefined : Number(rawTo);
  if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 1)) {
    // Without the command list, like its sibling below that refuses a --to
    // past the end of the run. The flag and the command are both spelled
    // correctly here; it is the value that is wrong, and the list is for a
    // mistyped flag or command. Answering the same mistake in two shapes,
    // one of them five lines of `install` and `watch`, is worse than either
    // shape consistently.
    throw new UsageError("--to needs a positive whole number", false);
  }

  // Defaults to the most recent run with something in it to undo: the thing
  // anyone wants to undo is almost always the last thing that happened -- but
  // not the last session opened. Clients open one every time they start,
  // whether or not anything is called, so the newest was usually empty and
  // still open, and bare `undo` refused over it (a 0.8.5 regression: the guard
  // below ran before anything asked whether there was anything to undo).
  // Counted from the same index-only tally the console uses to find "the
  // session that did something", so the command line and the screen agree
  // about which session is the last one. With nothing undoable anywhere it
  // falls back to the newest, and says so below.
  const given = positional(argv)[1];
  const runs = [...journal.listRuns()].reverse();
  const standing = journal.standingPerRun();
  const hasWork = (id: string): boolean => {
    const here = standing.get(id);
    return here !== undefined && (here.undoable > 0 || here.conflicted > 0);
  };
  const newestWithWork = given === undefined ? runs.find((run) => hasWork(run.id)) : undefined;
  const chosen = newestWithWork ?? pick(runs, given, RUN, true);
  const runId = chosen.id;

  // An agent may still be working in it. The newest session is, by
  // definition, the one a running proxy is writing into, so `undo` with no id
  // pointed straight at it -- and undoing underneath a live agent means its
  // next call lands on a resource this just put back, and a second copy of
  // every server it uses is spawned alongside the one it is already talking
  // to. Sometimes that is exactly what somebody wants, which is why this asks
  // rather than refuses; naming the session is not enough, because the whole
  // problem is that it does not look live from here.
  // Not on a dry run, which writes nothing: a preview is exactly what
  // somebody should be able to take of a session that is still going, and
  // refusing one would send them to --yes to look.
  // Only where there is something to undo: an empty session that is still
  // open carries no risk, and refusing over one is how this guard broke bare
  // `undo` for nearly everybody.
  if (
    journal.getRun(runId)?.status === "active" &&
    hasWork(runId) &&
    !argv.includes("--yes") &&
    !argv.includes("--dry-run")
  ) {
    throw new UsageError(
      `${runId.slice(0, 8)} has not ended, so an agent may still be writing to it.\n` +
        `  See what an undo would do:  ${cliCommand()} undo ${runId.slice(0, 8)} --dry-run\n` +
        `  If its proxy is gone:       ${cliCommand()} close ${runId.slice(0, 8)}\n` +
        `  Undo it anyway:             ${cliCommand()} undo ${runId.slice(0, 8)} --yes`,
      false,
    );
  }

  // Say which one, before touching it. Without an id this picks the newest
  // session, which is not necessarily the one on screen in another window --
  // somebody undid a session they were not looking at and read the result as
  // the tool acting on its own.
  if (given === undefined) {
    const actions = journal.getActions(runId);
    // Anything an undo would still act on, which is not the same as `applied`.
    // An action stopped by drift is `unrecoverable`, keeps its inverse, and is
    // exactly what --force and --replan exist for -- but counting only
    // `applied` read that as nothing to do, so the run said "it has already
    // been undone" about a change still sitting in the file, and refused the
    // very command its own halt had just recommended. `rolling_back` is a half
    // finished attempt, which is likewise something rather than nothing.
    const left = actions.filter(
      (action) =>
        action.status === "applied" ||
        action.status === "rolling_back" ||
        action.status === "unrecoverable",
    ).length;
    out("");
    out(
      `  ${style.quiet(
        newestWithWork === undefined
          ? "no session named, so the most recent:"
          : "no session named, so the most recent with something to undo:",
      )} ${style.strong(runId.slice(0, 8))} ` +
        style.quiet(`${chosen.label ?? "an agent"}, ${shortTime(chosen.startedAt).trim()}`),
    );
    if (left === 0) {
      // Every step would report "already rolled back" and the result would say
      // rolled_back, which reads as though something had just been undone.
      out("");
      out(
        `  ${style.quiet(
          actions.length === 0
            ? "Nothing was recorded in it, so there is nothing to undo."
            : "Nothing in it is still applied; it has already been undone.",
        )}`,
      );
      // A client that connects and calls nothing still opens a session, so the
      // newest one is regularly empty while the one somebody means is a line
      // below it. Naming that one is the whole answer to "why did nothing
      // happen", and it is a command they can run rather than a search.
      const other = [...journal.listRuns()]
        .reverse()
        .find(
          (run) =>
            run.id !== runId &&
            journal
              .getActions(run.id)
              .some(
                (action) =>
                  action.inverse !== undefined &&
                  (action.status === "applied" || action.status === "unrecoverable"),
              ),
        );
      if (other !== undefined) {
        out("");
        out(
          `  ${style.quiet("The session that did something:")} ${style.strong(other.id.slice(0, 8))} ` +
            style.quiet(`${other.label ?? "an agent"}, ${shortTime(other.startedAt).trim()}`),
        );
        out(`  ${style.quiet(`${cliCommand()} undo ${other.id.slice(0, 8)}`)}`);
      } else {
        out(
          `  ${style.quiet(`Name one to undo a different session: ${cliCommand()} undo <session>`)}`,
        );
      }
      out("");
      return 0;
    }
  }

  // Past the end, every action is below the floor, so nothing is planned and
  // the empty plan reads exactly like a run with nothing left to undo. A typed
  // digit too many looked like a result.
  if (toSeq !== undefined) {
    const highest = journal.getActions(runId).reduce((top, action) => Math.max(top, action.seq), 0);
    if (toSeq > highest) {
      // Without the command list: the bound in this sentence was read off the
      // run, so this is a fact about the journal in the same way "there is
      // nothing here to act on" is. Nothing about `install` or `watch`
      // answers it, and five lines of them under a one-line answer that
      // already says the sequence to type is five lines of nothing.
      throw new UsageError(
        `--to ${String(toSeq)} is past the end of this run, which goes up to ${String(highest)}`,
        false,
      );
    }
  }

  // --force writes over somebody's change, so it is asked for twice: the
  // first time shows the lines it would overwrite and stops, the second says
  // go ahead. Two flags rather than a prompt, because this has to work the
  // same in a terminal and in a script.
  const forcing = argv.includes("--force");
  const said = argv.includes("--yes");
  const manifestPath = findManifest(flag(argv, "--manifest"));

  if (said && !forcing) {
    // Silently doing nothing with a flag somebody typed is how they come to
    // believe it did something.
    process.stderr.write("synartesis: --yes only means anything with --force; ignoring it\n");
  }

  const dryRun = argv.includes("--dry-run");

  // A dry run writes nothing, so the two-step ask has nothing to protect: it
  // exists so that overwriting somebody's work takes a second, deliberate
  // command, and a preview overwrites nothing. Requiring --yes here meant the
  // one way to find out what forcing would do was to force it.
  const forcePlan = forcing && (said || dryRun);

  if (forcing && !said) {
    // Every conflict, not the first one. This was a dry-run rollback, which
    // halts -- so somebody could approve after seeing one diff and have three
    // resources written over. Reading them all without stopping is the one
    // job inspect has.
    const over = (
      await withUpstreams(
        manifestPath,
        async (router) => await inspect({ journal, router, runId }),
        serversUsedBy(journal, runId),
        { journal, runId },
      )
    ).resources.filter(
      // Below --to nothing is undone, so a change down there is not something
      // this command would write over and must not stand in its way.
      (one) => one.condition === "changed" && (toSeq === undefined || one.seq >= toSeq),
    );

    if (over.length > 0) {
      out("");
      out(
        `  ${style.accent(`${String(over.length)} changed since this ran`)}  ` +
          style.quiet(`undoing would write over ${over.length === 1 ? "it" : "them"}`),
      );
      for (const one of over) {
        out("");
        out(`  ${style.quiet(String(one.seq).padStart(3))}  ${style.strong(`${one.server}.${one.tool}`)}`);
        for (const line of (one.diff ?? "").split("\n")) {
          out(`       ${style.quiet(line)}`);
        }
      }
      out("");
      // On a dry run this is half the answer and the plan below is the other
      // half -- returning here gave somebody who asked what forcing would do
      // the list of what they would lose and no plan at all, which is the one
      // thing --dry-run exists to print. The command to do it for real is in
      // the footer either way.
      if (!dryRun) {
        out(`  ${style.quiet("nothing has been written. To go ahead and lose that:")}`);
        out(`  ${style.strong(`${cliCommand()} undo ${runId.slice(0, 8)} --force --yes`)}`);
        out("");
        return 1;
      }
    }
    // Nothing would be written over, so there is nothing to be asked about.
  }

  const replan = argv.includes("--replan");
  return report(
    await performUndo(manifestPath, journal, runId, {
      dryRun,
      ...(toSeq === undefined ? {} : { toSeq }),
      replan,
      ...(forcePlan ? { force: true } : {}),
    }),
    forcing,
    // --to is deliberately absent, and cannot reach here: a floor leaves
    // actions below it alone, which makes the result `partial`, and the hint
    // is only offered on `rolled_back`.
    // forcePlan, not `forcing && said`: on a dry run the command that does
    // this for real is the forced one, and offering it without --force would
    // hand back something that halts on the drift the preview just showed.
    `${replan ? " --replan" : ""}${forcePlan ? " --force --yes" : ""}`,
  );
}

/**
 * Every word this answers to. Checked before anything is opened, so that a
 * typo is reported as a typo: `lst` used to reach the switch at the bottom of
 * main, which sits after the journal is opened, and on a machine with no
 * journal yet the answer was a paragraph about journals.
 */
const KNOWN_COMMANDS = [
  "install", "uninstall", "status", "init", "check", "pin", "list", "show",
  "gates", "close", "prune", "proxy", "desktop", "watch", "approve", "deny", "allow", "resolve", "notify",
  "undo", "help", "version",
];

/**
 * Every flag any command takes. Checked as one set rather than per command:
 * the failure worth catching is a typo, and `list --to 3` being tolerated is a
 * far smaller problem than `undo --jounral other.db` silently reading the
 * default journal and reversing whatever happened to be in it.
 */
const FLAGS = new Set([
  // Two lists have to agree about a flag: this one decides whether it is
  // accepted at all, and the skip set in positional() decides whether its
  // value is mistaken for a command. --client was in one and not the other,
  // so `install --client codex` printed the help instead of installing.
  "--client",
  "--print",
  "--full",
  "--live",
  "--manifest",
  "--journal",
  "--to",
  "--by",
  "--all",
  "--once",
  "--json",
  "--dry-run",
  "--replan",
  "--reason",
  // resolve: which way the unknown outcome actually went.
  "--applied",
  "--failed",
  "--force",
  "--yes",
  "--older-than",
  // install: cover hosted servers too, through mcp-remote.
  "--remote",
  // notify: send one to see whether they reach you.
  "--test",
  // approve without a terminal, from a script; recorded as unattended.
  "--unattended",
  // allow: for a while, for good, or no longer; and the typed confirmation
  // for a tool that cannot be undone, given without a terminal.
  "--for",
  "--always",
  "--stop",
  "--confirm",
  "--help",
  "-h",
  "--version",
  "-V",
  "-v",
]);

/**
 * The version, which is the first thing anybody is asked for when they report
 * something. Read from the package rather than baked in, so it cannot drift
 * from what npm thinks was installed. From dist/cli.js that is one directory
 * up, which holds in a clone and in an install alike.
 */
function version(): string {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));
    const found =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof found === "string" ? found : "unknown";
  } catch {
    // Reporting "unknown" is still an answer. Refusing to start because a
    // version string could not be found would not be.
    return "unknown";
  }
}

/**
 * A word that is not a command.
 *
 * Said in two places, which is why it is a function: the check that runs before
 * anything is opened, and the switch at the bottom of main, which is now
 * unreachable for an unknown word and kept as the exhaustiveness arm.
 */
function unknownCommand(typed: string): string {
  const meant = didYouMean(typed, KNOWN_COMMANDS);
  return meant === undefined ? `unknown command ${typed}` : `unknown command ${typed}; did you mean ${meant}?`;
}

function rejectUnknownFlags(argv: readonly string[]): void {
  // Everything past a bare `--` belongs to the command init is starting, and
  // that command has flags of its own.
  const mine = ours(argv);
  for (let i = 0; i < mine.length; i += 1) {
    const token = mine[i] ?? "";
    // The value of a flag is not a flag. Scanning every token meant any value
    // that happened to begin with a dash was read as one: `approve --by
    // -alice` and `prune --older-than -5` were both refused as unknown flags,
    // the second of which has a perfectly good error message of its own
    // waiting a few lines further on.
    if (TAKES_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-" && !FLAGS.has(token)) {
      // A real flag on the wrong command, first: `--http` and `--token` are in
      // the help page, and answering one of them with "unknown flag" sends
      // somebody hunting through that page for a flag already in it.
      if ((PROXY_FLAGS as readonly string[]).includes(token)) {
        throw new UsageError(`${token} is a flag for ${cliCommand()} proxy, not for this`);
      }
      // Otherwise a typo, which is the overwhelmingly likely cause, and the
      // one thing that helps is the word that was meant -- not the list of
      // every flag the program has, which is where the typo came from.
      const meant = didYouMean(token, [...FLAGS]);
      throw new UsageError(
        meant === undefined ? `unknown flag ${token}` : `unknown flag ${token}; did you mean ${meant}?`,
      );
    }
  }
}

/**
 * The same open, with the one thing the error was missing: where a journal
 * comes from. "There is no journal at <path>" is true and leads nowhere.
 */
function openJournalOrExplain(journalPath: string): Journal {
  if (!existsSync(journalPath)) {
    throw new UsageError(
      `nothing has been recorded yet: there is no journal at ${journalPath}. ` +
        `One appears the first time an agent calls a tool through synartesis proxy.`,
    );
  }
  return openJournal(journalPath, { mustExist: true });
}

async function main(argv: readonly string[]): Promise<number> {
  const command = positional(argv)[0];
  if (command === "proxy") {
    // The proxy, run through this command rather than its own binary, so the
    // line people paste into a client config is one package and one word:
    // npx -y synartesis proxy --manifest ... . Loaded only here, and before
    // anything else in this file runs, because from this point stdout carries
    // protocol frames and a banner on it would corrupt the stream.
    await import("./proxy/stdio.js");
    return 0;
  }
  // `help` and `version` as bare words too. They are what a person types
  // before they have read anything, and answering `synartesis version` with
  // "unknown command" while `--version` works is a riddle, not an answer.
  const first = positional(argv)[0];
  if (argv.includes("--help") || argv.includes("-h") || first === "help") {
    process.stdout.write(`${banner()}\n${COMMANDS}`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-V") || argv.includes("-v") || first === "version") {
    // Bare, with no styling around it: this is read by people filing issues
    // and by scripts, and both want the string and nothing else.
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  rejectUnknownFlags(argv);
  // Before a journal is looked for, let alone opened. Reaching the switch at
  // the bottom of main means going through openJournalOrExplain first, so on a
  // machine that has never run a proxy `synartesis lst` answered "nothing has
  // been recorded yet: there is no journal at ..." -- true, unrelated, and it
  // sends somebody off to debug a journal instead of reading their own typo.
  if (command !== undefined && !KNOWN_COMMANDS.includes(command)) {
    throw new UsageError(unknownCommand(command));
  }
  // Both paths, repeated back only when they were not the obvious ones, so a
  // copied command works from anywhere without being cluttered when it need
  // not be. Set here rather than beside the journal open below, because the
  // commands that never open one -- check, status -- print hints too.
  const givenJournal = flag(argv, "--journal");
  const givenManifest = flag(argv, "--manifest");
  journalArg = givenJournal === undefined ? "" : ` --journal ${resolve(givenJournal)}`;
  manifestArg = givenManifest === undefined ? "" : ` --manifest ${resolve(givenManifest)}`;
  // Nothing typed opens the screen. Being handed a page of eight commands is a
  // fine answer for a script and a poor one for a person, who wants to see
  // what happened rather than be told the names of the words for asking.
  if (command === undefined) {
    const manifestPath = findManifest(flag(argv, "--manifest"));
    const journalPath = findJournal(flag(argv, "--journal"), manifestPath);
    return await openConsole({
      journalPath,
      scan: () => scan(openIfPresent(journalPath), process.cwd()),
      connect: async (targets) => await connectThese(targets, manifestPath),
      write: (text) => process.stdout.write(text),
      live: process.stdout.isTTY,
      decideAs: flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown",
      check: async (runId) => {
        const journal = openJournal(journalPath, { mustExist: true });
        try {
          return await withUpstreams(
            manifestPath,
            async (router) => await inspect({ journal, router, runId }),
            serversUsedBy(journal, runId),
            { journal, runId },
          );
        } finally {
          journal.close();
        }
      },
      undo: async (runId, dryRun, force) => {
        const journal = openJournal(journalPath, { mustExist: true });
        try {
          return await performUndo(manifestPath, journal, runId, {
            dryRun,
            ...(force === true ? { force: true } : {}),
          });
        } finally {
          journal.close();
        }
      },
    });
  }

  // None of these needs an existing journal, and none should create one.
  if (command === "init") {
    return await runInit(argv);
  }
  if (command === "check") {
    return await runCheck(argv);
  }
  if (command === "pin") {
    return await runPin(argv);
  }
  if (command === "install") {
    return await runInstall(argv);
  }
  if (command === "uninstall") {
    return await runUninstall(argv);
  }
  if (command === "status") {
    return runStatus(argv);
  }

  const asJson = argv.includes("--json");
  const given = flag(argv, "--journal");
  const journalPath = findJournal(given, findManifest(flag(argv, "--manifest")));

  // Watching is the one thing you do before anything has happened, so it opens
  // its own handle when there is one and waits when there is not.
  if (command === "watch") {
    const live = process.stdout.isTTY && !argv.includes("--once");
    return await watch({
      journalPath,
      approveWith: cliCommand(),
      write: (text) => process.stdout.write(text),
      live,
      // A decision has to be attributable, so the view can only make one when
      // it knows whose it is.
      decideAs: flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown",
    });
  }

  // Reading commands, before anything has been recorded. Being early is not an
  // error, and the screen has always said so; these aborted with "there is no
  // journal at <path>" instead. Answered without opening anything, so looking
  // does not leave a journal behind either.
  if (!existsSync(journalPath) && (command === "list" || command === "show" || command === "gates")) {
    if (asJson) {
      out(JSON.stringify(command === "show" ? { run: null, actions: [] } : []));
      return 0;
    }
    out("");
    out(`  ${style.quiet("nothing has been recorded yet")}`);
    out("");
    for (const line of NOTHING_RECORDED_YET) {
      out(`  ${style.quiet(line)}`);
    }
    out("");
    return 0;
  }

  if (command === "notify") {
    return runNotifyTest(argv);
  }

  if (command === "allow") {
    return await runAllow(argv, journalPath);
  }

  if (command === "desktop") {
    return runDesktop();
  }

  // Every remaining command reads an existing journal. Only the proxy makes one.
  const journal = openJournalOrExplain(journalPath);
  try {
    switch (command) {
      case "list":
        return runList(journal, asJson, journalPath);
      case "show":
        return await runShow(argv, journal, asJson);
      case "close":
        return runClose(argv, journal);
      case "prune":
        return runPrune(argv, journal, journalPath);
      case "gates":
        return runGates(journal, asJson);
      case "resolve":
        return runResolve(argv, journal);
      case "approve":
        return runDecision(argv, journal, true);
      case "deny":
        return runDecision(argv, journal, false);
      case "undo":
        return await runUndo(argv, journal);
      default:
        throw new UsageError(unknownCommand(command));
    }
  } finally {
    journal.close();
  }
}

/**
 * Sends one notification, so a person can see whether they will hear about a
 * held call at all. Recent macOS can switch notifications from osascript off
 * without saying so, and a feature that silently does nothing is worse than
 * one that plainly is not there -- it gets relied on.
 */
function runNotifyTest(argv: readonly string[]): number {
  if (!argv.includes("--test")) {
    throw new UsageError("notify takes --test, which sends one to see whether they reach you");
  }
  const why = canNotify();
  if (why !== undefined) {
    out(`  ${style.quiet(`No notification sent: ${why}.`)}`);
    return 1;
  }
  desktopNotifier()({
    server: "synartesis",
    tool: "test",
    actionId: "00000000",
    approve: "this is only a test",
  });
  out("");
  out(`  ${style.quiet("Sent one. If nothing appeared, notifications for it are switched off:")}`);
  out(
    `  ${style.quiet(
      platform() === "darwin"
        ? "macOS lists the ones osascript sends under Script Editor, in System Settings > Notifications."
        : "check that a notification daemon is running and notify-send is installed.",
    )}`,
  );
  out(`  ${style.quiet("Either way, synartesis watch shows every held call as it happens.")}`);
  out("");
  return 0;
}

/**
 * Open the window.
 *
 * Detached and with its streams let go, so closing this terminal does not
 * close the application -- which is what somebody typing this expects, and
 * the opposite of what a child process does by default.
 */
function runDesktop(): number {
  const found = findDesktop();
  if (found === undefined) {
    process.stderr.write(`${whereToGetIt()}\n`);
    return 2;
  }
  const child = spawn(found.open.command, [...found.open.args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  out(`opening ${found.path}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  if (error instanceof UsageError) {
    // The everyday five, not the full page. `--help` is where somebody asks
    // for all of it; answering a three-letter typo with forty lines buries
    // the one line saying what went wrong, and thirty-nine of those lines are
    // about something they were not doing.
    process.stderr.write(
      error.listCommands ? `synartesis: ${error.message}\n${shortList()}` : `synartesis: ${error.message}\n`,
    );
    process.exitCode = 2;
  } else if (error instanceof ManifestError) {
    process.stderr.write(`synartesis: ${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof SynartesisError) {
    // Without the code. It read as synartesis: JOURNAL_ERROR: journal open
    // failed: ... -- three prefixes before the sentence that says what is
    // wrong. The exit code is the part a script reads.
    process.stderr.write(`synartesis: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`synartesis: ${describe(error)}\n`);
    process.exitCode = 1;
  }
}
