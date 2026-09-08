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

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ManifestError, SynartesisError, describe } from "./errors.js";
import { draftManifest } from "./init/draft.js";
import { loadManifest, parseManifest } from "./manifest/load.js";
import type { Manifest } from "./manifest/types.js";
import { labelFor, openJournal, wasRefused, type ActionClass, type ActionRow, type Journal } from "./journal/journal.js";
import { verifyAgainstServers } from "./manifest/verify.js";
import { createRouter, type Router } from "./proxy/routing.js";
import { connectStdioUpstream, type Upstream } from "./proxy/upstream.js";
import { rollback, type RollbackReport } from "./rollback/rollback.js";
import { inspect, verdict, type Resource } from "./rollback/inspect.js";
import { banner, NOTHING_RECORDED_YET, rule, style } from "./style.js";
import { findJournal, findManifest } from "./locate.js";
import { watch } from "./watch.js";
import { openConsole } from "./console.js";
import { cliCommand, proxyCommand } from "./invocation.js";
import { ago, fullTime, shortTime } from "./clock.js";
import { summariseArgs } from "./describe.js";
import { discover, type ConfigSite } from "./install/clients.js";
import { needsConnecting, scan, stateOf } from "./install/connections.js";
import { applyInstall, applyUninstall, invokerFor, planInstall } from "./install/install.js";

const COMMANDS = `
  synartesis                                      start here. Live activity,
                                                  what is waiting for you, and
                                                  undo -- all in one place, with
                                                  the arrow keys. Everything
                                                  below can be done from it.
  synartesis install [--client <name>] [--dry-run] [--print]
  synartesis uninstall [--client <name>]
  synartesis status
  synartesis init <server> -- <command> [args...]  [--manifest <path>]
  synartesis check [--manifest <path>]
  synartesis list [--journal <path>]
  synartesis show <runId> [--full] [--live] [--journal <path>]
  synartesis gates [--journal <path>]
  synartesis close [runId] [--journal <path>]
  synartesis prune [--older-than <days>] [--dry-run] [--journal <path>]
  synartesis proxy --manifest <path> [--server <name>]    what your agent runs
                  [--journal <path>]
                  [--http <port> --token <secret>]      for a client that
                                                        cannot start one
  synartesis watch [--by <name>] [--journal <path>]
  synartesis approve [actionId|--all] [--by <name>] [--journal <path>]
  synartesis deny [actionId|--all] [--by <name>] [--reason <text>] [--journal <path>]
  synartesis undo [runId] [--to <seq>] [--dry-run] [--replan] [--force [--yes]]
                          [--manifest <path>] [--journal <path>]

install is the short way in: it finds what Claude Code, Claude Desktop,
Cursor or Codex already list, writes a policy covering all of it -- using the ones that
ship where they fit -- and points each entry at the proxy. The original config
is copied aside first, and uninstall puts it back. status says what is covered.

close ends a run left active by a proxy that was killed; nothing guesses at
that, since several proxies can share one journal.

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

  --client    claude-code, claude-desktop, cursor or codex; all by default
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

Exit codes: 0 complete, 1 halted or partial, 2 bad usage or configuration.
`;

class UsageError extends Error {}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) {
    return undefined;
  }
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

function positional(argv: readonly string[]): string[] {
  const skip = new Set(["--manifest", "--journal", "--to", "--by", "--reason", "--gate-timeout", "--older-than", "--client"]);
  const values: string[] = [];
  // Everything after `--` belongs to the wrapped command, not to us.
  const end = argv.indexOf("--");
  const ours = end === -1 ? argv : argv.slice(0, end);
  for (let i = 0; i < ours.length; i += 1) {
    const token = ours[i] ?? "";
    if (skip.has(token)) {
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
 * Loads a manifest and checks it against the servers it names, without
 * touching a journal or serving anything. This is what you run before wiring
 * a policy into a client, rather than finding out from a client that will not
 * start.
 */
async function runCheck(argv: readonly string[]): Promise<number> {
  const path = findManifest(flag(argv, "--manifest"));
  const manifest = loadManifest(path);

  const upstreams: Upstream[] = [];
  try {
    for (const [name, spec] of Object.entries(manifest.servers)) {
      upstreams.push(
        await connectStdioUpstream({
          name,
          command: spec.command,
          args: spec.args,
          stderr: "capture",
          ...(spec.env === undefined ? {} : { env: spec.env }),
        }),
      );
    }
    await verifyAgainstServers(upstreams, manifest);
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
  out(`  ${style.quiet("policies")} ${[...counts].map(([k, v]) => `${String(v)} ${k}`).join(", ")}`);
  out(`  ${style.quiet("guarded ")} ${style.accent(String(gated))}`);
  out("");
  out(`  ${style.quiet("Anything not mentioned here is treated as irreversible and guarded.")}`);
  out("");
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
  const only = flag(argv, "--client");
  const dryRun = argv.includes("--dry-run");
  const printOnly = argv.includes("--print");

  const sites = discover(process.cwd()).filter(
    (site) => only === undefined || site.client === only,
  );
  if (sites.length === 0) {
    out("");
    out(`  ${style.quiet("No MCP client config was found on this machine.")}`);
    out(`  ${style.quiet("Looked for Claude Code, Claude Desktop, Cursor and Codex.")}`);
    out("");
    return 0;
  }

  const invoker = invokerFor(version(), fileURLToPath(import.meta.url));
  const { plans, yaml } = await planInstall(sites, manifestPath, invoker);
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
        server.adopted === undefined
          ? style.accent("drafted, every tool held until you say how to undo it")
          : style.quiet(`the policy that ships for ${server.adopted} (${String(server.tools ?? 0)} tools)`);
      out(`    ${style.strong(server.name.padEnd(18))} ${note}`);
    }
    for (const skip of plan.skipped) {
      out(`    ${style.quiet(skip.name.padEnd(18))} ${style.quiet(skip.why)}`);
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
  const only = flag(argv, "--client");
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

  const { plans, yaml } = await planInstall([...sites.values()], manifestPath, invoker);
  // Only what was asked for. A scan may have found five uncovered servers and
  // the reader may have chosen one.
  const narrowed = plans.map((plan) => ({
    ...plan,
    servers: plan.servers.filter((server) =>
      wanted.get(`${plan.site.path}${plan.site.scope}`)?.has(server.name) === true,
    ),
  }));
  const applied = applyInstall(narrowed, manifestPath, yaml);
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
      out(`  ${style.quiet("Looked for Claude Code, Claude Desktop, Cursor and Codex.")}`);
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
      throw new UsageError(`there is no ${noun.one} to act on`);
    }
    if (rest.length > 0 && !newest) {
      throw new UsageError(
        `there are ${String(candidates.length)} ${noun.many}; name one, or use --all:\n${listed(candidates)}`,
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
    throw new UsageError(`no ${noun.one} was named; an empty id is usually an unset variable`);
  }

  const exact = candidates.find((item) => item.id === given);
  if (exact !== undefined) {
    return exact;
  }
  const matches = candidates.filter((item) => item.id.startsWith(given));
  const [first, ...rest] = matches;
  if (first === undefined) {
    throw new UsageError(`no ${noun.one} matches ${given}`);
  }
  if (rest.length > 0) {
    throw new UsageError(
      `${given} matches ${String(matches.length)} ${noun.many}:\n${listed(matches)}`,
    );
  }
  return first;
}

const RUN: Noun = { one: "run", many: "runs" };
const WAITING: Noun = { one: "action awaiting approval", many: "actions awaiting approval" };

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

function runList(journal: Journal, asJson: boolean, journalPath: string): number {
  // Most recent first: the run someone wants to undo is nearly always the last
  // thing that happened.
  const runs = [...journal.listRuns()].reverse();
  if (asJson) {
    out(JSON.stringify(runs.map((run) => ({ ...run, actions: journal.getActions(run.id).length }))));
    return 0;
  }
  if (runs.length === 0) {
    out("no runs recorded");
    return 0;
  }
  out("");
  out(`  ${style.label("sessions")}  ${style.quiet("most recent first")}`);
  out(`  ${rule(96)}`);
  out("");
  out(
    style.quiet(
      `  ${"session".padEnd(36)}  ${"started".padEnd(15)}  ${"status".padEnd(12)}  actions  agent`,
    ),
  );
  for (const run of runs) {
    const actions = journal.getActions(run.id);
    const unknown = actions.filter((action) => action.status === "pending").length;
    const waiting = actions.filter((action) => action.status === "gated").length;
    const notes = [
      unknown === 0 ? "" : `${String(unknown)} of unknown outcome`,
      waiting === 0 ? "" : `${String(waiting)} awaiting approval`,
    ].filter((note) => note !== "");
    const note =
      notes.length === 0 ? "" : `  ${style.accent(`(${notes.join("; ")})`)}`;
    out(
      `  ${style.strong(run.id)}  ${style.quiet(shortTime(run.startedAt).trimEnd().padEnd(13))}  ${run.status.padEnd(12)}  ` +
        `${String(actions.length).padStart(7)}  ${run.label ?? "-"}${note}`,
    );
  }
  out("");
  // Only once it is big enough to be worth a sentence. Keeping what was in
  // every file an agent wrote adds up quietly, and finding out from df is
  // finding out too late.
  if ((bytesOf(journalPath) ?? 0) > PRUNE_NAG_BYTES) {
    out(`  ${style.quiet(`This journal is ${sizeOf(journalPath)}; synartesis prune reclaims what is old enough to lose.`)}`);
    out("");
  }
  return 0;
}

async function runShow(argv: readonly string[], journal: Journal, asJson: boolean): Promise<number> {
  const full = argv.includes("--full");
  const runs = [...journal.listRuns()].reverse();
  const run = pick(runs, positional(argv)[1], RUN, true);
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
        )
      : undefined;

  if (asJson) {
    out(
      JSON.stringify({
        run,
        actions: journal.getActions(runId),
        ...(inspection === undefined ? {} : { live: inspection.resources }),
      }),
    );
    return 0;
  }

  out("");
  out(`  ${style.label("session")}  ${style.strong(run.label ?? "an agent")}  ${style.quiet(run.id)}`);
  out(`  ${rule(54)}`);
  out("");
  out(`  ${style.quiet("agent  ")} ${run.label ?? "-"}`);
  out(`  ${style.quiet("started")} ${fullTime(run.startedAt)}  ${style.quiet(ago(run.startedAt))}`);
  out(
    `  ${style.quiet("status ")} ${run.status}` +
      (run.endedAt === undefined ? "" : style.quiet(`  ended ${fullTime(run.endedAt)}`)),
  );

  const actions = journal.getActions(runId);
  if (actions.length === 0) {
    out("");
    out("no actions recorded");
    return 0;
  }

  out("");
  out("");
  out(`  ${style.label("timeline")}`);
  out(`  ${rule(72)}`);
  out("");
  const live = new Map((inspection?.resources ?? []).map((found) => [found.seq, found]));
  for (const action of actions) {
    const now = live.get(action.seq);
    out(
      `  ${style.quiet(String(action.seq).padStart(3))}  ${badgeOf(action)} ` +
        `${statusOf(action)}  ${style.strong(`${action.server}.${action.tool}`)}` +
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
      const verb = action.status === "denied" ? "denied" : "approved";
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
        out(`       ${style.quiet("undo:")} ${style.quiet(summariseArgs(inverseArgs(action.inverse), 90))}`);
      }
    }
  }

  out("");
  out(`  ${summarise(actions)}`);
  if (inspection !== undefined) {
    out("");
    const spoiled = inspection.resources.some((found) => found.condition === "changed");
    out(`  ${spoiled ? style.accent(verdict(inspection)) : style.quiet(verdict(inspection))}`);
    if (spoiled) {
      out(
        `  ${style.quiet("undo stops at the first of them; ")}${style.strong(`${cliCommand()} undo ${runId.slice(0, 8)} --force`)}${style.quiet(" shows what it would write")}`,
      );
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

/** Padded before it is coloured: escape codes are not printable width. */
function badgeOf(action: ActionRow): string {
  const plain = `${CLASS_MARK[action.class]} ${action.class}`.padEnd(BADGE_WIDTH);
  return action.class === "irreversible" ? style.accent(plain) : style.quiet(plain);
}

function statusOf(action: ActionRow): string {
  const text = labelFor(action).padEnd(13);
  if (wasRefused(action)) {
    return style.accent(text);
  }
  if (action.status === "gated") {
    return style.strong(text);
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
    counts.set(action.status, (counts.get(action.status) ?? 0) + 1);
  }
  const parts = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${String(v)} ${k}`);
  const undoable = actions.filter((a) => a.inverse !== undefined).length;
  return `${String(actions.length)} actions: ${parts.join(", ")} | ${String(undoable)} with a recorded undo`;
}

/**
 * Repeated back in any command this prints, because whoever copies the line may
 * well be in a different directory than the one it was printed from.
 */
let journalArg = "";

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
        `${style.quiet(run.status.padEnd(11))} ${style.quiet(`${String(run.actions)} actions`)}`,
    );
  }
  out("");

  if (planned) {
    out(
      `  ${style.accent(`${String(stale.length)} runs`)} ${style.quiet(`and ${String(actions)} actions would go. Nothing was changed.`)}`,
    );
    out("");
    return 0;
  }

  const removed = journal.deleteRuns(stale.map((run) => run.id));
  // After the delete and outside its transaction, which is the only place
  // VACUUM can run -- and without it the file stays exactly as big as it was.
  journal.vacuum();

  out(
    `  ${style.accent(`${String(removed.runs)} runs`)} ${style.quiet(`and ${String(removed.actions)} actions removed.`)}`,
  );
  out(`  ${style.quiet(`Journal ${sizeBefore} \u2192 ${sizeOf(journalPath)}.`)}`);
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
  const run =
    given === undefined
      ? pick(
          [...all.filter((candidate) => candidate.status === "active")].reverse(),
          undefined,
          RUN,
          true,
        )
      : pick([...all].reverse(), given, RUN, true);
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
  const waiting = journal.listGated();
  const given = positional(argv)[1];
  // "unknown" is a poor thing to find in an audit trail when the machine knows
  // perfectly well who is logged in. --by still wins, for approving on behalf
  // of someone else.
  const by =
    flag(argv, "--by") ?? process.env["USER"] ?? process.env["LOGNAME"] ?? "unknown";
  const reason = flag(argv, "--reason") ?? "denied by operator";

  // Looked up among everything first, so an action that has already been
  // settled gets told what became of it rather than "no such action".
  if (given !== undefined) {
    const settled = journal.getAction(given);
    if (settled !== undefined && settled.status !== "gated") {
      process.stderr.write(
        `synartesis: ${given} is no longer awaiting approval (it is ${settled.status})\n`,
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
  for (const action of targets) {
    const changed = approving
      ? journal.approve(action.id, by)
      : journal.deny(action.id, by, reason);
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
    out(
      `  ${style.accent(approving ? "approved" : "denied")} ${style.strong(`${action.server}.${action.tool}`)} ${style.quiet(action.id)}`,
    );
  }
  return failed === 0 ? 0 : 1;
}

/**
 * `alreadyForcing` suppresses the menu of ways on: somebody who typed --force
 * has chosen one already, and offering it back to them is noise.
 */
function report(result: RollbackReport, alreadyForcing = false): number {
  out("");
  out(`  ${style.label(result.dryRun ? "dry run" : "undo")}  ${style.strong(result.runId)}`);
  out(`  ${rule(72)}`);
  out("");
  let separated = false;
  for (const step of result.steps) {
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
    const kind =
      step.kind === "halt" || step.kind === "permanent"
        ? style.accent(step.kind.padEnd(16))
        : step.kind.padEnd(16);
    out(
      `  ${style.quiet(String(step.seq).padStart(3))}  ${kind} ` +
        `${style.strong(`${step.server}.${step.tool}`)}  ${style.quiet(step.reason)}${unverified}`,
    );
    if (step.plan !== undefined && step.kind === "revert") {
      const verb = `${step.replanned === true ? "replanned, " : ""}${result.dryRun ? "would call" : "called"}`;
      out(
        `       ${style.quiet(verb)} ${step.plan.server}.${step.plan.tool} ` +
          style.quiet(truncate(JSON.stringify(step.plan.args), 120)),
      );
    }
  }
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
      out(`  ${style.quiet("keep the change, drop the undo:")}   ${style.quiet("nothing to do")}`);
      out(
        `  ${style.quiet("put it back as the run left it:")}  ${style.strong(`${self} undo ${id} --replan`)}`,
      );
      out(
        `  ${style.quiet("undo anyway, losing the change:")}   ${style.strong(`${self} undo ${id} --force`)}`,
      );
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
  out(
    `  ${style.label("result")}  ${result.status === "rolled_back" ? result.status : style.accent(result.status)}`,
  );
  out("");
  return result.status === "rolled_back" ? 0 : 1;
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
): Promise<T> {
  const manifest = loadManifest(manifestPath);
  const upstreams: Upstream[] = [];
  const missing: string[] = [];
  try {
    for (const [name, spec] of Object.entries(manifest.servers)) {
      if (only !== undefined && !only.has(name)) {
        continue;
      }
      try {
        upstreams.push(
          await connectStdioUpstream({
            name,
            command: spec.command,
            args: spec.args,
            stderr: "capture",
            ...(spec.env === undefined ? {} : { env: spec.env }),
          }),
        );
      } catch (error: unknown) {
        missing.push(`${name}: ${describe(error)}`);
      }
    }
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
      }),
    // A replan re-resolves inverses from the current policy, which may name a
    // server this run never used; everything else needs only what it touched.
    options.replan === true ? undefined : serversUsedBy(journal, runId),
  );
}

async function runUndo(argv: readonly string[], journal: Journal): Promise<number> {
  // Defaults to the most recent run: the thing anyone wants to undo is
  // almost always the last thing that happened.
  const given = positional(argv)[1];
  const chosen = pick([...journal.listRuns()].reverse(), given, RUN, true);
  const runId = chosen.id;

  // Say which one, before touching it. Without an id this picks the newest
  // session, which is not necessarily the one on screen in another window --
  // somebody undid a session they were not looking at and read the result as
  // the tool acting on its own.
  if (given === undefined) {
    const actions = journal.getActions(runId);
    const left = actions.filter((action) => action.status === "applied").length;
    out("");
    out(
      `  ${style.quiet("no session named, so the most recent:")} ${style.strong(runId.slice(0, 8))} ` +
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
            journal.getActions(run.id).some((action) => action.status === "applied" && action.inverse !== undefined),
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

  const rawTo = flag(argv, "--to");
  const toSeq = rawTo === undefined ? undefined : Number(rawTo);
  if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 1)) {
    throw new UsageError("--to needs a positive whole number");
  }
  // Past the end, every action is below the floor, so nothing is planned and
  // the empty plan reads exactly like a run with nothing left to undo. A typed
  // digit too many looked like a result.
  if (toSeq !== undefined) {
    const highest = journal.getActions(runId).reduce((top, action) => Math.max(top, action.seq), 0);
    if (toSeq > highest) {
      throw new UsageError(
        `--to ${String(toSeq)} is past the end of this run, which goes up to ${String(highest)}`,
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
      out(`  ${style.quiet("nothing has been written. To go ahead and lose that:")}`);
      out(`  ${style.strong(`${cliCommand()} undo ${runId.slice(0, 8)} --force --yes`)}`);
      out("");
      return 1;
    }
    // Nothing would be written over, so there is nothing to be asked about.
  }

  return report(
    await performUndo(manifestPath, journal, runId, {
      dryRun: argv.includes("--dry-run"),
      ...(toSeq === undefined ? {} : { toSeq }),
      replan: argv.includes("--replan"),
      ...(forcing && said ? { force: true } : {}),
    }),
    forcing,
  );
}

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
  "--force",
  "--yes",
  "--older-than",
  "--help",
  "-h",
  "--version",
  "-V",
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

function rejectUnknownFlags(argv: readonly string[]): void {
  for (const token of argv) {
    // Everything past a bare `--` belongs to the command init is starting, and
    // that command has flags of its own.
    if (token === "--") {
      return;
    }
    if (token.startsWith("-") && token !== "-" && !FLAGS.has(token)) {
      throw new UsageError(`unknown flag ${token}`);
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
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${banner()}\n${COMMANDS}`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    // Bare, with no styling around it: this is read by people filing issues
    // and by scripts, and both want the string and nothing else.
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  rejectUnknownFlags(argv);
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

  // Repeated back only when it was not the obvious one, so a copied command
  // works from anywhere without being cluttered when it need not be.
  journalArg = given === undefined ? "" : ` --journal ${resolve(given)}`;
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
      case "approve":
        return runDecision(argv, journal, true);
      case "deny":
        return runDecision(argv, journal, false);
      case "undo":
        return await runUndo(argv, journal);
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } finally {
    journal.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error: unknown) {
  if (error instanceof UsageError) {
    process.stderr.write(`synartesis: ${error.message}\n\n${COMMANDS}`);
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
