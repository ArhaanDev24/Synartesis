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
  /**
   * Who a decision made from here is recorded as. Absent means the view is
   * read-only, which is what a pipe gets.
   */
  readonly decideAs?: string;
  /** Key presses. Defaults to the terminal; tests drive it directly. */
  readonly keys?: AsyncIterable<string>;
}

interface View {
  stop: boolean;
  /** Which waiting call the keys act on. */
  cursor: number;
  notice: string;
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
function waitingForJournal(options: WatchOptions, tick: number): string {
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

function render(journal: Journal, options: WatchOptions, tick: number, view: View): string {
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
    const at = Math.min(view.cursor, waiting.length - 1);
    out.push("");
    out.push(`  ${style.label("awaiting approval")}`);
    waiting.forEach((action, index) => {
      // A cursor rather than a key that acts on all of them. One keystroke
      // that approves everything waiting is one keystroke away from
      // approving something nobody read.
      const here = index === at && canDecide(options);
      const mark = here ? style.accent("\u276f") : " ";
      const name = here
        ? style.accent(`${action.server}.${action.tool}`)
        : style.quiet(`${action.server}.${action.tool}`);
      out.push(`  ${mark} ${name}  ${style.quiet(truncate(JSON.stringify(action.args), 56))}`);
    });
    out.push("");
    out.push(
      canDecide(options)
        ? `  ${keyHint("a", "approve")}   ${keyHint("d", "deny")}   ${keyHint("j/k", "move")}   ${keyHint("q", "quit")}`
        : `  ${style.quiet(`${options.approveWith} approve --all`)}`,
    );
  }

  if (view.notice !== "") {
    out.push("");
    out.push(`  ${style.accent(view.notice)}`);
  }

  out.push("");
  return out.join("\n");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function keyHint(key: string, what: string): string {
  return `${style.strong(`[${key}]`)} ${style.quiet(what)}`;
}

/**
 * Deciding needs both a name to record it under and a keyboard to press. A
 * piped view is a report, and a report must not be able to approve anything.
 */
function canDecide(options: WatchOptions): boolean {
  return options.live && options.decideAs !== undefined;
}

/** Raw keystrokes from the terminal, as an iterable the loop below can read. */
async function* terminalKeys(): AsyncIterable<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return;
  }
  input.setRawMode(true);
  input.resume();
  try {
    for await (const chunk of input) {
      // The stream's iterator is untyped, so the shape is checked rather than
      // asserted: a wrong guess here would be a key nobody can press.
      const raw: unknown = chunk;
      if (typeof raw === "string") {
        yield raw;
      } else if (Buffer.isBuffer(raw)) {
        yield raw.toString("utf8");
      }
    }
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}

export async function watch(options: WatchOptions): Promise<number> {
  // Opened lazily, and only once there is something to open.
  let journal: Journal | undefined;
  const open = (): Journal | undefined => {
    if (journal === undefined && existsSync(options.journalPath)) {
      journal = openJournal(options.journalPath, { mustExist: true });
    }
    return journal;
  };

  const interval = options.intervalMs ?? 120;
  const clear = "\u001b[H\u001b[2J\u001b[3J";
  // A holder, not plain locals: these are written from a signal handler and a
  // key loop, neither of which narrowing can see.
  const view: View = { stop: false, cursor: 0, notice: "" };

  const frame = (tick: number): string => {
    const ready = open();
    return ready === undefined
      ? waitingForJournal(options, tick)
      : render(ready, options, tick, view);
  };

  /**
   * Answering from here rather than from a second terminal.
   *
   * The loop it removes is the one that actually hurts: an agent stops, you
   * notice, you switch window, you list what is waiting, you copy an id, you
   * run approve, you switch back. Six moves to say yes once, and every one of
   * them a chance to approve the wrong thing because you are working from an
   * id rather than from the call itself.
   */
  const decide = (approve: boolean): void => {
    const ready = open();
    if (ready === undefined || options.decideAs === undefined) {
      return;
    }
    const waiting = ready.listGated();
    const action = waiting[Math.min(view.cursor, waiting.length - 1)];
    if (action === undefined) {
      return;
    }
    const changed = approve
      ? ready.approve(action.id, options.decideAs)
      : ready.deny(action.id, options.decideAs, "denied from the watch view");
    view.notice = changed
      ? `${approve ? "approved" : "denied"} ${action.server}.${action.tool}`
      : `${action.server}.${action.tool} was already settled`;
    view.cursor = 0;
  };

  const press = (key: string): void => {
    switch (key) {
      case "q":
      case "\u0003":
        // Ctrl-C does not raise a signal while the terminal is raw, so the
        // key that everyone reaches for has to be handled here or the view
        // cannot be left at all.
        view.stop = true;
        return;
      case "a":
        decide(true);
        return;
      case "d":
        decide(false);
        return;
      case "j":
      case "\u001b[B":
        view.cursor += 1;
        return;
      case "k":
      case "\u001b[A":
        view.cursor = Math.max(0, view.cursor - 1);
        return;
      default:
        return;
    }
  };

  const onSignal = (): void => {
    view.stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const source = canDecide(options) ? (options.keys ?? terminalKeys()) : undefined;
  const reading =
    source === undefined
      ? Promise.resolve()
      : (async (): Promise<void> => {
          for await (const key of source) {
            press(key);
            if (view.stop) {
              return;
            }
          }
        })();

  try {
    if (!options.live) {
      // Not a terminal: print the state once and leave, so this is still
      // usable from a script without spraying escape codes into a pipe.
      options.write(`${frame(0)}\n`);
      return 0;
    }

    options.write("\u001b[?25l");
    for (let tick = 0; !view.stop; tick += 1) {
      options.write(clear + frame(tick));
      if (options.maxTicks !== undefined && tick + 1 >= options.maxTicks) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
      // Long enough to read, short enough not to sit there stale.
      if (tick % 24 === 23) {
        view.notice = "";
      }
    }
    return 0;
  } finally {
    if (options.live) {
      options.write("\u001b[?25h\n");
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    view.stop = true;
    await Promise.race([reading, Promise.resolve()]);
    journal?.close();
  }
}
