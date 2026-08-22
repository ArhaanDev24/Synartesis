import { existsSync } from "node:fs";

import { openJournal, type ActionRow, type Journal } from "./journal/journal.js";
import { rule, style, WORDMARK } from "./style.js";

/**
 * A live view of the journal.
 *
 * Synartesis is not a daemon and cannot be one: an MCP client spawns a stdio
 * server itself and owns its lifetime, so nothing long-running could sit in
 * between and see those calls. What a person actually wants from a daemon is
 * the reassurance that it is there and doing something, and that does not
 * require a background process. It requires somewhere to look.
 */

const FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

const MARK: Record<string, string> = {
  readonly: "\u00b7",
  reversible: "\u2190",
  compensable: "\u2248",
  irreversible: "!",
  unclassified: "?",
};

export interface WatchOptions {
  readonly journalPath: string;
  readonly approveWith: string;
  readonly intervalMs?: number;
  /** Stop after this many ticks. Only tests pass it. */
  readonly maxTicks?: number;
  readonly write: (text: string) => void;
  readonly live: boolean;
}

function line(action: ActionRow): string {
  const mark = MARK[action.class] ?? "?";
  const badge = `${mark} ${action.class}`.padEnd(14);
  const when = action.ts.slice(11, 19);
  const status =
    action.status === "gated"
      ? style.strong(action.status.padEnd(13))
      : action.status === "denied" || action.status === "unrecoverable"
        ? style.accent(action.status.padEnd(13))
        : style.quiet(action.status.padEnd(13));
  return `  ${style.quiet(when)}  ${style.quiet(badge)} ${status} ${action.server}.${action.tool}`;
}

/**
 * What there is to look at before the proxy has run once.
 *
 * Refusing to start was the wrong answer for this one command. Every other
 * command answers a question, and inventing an empty journal to answer it with
 * would look exactly like a real answer of "nothing happened". Watching is not
 * a question: the ordinary way round is to start watching, then point an agent
 * at the proxy, and the proxy is what creates the journal. A watch that will
 * not begin until something has already happened is no use at the only moment
 * anyone wants one.
 */
function waiting(options: WatchOptions, tick: number): string {
  const spinner = options.live ? `${style.accent(FRAMES[tick % FRAMES.length] ?? "")} ` : "";
  return [
    "",
    `  ${style.plate(WORDMARK)}  ${style.quiet(options.journalPath)}`,
    `  ${rule(64)}`,
    "",
    `  ${spinner}${style.quiet("no journal here yet")}`,
    "",
    `  ${style.quiet("One appears the first time an agent calls a tool through the proxy.")}`,
    `  ${style.quiet("Point your client at it, then work as usual; this will fill in.")}`,
    "",
  ].join("\n");
}

function render(journal: Journal, options: WatchOptions, tick: number): string {
  const runs = journal.listRuns();
  const recent = journal.recentActions(12);
  const waiting = journal.listGated();
  const active = runs.filter((run) => run.status === "active").length;

  const out: string[] = [];
  out.push("");
  out.push(`  ${style.plate(WORDMARK)}  ${style.quiet(options.journalPath)}`);
  out.push(`  ${rule(64)}`);
  out.push("");

  const spinner = options.live ? `${style.accent(FRAMES[tick % FRAMES.length] ?? "")} ` : "";
  out.push(
    `  ${spinner}${style.quiet("watching")}  ` +
      `${String(runs.length)} runs, ${String(active)} live  ` +
      `${style.quiet("\u00b7")}  ${String(recent.length)} recent actions  ` +
      `${style.quiet("\u00b7")}  ${waiting.length > 0 ? style.accent(`${String(waiting.length)} awaiting approval`) : style.quiet("nothing waiting")}`,
  );
  out.push("");

  if (recent.length === 0) {
    out.push(`  ${style.quiet("No agent has done anything through this journal yet.")}`);
  } else {
    for (const action of recent) {
      out.push(line(action));
    }
  }

  if (waiting.length > 0) {
    out.push("");
    out.push(`  ${style.label("awaiting approval")}`);
    for (const action of waiting) {
      out.push(`  ${style.accent(`${action.server}.${action.tool}`)}  ${style.quiet(action.id.slice(0, 8))}`);
    }
    out.push("");
    out.push(`  ${style.quiet(`${options.approveWith} approve --all`)}`);
  }

  out.push("");
  return out.join("\n");
}

export async function watch(options: WatchOptions): Promise<number> {
  // Opened lazily, and only once there is something to open.
  let journal: Journal | undefined;
  const frame = (tick: number): string => {
    if (journal === undefined && existsSync(options.journalPath)) {
      journal = openJournal(options.journalPath, { mustExist: true });
    }
    return journal === undefined ? waiting(options, tick) : render(journal, options, tick);
  };

  const interval = options.intervalMs ?? 120;
  const clear = "\u001b[H\u001b[2J\u001b[3J";
  // A holder, not a plain boolean: the only assignment happens in a signal
  // handler, which narrowing cannot see, so a bare flag reads as always false.
  const state = { stop: false };

  const onSignal = (): void => {
    state.stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (!options.live) {
      // Not a terminal: print the state once and leave, so this is still
      // usable from a script without spraying escape codes into a pipe.
      options.write(`${frame(0)}\n`);
      return 0;
    }

    options.write("\u001b[?25l");
    for (let tick = 0; !state.stop; tick += 1) {
      options.write(clear + frame(tick));
      if (options.maxTicks !== undefined && tick + 1 >= options.maxTicks) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
    return 0;
  } finally {
    if (options.live) {
      options.write("\u001b[?25h\n");
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    journal?.close();
  }
}
