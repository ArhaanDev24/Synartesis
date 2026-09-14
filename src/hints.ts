/**
 * What to do next, said out loud.
 *
 * Every command here ends in a state that implies one obvious next move, and
 * almost none of them said what it was. `check` printed a policy and stopped.
 * `list` printed forty sessions and stopped. `approve` said approved and
 * stopped -- leaving somebody to work out, from a help page listing every
 * command there is, which one follows. That is the whole reason this is hard to use:
 * not that any single command is complicated, but that knowing the next one
 * is a thing you have to already know.
 *
 * A hint is that next move, named, with its arguments already filled in, so it
 * can be read or pasted without going back to the manual.
 *
 * Four rules keep it a hint rather than a nag:
 *
 * - One at a time. A list of things to consider is the help page again.
 * - Only when the state says so. A line that appears every time becomes a
 *   footer, and a footer is read once and then never again.
 * - It must be true right now. Every hint below is computed from the journal
 *   or the manifest in front of it, never from which command was typed.
 * - Never to a program. --json means the reader is not a person, and
 *   SYNARTESIS_NO_HINTS means a person who has said so.
 */
import { ago } from "./clock.js";
import { cliCommand } from "./invocation.js";
import type { Journal } from "./journal/journal.js";
import type { Manifest } from "./manifest/types.js";
import { errorStyle, style } from "./style.js";

/** A path a copied command has to be told about, having not been the default. */
export type Where = "journal" | "manifest";

export interface Hint {
  /** Why this is the next thing, in the words of what just happened. */
  readonly why: string;
  /** The command, without the program name. Absent when there is nothing to run. */
  readonly run?: string;
  /**
   * Which paths this command needs repeated back to it.
   *
   * A hint is meant to be pasted, and a pasted command that quietly reads a
   * different journal than the one on screen is worse than no hint: `list
   * --journal ./bench.db` naming a session, and `show <that session>` then
   * answering "no run matches", teaches somebody the line is a lie. The caller
   * knows which paths were given and which were found, and fills in only the
   * ones that were not the obvious answer.
   */
  readonly needs?: readonly Where[];
}

/** A person, unless they have said otherwise. */
export function hintsWanted(): boolean {
  return process.env["SYNARTESIS_NO_HINTS"] === undefined;
}

/**
 * One line, in the shape the rest of the output already uses for this: the
 * reason quiet, the command bright enough to find with your eye and short
 * enough to retype.
 */
export function hintLine(hint: Hint, paths = ""): string {
  if (hint.run === undefined) {
    return `  ${style.quiet(hint.why)}`;
  }
  return `  ${style.quiet(`${hint.why}:`)}  ${style.strong(`${cliCommand()} ${hint.run}${paths}`)}`;
}

/** Ids are uuids and nobody retypes one; any unambiguous prefix is accepted. */
function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * Somebody is blocked.
 *
 * This outranks everything else in the file, and it should: a held call is an
 * agent stopped mid-task waiting on a person who may not know it is waiting.
 * Anything else a hint could say can wait until that is answered.
 */
export function heldCalls(journal: Journal): Hint | undefined {
  const waiting = journal.listGated();
  const [first, ...rest] = waiting;
  if (first === undefined) {
    return undefined;
  }
  if (rest.length === 0) {
    return {
      why: `${first.server}.${first.tool} is held, and the agent is waiting on you`,
      run: `approve ${short(first.id)}`,
      needs: ["journal"],
    };
  }
  return {
    why: `${String(waiting.length)} calls are held, and the agent is waiting on you`,
    run: "approve --all",
    needs: ["journal"],
  };
}

/**
 * The session somebody would actually want to look at.
 *
 * Not the newest one. A client that connects and reads opens a session like
 * any other, so "the last thing that happened" is regularly a session in which
 * nothing happened -- and pointing at it is how you teach somebody that these
 * hints are not worth reading.
 */
export function whatChanged(journal: Journal): Hint | undefined {
  const run = journal.newestUndoable();
  if (run === undefined) {
    return undefined;
  }
  return {
    why: `${run.label ?? "an agent"} changed something ${ago(run.startedAt)}`,
    run: `show ${short(run.id)}`,
    needs: ["journal"],
  };
}

/**
 * A policy nobody has vouched for.
 *
 * Pinning is the difference between a policy that describes the tools and one
 * that is bound to them, and an unpinned manifest looks exactly like a pinned
 * one from every command except this sentence.
 */
export function notPinned(manifest: Manifest): Hint | undefined {
  const pinned = Object.keys(manifest.pins ?? {});
  const loose = Object.keys(manifest.servers).filter((name) => !pinned.includes(name));
  if (loose.length === 0) {
    return undefined;
  }
  return {
    why:
      pinned.length === 0
        ? "no tool here is pinned, so a server that changes shape keeps its old policy"
        : `${loose.join(", ")} ${loose.length === 1 ? "is" : "are"} not pinned`,
    run: "pin",
    needs: ["manifest"],
  };
}

/**
 * Nothing is wrong, and nothing needs doing.
 *
 * Said only where somebody has just asked a question and got an empty answer,
 * because that is the one case where silence reads as a failure rather than as
 * a clean result.
 */
export const LEAVE_IT_RUNNING: Hint = {
  why: "anything an agent holds will appear here as it happens",
  run: "watch",
  needs: ["journal"],
};

/**
 * What to say after `status`, which is the one command that runs before there
 * is anything to say anything about.
 *
 * With no journal there is no session to name, and that is not a gap -- it is
 * the state somebody is in the moment after installing, which is exactly when
 * they most need telling what to do with the thing they have just wired up.
 */
export function afterStatus(journal: Journal | undefined): Hint | undefined {
  if (journal === undefined) {
    return LEAVE_IT_RUNNING;
  }
  return firstOf(
    () => heldCalls(journal),
    () => whatChanged(journal),
    () => LEAVE_IT_RUNNING,
  );
}

/**
 * The first hint that applies, or none.
 *
 * Candidates are thunks rather than values, and that is not ceremony: each one
 * is a query, they are passed in priority order, and evaluating the arguments
 * eagerly meant every `list` asked the journal what had changed even when a
 * held call had already won. The answer was then thrown away.
 *
 * Callers pass them in the order that suits what they just printed; this only
 * enforces that exactly one is asked for beyond the one that answers.
 */
export function firstOf(...candidates: readonly (() => Hint | undefined)[]): Hint | undefined {
  for (const candidate of candidates) {
    const hint = candidate();
    if (hint !== undefined) {
      return hint;
    }
  }
  return undefined;
}

/**
 * The nearest thing somebody might have meant.
 *
 * Levenshtein with a ceiling that scales with the word: `lst` for `list` is
 * worth guessing at, `zzzzzz` for `list` is not, and a suggestion that is
 * wrong more often than right costs more than no suggestion at all.
 */
export function didYouMean(typed: string, known: readonly string[]): string | undefined {
  const ceiling = Math.max(1, Math.floor(typed.length / 2));
  let best: string | undefined;
  let bestAt = ceiling + 1;
  for (const candidate of known) {
    const gap = distance(typed, candidate);
    if (gap < bestAt) {
      best = candidate;
      bestAt = gap;
    }
  }
  return bestAt <= ceiling ? best : undefined;
}

function distance(from: string, to: string): number {
  // One row at a time. These are command names, so the table would be tiny
  // either way; this is just the shape that does not need a table.
  let previous = Array.from({ length: to.length + 1 }, (_, at) => at);
  for (let i = 1; i <= from.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= to.length; j += 1) {
      const same = from[i - 1] === to[j - 1];
      row.push(
        Math.min(
          (previous[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (previous[j - 1] ?? 0) + (same ? 0 : 1),
        ),
      );
    }
    previous = row;
  }
  return previous[to.length] ?? to.length;
}

/**
 * The five commands somebody actually types, for when they have typed
 * something that is not a command.
 *
 * The full page is right for `--help`, where it was asked for. Answering a
 * three-letter typo with forty lines buries the one line that says what went
 * wrong, and every one of those forty is about something the person was not
 * doing.
 */
export const EVERYDAY = [
  ["install", "cover the servers your client already lists"],
  ["watch", "see what an agent does, and answer what it holds"],
  ["list", "the sessions recorded so far"],
  ["show", "what one session did, and whether it still holds"],
  ["undo", "put back what one of them changed"],
] as const;

/**
 * Set in the stderr palette, because that is where it goes. The stdout one
 * decides from stdout, so `synartesis nonsense 2> errors.log` in a terminal
 * used to write escape sequences into the file.
 */
export function shortList(): string {
  const self = cliCommand();
  return [
    "",
    ...EVERYDAY.map(
      ([name, said]) =>
        `  ${errorStyle.strong(`${self} ${name.padEnd(8)}`)} ${errorStyle.quiet(said)}`,
    ),
    "",
    `  ${errorStyle.quiet(`${self} --help for every command.`)}`,
    "",
  ].join("\n");
}
