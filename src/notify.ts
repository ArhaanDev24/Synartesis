import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Telling the person that a call is waiting for them.
 *
 * Nothing did. A held call was refused to the agent with a message saying to
 * ask a person, and whether that person ever heard depended on the agent
 * relaying it, the person reading the chat at that moment, or `watch` already
 * being open in another window. So the one decision this tool exists to put in
 * front of a human was, most of the time, put in front of nobody.
 *
 * A desktop notification, from the machine the proxy runs on. Deliberately
 * small and deliberately careful:
 *
 * - **Text is passed as arguments, never built into a script.** The server and
 *   tool names come from the upstream, which is not trusted. osascript is
 *   given them as `argv` to a fixed script -- checked by hand with a name
 *   carrying `do shell script`, which came back as text -- and `--` ends its
 *   options, so a name beginning with a dash is still a name.
 * - **Never the arguments of the call.** They carry tokens and file contents,
 *   and macOS keeps notification history.
 * - **Never in the way.** Fire and forget: no await, an `error` handler (a
 *   missing binary would otherwise crash the proxy), `unref`, and a kill timer.
 * - Off with `SYNARTESIS_NOTIFY=0`. Windows gets nothing yet, and `notify
 *   --test` says so rather than appearing to work.
 */

/** What a notification says. Nothing here may come from a call's arguments. */
export interface HeldNotice {
  readonly server: string;
  readonly tool: string;
  /** The short id a person approves by. Not a secret. */
  readonly actionId: string;
  /** The command to approve it, for the person -- never sent to the agent. */
  readonly approve: string;
}

export type Notifier = (notice: HeldNotice) => void;

/** Nothing, for tests and for anywhere a notification makes no sense. */
export const SILENT: Notifier = () => undefined;

/** Longest a name may be before it is cut, so a hostile one cannot fill the screen. */
const NAME_MAX = 60;

/**
 * A name from the upstream, made safe to show. Control characters and the
 * bidirectional overrides are removed -- U+202A-202E and U+2066-2069 can make
 * `evil.tool` render as something else entirely -- and the result is cut.
 */
export function shown(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "");
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}…` : clean;
}

/** notify-send renders a body as markup on most servers. */
function unmarked(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function words(notice: HeldNotice, open: string | undefined): { readonly title: string; readonly body: string } {
  // What to do, in the fewest words that work. This carried the whole approve
  // command with an eight-character id and an absolute journal path: a line to
  // retype exactly, cut off by the notification before its end. Opening
  // Synartesis lands on the waiting call, where one key answers it.
  return {
    title: "Synartesis: a call is waiting for you",
    body: `${shown(notice.server)}.${shown(notice.tool)} -- open a terminal and run: ${open ?? notice.approve}`,
  };
}

/** How long a notifier process may live before it is killed. */
const KILL_AFTER_MS = 5000;

function launch(command: string, args: readonly string[]): void {
  try {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", () => undefined);
    const timer = setTimeout(() => child.kill(), KILL_AFTER_MS);
    timer.unref();
    child.on("exit", () => {
      clearTimeout(timer);
    });
    child.unref();
  } catch {
    // Notifying is a courtesy. Nothing about it may reach the call.
  }
}

/**
 * The notifier for this machine, or `SILENT` where there is none or it is
 * switched off.
 */
export function desktopNotifier(
  env: NodeJS.ProcessEnv = process.env,
  /** Which platform's notifier; passed only by tests, which run on one. */
  os: NodeJS.Platform = platform(),
  /** The command that opens Synartesis on the waiting call. */
  open?: string,
): Notifier {
  if (env["SYNARTESIS_NOTIFY"] === "0") {
    return SILENT;
  }
  if (os === "darwin") {
    return (notice) => {
      const { title, body } = words(notice, open);
      launch("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        "--",
        title,
        body,
      ]);
    };
  }
  if (os === "linux") {
    return (notice) => {
      const { title, body } = words(notice, open);
      launch("notify-send", ["--app-name=Synartesis", "--", title, unmarked(body)]);
    };
  }
  return SILENT;
}

/** Whether this machine has a way to notify at all, for `notify --test`. */
export function canNotify(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env["SYNARTESIS_NOTIFY"] === "0") {
    return "switched off by SYNARTESIS_NOTIFY=0";
  }
  const os = platform();
  if (os === "darwin" || os === "linux") {
    return undefined;
  }
  return `there is no notifier for ${os} yet; use synartesis watch to see what is waiting`;
}
