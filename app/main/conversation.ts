import { randomUUID } from "node:crypto";

import { run } from "./agent.js";
import type { Engine } from "./engine.js";
import { SEPARATOR } from "../../src/proxy/routing.js";
import type { Exchange, Provider, Reasoning } from "../providers/index.js";
import type { ChangeSummary, ChatMessage, Recorded, SessionEvent } from "../shared/ipc.js";
import { fold } from "../shared/transcript.js";

/**
 * One conversation, and everything the window needs to draw it.
 *
 * Deliberately free of Electron. A window is a way of looking at this, not the
 * thing itself, and keeping the two apart means the interesting half -- what a
 * turn does, what the journal made of it, what the person is told afterwards --
 * can be tested without opening one.
 */

/**
 * What the model is told about where it is.
 *
 * Worth being plain with it. A model that does not know its calls are being
 * recorded will apologise for a held call and try to route around it, which is
 * the one behaviour this whole product exists to prevent.
 */
export const SYSTEM = [
  "You are working inside Synartesis, which records every tool call you make",
  "together with the state that call replaced, so the person you are helping",
  "can put things back afterwards.",
  "",
  "Some calls change things that cannot be undone. Those are held until the",
  "person approves them, and you will be told so in the tool result. When that",
  "happens, say plainly what you were trying to do and why, and wait. Do not",
  "look for another tool that achieves the same thing without being held --",
  "that is the one thing you must never do here.",
  "",
  "You can ask what changed and offer to put it back: the synartesis tools",
  "read the same records the person can. Before undoing anything, preview it",
  "and tell them what it will do.",
  "",
  "Be concrete about what you did. 'I updated the file' is less useful than",
  "naming the file and what changed in it.",
].join("\n");

export interface ConversationOptions {
  /**
   * The engine this conversation is talking through right now.
   *
   * A function rather than a value because it changes. One engine holds one
   * journal session and one set of running servers, and only the conversation
   * being looked at gets to hold them -- so reopening an old conversation
   * hands it a new engine, and a new session, while the old sessions stay
   * exactly where they are and stay reversible.
   */
  readonly engine: () => Engine;
  /**
   * Every session this conversation has written to, oldest first. More than
   * one once it has been reopened, which is why the summary adds them up.
   */
  readonly sessions: string[];
  readonly emit: (event: SessionEvent) => void;
  /** Its id, when it is being picked back up rather than started. */
  readonly id?: string;
  /** Its title and transcript, likewise. */
  readonly title?: string;
  readonly messages?: readonly ChatMessage[];
  /** Named so a test can make a transcript that does not move. */
  readonly newId?: () => string;
}

/** A title taken from the first thing the person said, not asked for. */
function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 58 ? `${line.slice(0, 57)}…` : line === "" ? "Untitled" : line;
}

export class Conversation {
  readonly id: string;
  #title = "New conversation";
  #history: Exchange[] = [];
  #messages: ChatMessage[] = [];
  #stopping: AbortController | undefined;
  readonly #newId: () => string;

  constructor(private readonly options: ConversationOptions) {
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.id = options.id ?? this.#newId();
    if (options.title !== undefined) {
      this.#title = options.title;
    }
    // Copied, not adopted: what is handed in belongs to whoever stored it, and
    // a turn appended to their array would edit a record they still hold.
    this.#messages = (options.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      calls: [...message.calls],
    }));
  }

  get title(): string {
    return this.#title;
  }

  get engine(): Engine {
    return this.options.engine();
  }

  /** Every journal session this conversation has written to. */
  get sessions(): readonly string[] {
    return this.options.sessions;
  }

  /**
   * Another session, because it has been picked back up.
   *
   * Appended rather than replacing: the older sessions are still in the
   * journal, still summarised, and still reversible. Forgetting them here
   * would be telling the person that work is gone when it is not.
   */
  addSession(id: string): void {
    this.options.sessions.push(id);
  }

  get messages(): readonly ChatMessage[] {
    return this.#messages;
  }

  /**
   * What this conversation has done, from the journal alone.
   *
   * Cheap on purpose. It is recomputed after every turn, and a version that
   * read the world each time would make an ordinary conversation cost a stream
   * of upstream calls nobody asked for. Whether these records still match
   * reality is a different question, asked deliberately.
   */
  summary(): ChangeSummary {
    const journal = this.options.engine().journal;
    const actions = this.options.sessions.flatMap((session) => journal.getActions(session));
    let touched = 0;
    let recoverable = 0;
    let held = 0;
    for (const action of actions) {
      if (action.class === "readonly") {
        continue;
      }
      // Waiting for an answer, or refused -- and silence counts as refused,
      // which is the library's rule and the right one. Either way the model
      // tried to do something and it did not happen.
      if (action.status === "gated" || action.status === "denied") {
        held += 1;
        continue;
      }
      if (action.status !== "applied" && action.status !== "unrecoverable") {
        continue;
      }
      touched += 1;
      // `unrecoverable` is the case where it landed and the way back did not:
      // counted as changed, never as recoverable, whatever is in the column.
      if (action.status === "applied" && action.inverse !== undefined && action.inverse !== null) {
        recoverable += 1;
      }
    }
    return { sessionId: this.options.engine().runId, touched, recoverable, held };
  }

  /**
   * What the journal made of a call, found by looking for it afterwards.
   *
   * The proxy does not know the provider's id for a call -- it never sees one
   * -- so the two are matched by being the newest record of that tool. The
   * agent runs calls one at a time for reasons of its own, which happens to
   * make "newest" exact rather than merely likely.
   */
  #recorded(server: string, tool: string, from: number): Recorded | undefined {
    const engine = this.options.engine();
    const actions = engine.journal.getActions(engine.runId);
    for (let at = actions.length - 1; at >= from; at -= 1) {
      const action = actions[at];
      if (action !== undefined && action.tool === tool && action.server === server) {
        return {
          class: action.class,
          status: action.status,
          reversible: action.inverse !== undefined && action.inverse !== null,
        };
      }
    }
    return undefined;
  }

  stop(): void {
    this.#stopping?.abort();
  }

  async send(text: string, provider: Provider, reasoning: Reasoning): Promise<void> {
    if (this.#messages.length === 0) {
      this.#title = titleFrom(text);
    }
    this.#messages.push({ id: this.#newId(), role: "you", text, calls: [] });

    /**
     * Every event goes to the window and into the stored transcript, through
     * the same fold. A reopened conversation therefore reads exactly as it did
     * while it was happening, rather than as a second account of it.
     */
    const emit = (event: SessionEvent): void => {
      this.#messages = fold(this.#messages, event);
      this.options.emit(event);
    };

    const controller = new AbortController();
    this.#stopping = controller;
    const engine = this.options.engine();
    const before = engine.journal.getActions(engine.runId).length;

    try {
      this.#history = [
        ...(await run({
          engine,
          provider,
          reasoning,
          system: SYSTEM,
          history: this.#history,
          say: text,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.kind === "text" && event.text !== undefined) {
              emit({ kind: "text", chunk: event.text });
              return;
            }
            if (event.kind === "call" && event.call !== undefined) {
              emit({
                kind: "call",
                call: {
                  id: event.call.id,
                  name: event.call.name,
                  args: event.call.args,
                  state: "running",
                },
              });
              return;
            }
            if (event.kind === "result" && event.call !== undefined && event.result !== undefined) {
              const [server, tool] = split(event.call.name);
              const found = this.#recorded(server, tool, before);
              emit({
                kind: "result",
                call: {
                  id: event.call.id,
                  name: event.call.name,
                  args: event.call.args,
                  state: event.result.failed ? "failed" : "done",
                  result: event.result.text,
                  ...(found === undefined ? {} : { recorded: found }),
                },
              });
              return;
            }
            if (event.kind === "stopped" && event.why !== undefined) {
              emit({ kind: "stopped", why: event.why });
            }
          },
        })),
      ];
    } catch (error: unknown) {
      // A provider that refused, a server that is not running, a key that has
      // expired. The person gets the sentence the thing itself produced,
      // because a generic failure here is indistinguishable from a model that
      // simply had nothing to say.
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: "error", message });
    } finally {
      this.#stopping = undefined;
      this.options.emit({ kind: "turn-done", summary: this.summary() });
    }
  }
}

/**
 * A qualified tool name, split back into the server and the tool.
 *
 * The proxy joins them with a doubled underscore whenever it fronts more than
 * one server, which this app always does. A name with no separator belongs to
 * whichever single server there is, and the server half is left empty rather
 * than guessed.
 */
export function split(name: string): [string, string] {
  const at = name.indexOf(SEPARATOR);
  return at === -1 ? ["", name] : [name.slice(0, at), name.slice(at + SEPARATOR.length)];
}
