import { existsSync } from "node:fs";

import { openJournal, type ActionRow, type Journal, type RunRow } from "./journal/journal.js";
import type { RollbackReport } from "./rollback/rollback.js";
import { rule, style, WORDMARK } from "./style.js";

/**
 * One screen you drive, rather than eight commands you have to remember.
 *
 * The commands are still there and still what a script uses. But a person
 * looking at what an agent just did should not have to know that runs are
 * listed by one word, opened by a second and undone by a third, nor carry an
 * id between them by hand. Everything here acts on the thing under the cursor,
 * which is the thing you are already looking at.
 */

const FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

const MARK: Record<string, string> = {
  readonly: "·",
  reversible: "←",
  compensable: "≈",
  irreversible: "!",
  unclassified: "?",
};

const CURSOR = "❯";
const DOT = "·";
const ESC = "\u001b";

/** How long a confirmation stays up, in ticks, counted from when it appeared. */
const NOTICE_TICKS = 26;

export type Undo = (runId: string, dryRun: boolean) => Promise<RollbackReport>;

export interface ConsoleOptions {
  readonly journalPath: string;
  readonly write: (text: string) => void;
  readonly live: boolean;
  /** Who a decision made here is recorded as. */
  readonly decideAs: string;
  readonly intervalMs?: number;
  /** Stop after this many ticks. Only tests pass it. */
  readonly maxTicks?: number;
  /** Key presses. Defaults to the terminal; tests drive it directly. */
  readonly keys?: AsyncIterable<string>;
  /**
   * How an undo is actually carried out. Injected because performing one means
   * starting every server the manifest names, which a test of what the screen
   * does has no business doing.
   */
  readonly undo?: Undo;
}

type Mode = "runs" | "run" | "gates";

interface Screen {
  stop: boolean;
  mode: Mode;
  cursor: number;
  openRun: string | undefined;
  /** An undo waiting on a yes. */
  confirming: string | undefined;
  busy: string | undefined;
  notice: string;
  noticeUntil: number;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function keyHint(key: string, what: string): string {
  return `${style.strong(`[${key}]`)} ${style.quiet(what)}`;
}

/**
 * Node declares isTTY as a boolean and then leaves it undefined whenever there
 * is no terminal. Taking it as unknown is the only way to test the value that
 * is actually there rather than the one the types promise.
 */
function isTerminal(value: unknown): boolean {
  return value === true;
}

function canPress(options: ConsoleOptions): boolean {
  return options.live && (options.keys !== undefined || isTerminal(process.stdin.isTTY));
}

function modeLabel(screen: Screen): string {
  switch (screen.mode) {
    case "runs":
      return "everything an agent has done through this journal";
    case "run":
      return "one run, in the order it happened";
    case "gates":
      return "held until a person decides";
  }
}

function header(options: ConsoleOptions, screen: Screen, tick: number): string[] {
  const spinner = options.live ? `${style.accent(FRAMES[tick % FRAMES.length] ?? "")} ` : "";
  return [
    "",
    `  ${style.plate(WORDMARK)}  ${style.quiet(options.journalPath)}`,
    `  ${rule(70)}`,
    "",
    `  ${spinner}${style.quiet(screen.busy ?? modeLabel(screen))}`,
    "",
  ];
}

function runsView(journal: Journal, screen: Screen, options: ConsoleOptions): string[] {
  const runs = [...journal.listRuns()].reverse();
  if (runs.length === 0) {
    return [
      `  ${style.quiet("No agent has done anything through this journal yet.")}`,
      "",
      `  ${style.quiet("A run appears the first time one calls a tool through the proxy.")}`,
    ];
  }

  const at = Math.min(screen.cursor, runs.length - 1);
  return runs.map((run, index) => {
    const actions = journal.getActions(run.id);
    const held = actions.filter((action) => action.status === "gated").length;
    const here = index === at && canPress(options);
    const name = (run.label ?? "an agent").padEnd(24);
    const note = held === 0 ? "" : `  ${style.accent(`${String(held)} awaiting approval`)}`;
    return (
      `  ${here ? style.accent(CURSOR) : " "} ${here ? style.accent(name) : style.strong(name)} ` +
      `${style.quiet(run.startedAt.slice(0, 19).replace("T", " "))}  ` +
      `${style.quiet(run.status.padEnd(11))} ${style.quiet(`${String(actions.length)} actions`)}${note}`
    );
  });
}

function statusOf(action: ActionRow): string {
  const text = action.status.padEnd(13);
  if (action.status === "denied" || action.status === "unrecoverable") {
    return style.accent(text);
  }
  return action.status === "gated" ? style.strong(text) : style.quiet(text);
}

function runView(journal: Journal, screen: Screen): string[] {
  const runId = screen.openRun;
  if (runId === undefined) {
    return [`  ${style.quiet("no run selected")}`];
  }
  const run = journal.getRun(runId);
  const actions = journal.getActions(runId);
  const out = [
    `  ${style.label("run")}  ${style.strong(run?.label ?? "an agent")}  ${style.quiet(runId.slice(0, 8))}`,
    "",
  ];
  if (actions.length === 0) {
    out.push(`  ${style.quiet("nothing was recorded in this run")}`);
    return out;
  }
  for (const action of actions) {
    const badge = `${MARK[action.class] ?? "?"} ${action.class}`.padEnd(14);
    out.push(
      `  ${style.quiet(String(action.seq).padStart(3))}  ${style.quiet(badge)} ` +
        `${statusOf(action)} ${style.strong(`${action.server}.${action.tool}`)}`,
    );
    out.push(`        ${style.quiet(truncate(JSON.stringify(action.args), 62))}`);
    if (action.inverse !== undefined) {
      out.push(`        ${style.quiet(`undo: ${truncate(JSON.stringify(action.inverse), 56)}`)}`);
    }
  }
  return out;
}

function gatesView(journal: Journal, screen: Screen, options: ConsoleOptions): string[] {
  const waiting = journal.listGated();
  if (waiting.length === 0) {
    return [`  ${style.quiet("Nothing is waiting for a decision.")}`];
  }
  const at = Math.min(screen.cursor, waiting.length - 1);
  return waiting.map((action, index) => {
    const here = index === at && canPress(options);
    const name = `${action.server}.${action.tool}`;
    const shown = here ? style.accent(name) : style.quiet(name);
    const args = style.quiet(truncate(JSON.stringify(action.args), 54));
    return `  ${here ? style.accent(CURSOR) : " "} ${shown}  ${args}`;
  });
}

function footer(screen: Screen, options: ConsoleOptions): string[] {
  if (!canPress(options)) {
    return [];
  }
  if (screen.confirming !== undefined) {
    return [
      "",
      `  ${style.accent("undo this whole run?")}  ${keyHint("y", "yes")}   ${keyHint("n", "no")}`,
    ];
  }
  const keys =
    screen.mode === "gates"
      ? [keyHint("a", "approve"), keyHint("d", "deny"), keyHint("j/k", "move"), keyHint("r", "runs")]
      : screen.mode === "run"
        ? [
            keyHint("p", "preview undo"),
            keyHint("u", "undo"),
            keyHint("esc", "back"),
            keyHint("g", "held"),
          ]
        : [
            keyHint("enter", "open"),
            keyHint("p", "preview undo"),
            keyHint("u", "undo"),
            keyHint("j/k", "move"),
            keyHint("g", "held"),
          ];
  return ["", `  ${keys.join("   ")}   ${keyHint("q", "quit")}`];
}

function waitingForJournal(options: ConsoleOptions, tick: number): string {
  const spinner = options.live ? `${style.accent(FRAMES[tick % FRAMES.length] ?? "")} ` : "";
  return [
    "",
    `  ${style.plate(WORDMARK)}  ${style.quiet(options.journalPath)}`,
    `  ${rule(70)}`,
    "",
    `  ${spinner}${style.quiet("no journal here yet")}`,
    "",
    `  ${style.quiet("One appears the first time an agent calls a tool through the proxy.")}`,
    `  ${style.quiet("Point your client at it, then work as usual; this will fill in.")}`,
    "",
  ].join("\n");
}

/** Raw keystrokes from the terminal, as an iterable the loop below can read. */
async function* terminalKeys(): AsyncIterable<string> {
  const input = process.stdin;
  if (!isTerminal(input.isTTY)) {
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

// Named openConsole, not console: an export called console shadows the global
// inside its own module, so the first console.log anyone reaches for in here
// would call this function instead.
export async function openConsole(options: ConsoleOptions): Promise<number> {
  let journal: Journal | undefined;
  const open = (): Journal | undefined => {
    if (journal === undefined && existsSync(options.journalPath)) {
      journal = openJournal(options.journalPath, { mustExist: true });
    }
    return journal;
  };

  const screen: Screen = {
    stop: false,
    mode: "runs",
    cursor: 0,
    openRun: undefined,
    confirming: undefined,
    busy: undefined,
    notice: "",
    noticeUntil: 0,
  };
  let tick = 0;
  // Read through a call rather than touched directly: the compiler narrows a
  // property once it has been tested and does not un-narrow it across a call
  // that could have changed it.
  const stopped = (): boolean => screen.stop;

  const say = (text: string): void => {
    screen.notice = text;
    screen.noticeUntil = tick + NOTICE_TICKS;
  };

  const frame = (): string => {
    const ready = open();
    if (ready === undefined) {
      return waitingForJournal(options, tick);
    }
    const body =
      screen.mode === "runs"
        ? runsView(ready, screen, options)
        : screen.mode === "run"
          ? runView(ready, screen)
          : gatesView(ready, screen, options);
    const notice = screen.notice === "" ? [] : ["", `  ${style.accent(screen.notice)}`];
    return [
      ...header(options, screen, tick),
      ...body,
      ...notice,
      ...footer(screen, options),
      "",
    ].join("\n");
  };

  /** The run the cursor is on, or the one already open. */
  const selectedRun = (ready: Journal): RunRow | undefined => {
    if (screen.mode === "run" && screen.openRun !== undefined) {
      return ready.getRun(screen.openRun);
    }
    const runs = [...ready.listRuns()].reverse();
    return runs[Math.min(screen.cursor, runs.length - 1)];
  };

  const decide = (approve: boolean): void => {
    const ready = open();
    if (ready === undefined) {
      return;
    }
    const waiting = ready.listGated();
    const action = waiting[Math.min(screen.cursor, waiting.length - 1)];
    if (action === undefined) {
      return;
    }
    const changed = approve
      ? ready.approve(action.id, options.decideAs)
      : ready.deny(action.id, options.decideAs, "denied from the console");
    // Approving is not the call. The agent was refused and is not waiting on
    // anything, so nothing happens until somebody asks it again.
    say(
      !changed
        ? `${action.server}.${action.tool} was already settled`
        : approve
          ? `approved ${action.server}.${action.tool} ${DOT} now tell the agent to try again`
          : `denied ${action.server}.${action.tool} ${DOT} it will not go through`,
    );
    screen.cursor = 0;
  };

  const perform = async (runId: string, dryRun: boolean): Promise<void> => {
    if (options.undo === undefined) {
      say("no way to undo was configured");
      return;
    }
    // One at a time. Undoing is slow -- it starts every server the manifest
    // names -- and a key is easy to lean on, so without this a second rollback
    // of the same run began while the first was mid-flight and both of them
    // sent the same inverses.
    if (screen.busy !== undefined) {
      say("still working on the last one");
      return;
    }
    screen.busy = dryRun ? "reading the current state..." : "putting it back...";
    try {
      const report = await options.undo(runId, dryRun);
      const reverted = report.steps.filter((step) => step.kind === "revert").length;
      const halted = report.halted === undefined ? "" : ` ${DOT} halted: ${report.halted.reason}`;
      say(
        dryRun
          ? `${String(reverted)} would be reverted ${DOT} nothing changed${halted}`
          : `${report.status} ${DOT} ${String(reverted)} reverted${halted}`,
      );
    } catch (error: unknown) {
      say(error instanceof Error ? error.message : "the undo failed");
    } finally {
      screen.busy = undefined;
    }
  };

  const press = (key: string): void => {
    if (screen.confirming !== undefined) {
      const runId = screen.confirming;
      screen.confirming = undefined;
      if (key === "y") {
        void perform(runId, false);
      } else {
        say("left alone");
      }
      return;
    }

    switch (key) {
      case "q":
      case "\u0003":
        // Ctrl-C raises no signal while the terminal is raw, so the key
        // everyone reaches for has to be handled here.
        screen.stop = true;
        return;
      case "j":
      case `${ESC}[B`:
        screen.cursor += 1;
        return;
      case "k":
      case `${ESC}[A`:
        screen.cursor = Math.max(0, screen.cursor - 1);
        return;
      case "g":
        screen.mode = "gates";
        screen.cursor = 0;
        return;
      case "r":
        screen.mode = "runs";
        screen.cursor = 0;
        return;
      case ESC:
      case "h":
        screen.mode = "runs";
        screen.openRun = undefined;
        return;
      case "\r":
      case "\n": {
        const ready = open();
        const run = ready === undefined ? undefined : selectedRun(ready);
        if (run !== undefined) {
          screen.openRun = run.id;
          screen.mode = "run";
        }
        return;
      }
      case "a":
        if (screen.mode === "gates") {
          decide(true);
        }
        return;
      case "d":
        if (screen.mode === "gates") {
          decide(false);
        }
        return;
      case "p": {
        const ready = open();
        const run = ready === undefined ? undefined : selectedRun(ready);
        if (run !== undefined) {
          void perform(run.id, true);
        }
        return;
      }
      case "u": {
        if (screen.busy !== undefined) {
          say("still working on the last one");
          return;
        }
        const ready = open();
        const run = ready === undefined ? undefined : selectedRun(ready);
        if (run !== undefined) {
          // Undo is the one direction that cannot itself be taken back, so it
          // is the one thing here that asks twice.
          screen.confirming = run.id;
        }
        return;
      }
      default:
        return;
    }
  };

  const onSignal = (): void => {
    screen.stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const source = canPress(options) ? (options.keys ?? terminalKeys()) : undefined;
  // Held rather than left inside a for-await, so it can be closed however the
  // screen stops: a reader left on a raw terminal never gives the shell its
  // echo back and keeps a handle the process will not let go of.
  const reader = source?.[Symbol.asyncIterator]();
  const reading =
    reader === undefined
      ? Promise.resolve()
      : (async (): Promise<void> => {
          for (;;) {
            const next = await reader.next();
            if (next.done === true || stopped()) {
              return;
            }
            press(next.value);
            if (stopped()) {
              return;
            }
          }
        })();

  const interval = options.intervalMs ?? 120;
  const clear = `${ESC}[H${ESC}[2J${ESC}[3J`;

  try {
    if (!options.live) {
      options.write(`${frame()}\n`);
      return 0;
    }
    options.write(`${ESC}[?25l`);
    for (; !screen.stop; tick += 1) {
      if (screen.notice !== "" && tick >= screen.noticeUntil) {
        screen.notice = "";
      }
      options.write(clear + frame());
      if (options.maxTicks !== undefined && tick + 1 >= options.maxTicks) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
    return 0;
  } finally {
    if (options.live) {
      options.write(`${ESC}[?25h\n`);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    screen.stop = true;
    // Asked to close, but not waited on indefinitely: a source blocked on a
    // read it will never get would otherwise hold the screen open at exactly
    // the moment it is trying to leave.
    await Promise.race([
      (async (): Promise<void> => {
        await reader?.return?.(undefined);
        await reading;
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 50).unref()),
    ]);
    journal?.close();
  }
}
