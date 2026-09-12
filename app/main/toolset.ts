import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

import { ago, fullTime } from "../../src/clock.js";
import type { Journal } from "../../src/journal/journal.js";
import type { Router } from "../../src/proxy/routing.js";
import type { ToolPolicy } from "../../src/manifest/types.js";
import type { Upstream } from "../../src/proxy/upstream.js";
import { inspect, tally, verdict } from "../../src/rollback/inspect.js";
import { rollback } from "../../src/rollback/rollback.js";

/**
 * Synartesis, offered to the model as tools.
 *
 * So "what did you just change?" and "put that back" are things a person says
 * rather than commands they look up. The model reaches the same machinery a
 * person reaches -- inspect(), rollback() -- and gets the same answers.
 *
 * This server is wired in as an upstream like any other, which is the point:
 * the proxy classifies its tools from the policy, journals the calls, and
 * gates the one that changes the world. The rule the product applies to every
 * other server is applied to the product.
 *
 * `--force` is not here and will not be. Overwriting somebody's edit is a
 * decision made by a person looking at the diff, and a model that can reach
 * for it has been handed the one thing this whole tool exists to prevent.
 */

const SESSION = z.string().describe("Session id, or an unambiguous prefix of one.");

export interface ToolsetOptions {
  readonly journal: Journal;
  /** Resolved lazily: the router does not exist until every upstream is up. */
  readonly router: () => Router;
  readonly manifestPath: string;
  /** The session this conversation is writing to, so the model can ask about it. */
  readonly currentRun: () => string | undefined;
}

function say(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

/** One unambiguous session, or a message saying why not. */
function resolve(journal: Journal, given: string): { id: string } | { problem: string } {
  const runs = [...journal.listRuns()].reverse();
  const matches = runs.filter((run) => run.id.startsWith(given));
  if (matches.length === 1 && matches[0] !== undefined) {
    return { id: matches[0].id };
  }
  if (matches.length === 0) {
    return { problem: `No session starts with ${given}. Use list_sessions to see them.` };
  }
  return {
    problem: `${String(matches.length)} sessions start with ${given}. Use more of the id.`,
  };
}

export function createToolset(options: ToolsetOptions): McpServer {
  const { journal } = options;
  const server = new McpServer(
    { name: "synartesis", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_sessions",
    {
      description:
        "Every session an agent has worked in, newest first, with how many actions each holds. " +
        "Use this to find the session id for the other tools.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    ({ limit }) => {
      const runs = [...journal.listRuns()].reverse().slice(0, limit ?? 10);
      if (runs.length === 0) {
        return say("No agent has done anything through this journal yet.");
      }
      const current = options.currentRun();
      return say(
        runs
          .map((run) => {
            const actions = journal.getActions(run.id).length;
            const here = run.id === current ? "  (this conversation)" : "";
            return `${run.id.slice(0, 8)}  ${run.label ?? "an agent"}  ${fullTime(run.startedAt)}  ${ago(run.startedAt)}  ${run.status}  ${String(actions)} actions${here}`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "show_session",
    {
      description:
        "What happened in one session: every action, what it acted on, and whether an undo " +
        "was recorded for it. Reads the journal only; tells you nothing about the world now.",
      inputSchema: { session: SESSION },
    },
    ({ session }) => {
      const found = resolve(journal, session);
      if ("problem" in found) {
        return say(found.problem);
      }
      const actions = journal.getActions(found.id);
      if (actions.length === 0) {
        return say("Nothing was recorded in that session.");
      }
      return say(
        actions
          .map((action) => {
            const undo = action.inverse === undefined ? "no undo recorded" : "undo recorded";
            return `${String(action.seq)}  ${action.server}.${action.tool}  ${action.class}  ${action.status}  ${undo}`;
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "what_changed",
    {
      description:
        "Read every resource a session touched as it is NOW, and say which still match what " +
        "the session left. This is how you find out whether somebody has edited something " +
        "since. Writes nothing and sends no undo. Costs a real read per resource.",
      inputSchema: { session: SESSION },
    },
    async ({ session }) => {
      const found = resolve(journal, session);
      if ("problem" in found) {
        return say(found.problem);
      }
      const seen = await inspect({ journal, router: options.router(), runId: found.id });
      const counts = tally(seen);
      const lines = seen.resources
        .filter((one) => one.condition !== "superseded")
        .map((one) => {
          const note = one.note === undefined ? "" : ` -- ${one.note}`;
          return `${String(one.seq)}  ${one.server}.${one.tool}  ${one.condition}${note}`;
        });
      return say(
        [
          verdict(seen),
          "",
          ...lines,
          "",
          `unchanged ${String(counts.unchanged)} · changed ${String(counts.changed)} · ` +
            `restored ${String(counts.restored)} · unknown ${String(counts.unknowable)}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "preview_undo",
    {
      description:
        "Plan the undo of a session without doing any of it: which actions would be reversed, " +
        "which cannot be, and where it would stop. Nothing is written and no undo is sent. " +
        "Use this before undo_session so you can tell the person what will happen.",
      inputSchema: { session: SESSION },
    },
    async ({ session }) => {
      const found = resolve(journal, session);
      if ("problem" in found) {
        return say(found.problem);
      }
      const plan = await rollback({
        journal,
        router: options.router(),
        runId: found.id,
        dryRun: true,
      });
      const steps = plan.steps.map(
        (step) => `${String(step.seq)}  ${step.kind}  ${step.server}.${step.tool}  ${step.reason}`,
      );
      const halt =
        plan.halted === undefined
          ? "Nothing would stop it."
          : `It would stop at ${String(plan.halted.seq)}: ${plan.halted.reason}`;
      return say([...steps, "", halt].join("\n"));
    },
  );

  server.registerTool(
    "undo_session",
    {
      description:
        "Actually reverse a session, newest action first. Stops rather than writing over " +
        "anything somebody has changed since. This changes the world, so a person is asked " +
        "first. Run preview_undo and tell them what it will do before you call this.",
      inputSchema: { session: SESSION },
    },
    async ({ session }) => {
      const found = resolve(journal, session);
      if ("problem" in found) {
        return say(found.problem);
      }
      const report = await rollback({ journal, router: options.router(), runId: found.id });
      const reverted = report.steps.filter((step) => step.kind === "revert").length;
      const halt =
        report.halted === undefined
          ? ""
          : `\nIt stopped at ${String(report.halted.seq)}: ${report.halted.reason}\n` +
            `Everything newer than that was put back. Resolving it is a person's decision, ` +
            `not yours -- do not look for a way around it.`;
      return say(`${report.status} · ${String(reverted)} reverted${halt}`);
    },
  );

  return server;
}

/**
 * The toolset as an upstream, connected in memory.
 *
 * No process, no pipe: this server is part of the app. It still goes through
 * the proxy so that its tools are classified, journalled and gated like any
 * other server's, which is what keeps undo_session behind an approval.
 */
export async function connectToolset(server: McpServer, name: string): Promise<Upstream> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synartesis-proxy", version: "0.1.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    name,
    client,
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}

/**
 * The policy for the toolset, written here rather than asked of the user.
 *
 * Everything that only reads is readonly, so the model may look as much as it
 * likes. `undo_session` changes the world and cannot be classified as anything
 * else honestly: it is irreversible from the journal's point of view -- there
 * is no inverse for an undo -- so it is gated, and a person answers.
 */
/**
 * `refusal` is a real claim in both cases, not a field filled in to satisfy a
 * type. These five are this app's own code: the four readers genuinely change
 * nothing on their way to reporting an error, which is what `clean` asserts.
 * An undo that fails is the opposite -- it may have reversed some actions
 * before it stopped -- so it keeps the default and stays uncertain.
 */
const READS = { class: "readonly" as const, gate: "never" as const, refusal: "clean" as const };

export const TOOLSET_POLICY: readonly ToolPolicy[] = [
  { match: "synartesis.list_sessions", ...READS },
  { match: "synartesis.show_session", ...READS },
  { match: "synartesis.what_changed", ...READS },
  { match: "synartesis.preview_undo", ...READS },
  {
    match: "synartesis.undo_session",
    class: "irreversible",
    gate: "always",
    refusal: "uncertain",
  },
];
