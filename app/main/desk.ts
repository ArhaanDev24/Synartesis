import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Signed, signInWithGoogle } from "./account.js";
import { Conversation } from "./conversation.js";
import { startEngine, type Engine } from "./engine.js";
import { openJournal } from "../../src/journal/journal.js";
import { Library, type SecretStore } from "./settings.js";
import { touchedUnder } from "./touched.js";
import { inspect, tally, verdict } from "../../src/rollback/inspect.js";
import { rollback } from "../../src/rollback/rollback.js";
import type {
  ChatMessage,
  ConversationSummary,
  FolderReport,
  OpenConversation,
  Reasoning,
  SessionEvent,
  Settings,
  Theme,
} from "../shared/ipc.js";

/**
 * Everything the window is a view of.
 *
 * Conversations, which model is in use, which one is open, and the single
 * running engine behind it. No Electron: a window is how a person looks at
 * this, and the two are worth keeping apart -- what a turn does and what the
 * person is told afterwards are testable, and a window is not.
 *
 * One engine at a time, on purpose. An engine holds a journal session and a
 * set of running MCP servers, and keeping one per open conversation would mean
 * a copy of every server the person has configured for every conversation they
 * have ever had.
 */

export interface DeskOptions {
  readonly manifestPath: string;
  readonly journalPath: string;
  readonly settingsPath: string;
  readonly conversationsPath: string;
  readonly accountPath: string;
  readonly secrets: SecretStore;
  readonly emit: (conversationId: string, event: SessionEvent) => void;
  /**
   * The OAuth client id and a way to reach the person's browser. Absent in a
   * build that has neither, where signing in is simply not offered.
   */
  readonly google?: { readonly clientId: string; readonly open: (url: string) => void };
  /** How long a held call waits for a person before it gives up. */
  readonly gateTimeoutMs?: number;
}

interface StoredConversation {
  readonly id: string;
  readonly title: string;
  readonly startedAt: number;
  readonly sessions: string[];
  readonly messages: ChatMessage[];
  readonly pinned: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConversations(path: string): StoredConversation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const kept: StoredConversation[] = [];
  for (const one of parsed) {
    if (!isRecord(one)) continue;
    const { id, title, startedAt, sessions, messages } = one;
    if (typeof id !== "string" || !Array.isArray(sessions)) continue;
    kept.push({
      id,
      title: typeof title === "string" ? title : "Untitled",
      startedAt: typeof startedAt === "number" ? startedAt : Date.now(),
      sessions: sessions.filter((session): session is string => typeof session === "string"),
      // The transcript is display only -- what actually happened lives in the
      // journal -- so a message that does not survive the trip costs a line
      // of history, not the ability to undo anything.
      messages: Array.isArray(messages) ? messages.filter(isChatMessage) : [],
      pinned: one["pinned"] === true,
    });
  }
  return kept;
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["text"] === "string" &&
    (value["role"] === "you" || value["role"] === "model" || value["role"] === "note") &&
    Array.isArray(value["calls"])
  );
}

export class Desk {
  #live: { conversation: Conversation; engine: Engine } | undefined;
  /** Everything, open or not, newest last. */
  #stored: StoredConversation[];

  readonly #signed: Signed;

  private constructor(
    private readonly options: DeskOptions,
    private readonly library: Library,
    stored: StoredConversation[],
  ) {
    this.#stored = stored;
    this.#signed = new Signed(options.accountPath, options.secrets);
  }

  static open(options: DeskOptions): Desk {
    return new Desk(
      options,
      Library.open(options.settingsPath, options.secrets),
      readConversations(options.conversationsPath),
    );
  }

  settings(): Settings {
    const who = this.#signed.who;
    return {
      ...this.library.view(),
      ...(who === undefined ? {} : { account: who }),
      canSignIn: this.options.google !== undefined,
    };
  }

  /**
   * Sign in, so the journal can name whoever approves things.
   *
   * That is all it does. There is no server, nothing syncs, and every feature
   * works exactly as well signed out -- which is why this is never asked for
   * and never in the way.
   */
  async signIn(): Promise<Settings> {
    const google = this.options.google;
    if (google === undefined) {
      throw new Error(
        "This build has no Google client id, so it cannot sign anyone in. " +
          "Set SYNARTESIS_GOOGLE_CLIENT_ID and restart.",
      );
    }
    this.#signed.keep(
      await signInWithGoogle({ clientId: google.clientId, open: google.open }),
    );
    return this.settings();
  }

  signOut(): Settings {
    this.#signed.forget();
    return this.settings();
  }

  chooseModel(id: string): Settings {
    this.library.choose(id);
    return this.settings();
  }

  setReasoning(reasoning: Reasoning): Settings {
    this.library.setReasoning(reasoning);
    return this.settings();
  }

  setTheme(theme: Theme): Settings {
    this.library.setTheme(theme);
    return this.settings();
  }

  /** Asked before the window is made, so it opens on the right ground. */
  theme(): Theme {
    return this.library.theme();
  }

  saveKey(id: string, key: string): Settings {
    this.library.saveKey(id, key);
    return this.settings();
  }

  forgetKey(id: string): Settings {
    this.library.forgetKey(id);
    return this.settings();
  }

  /** Newest first, with anything pinned held above it. */
  conversations(): readonly ConversationSummary[] {
    const rows = [...this.#stored].reverse().map((one) => ({
      id: one.id,
      title: one.title,
      startedAt: one.startedAt,
      sessionId: one.sessions[one.sessions.length - 1] ?? "",
      pinned: one.pinned,
    }));
    return [...rows.filter((one) => one.pinned), ...rows.filter((one) => !one.pinned)];
  }

  setPinned(id: string, pinned: boolean): readonly ConversationSummary[] {
    const at = this.#stored.findIndex((one) => one.id === id);
    const row = this.#stored[at];
    if (row !== undefined) {
      this.#stored[at] = { ...row, pinned };
      this.#write();
    }
    return this.conversations();
  }

  /**
   * Forget a conversation.
   *
   * The transcript goes; the journal does not. What an agent changed is a
   * record, and a record that disappears because somebody tidied their chat
   * list is not a record -- the sessions stay, and `synartesis undo <id>` can
   * still put any of it back. The window says so before it asks.
   */
  async forget(id: string): Promise<readonly ConversationSummary[]> {
    if (this.#live?.conversation.id === id) {
      const live = this.#live;
      this.#live = undefined;
      await live.engine.close();
    }
    this.#stored = this.#stored.filter((one) => one.id !== id);
    this.#write();
    return this.conversations();
  }

  /**
   * What has happened to the files under a folder.
   *
   * Any engine's journal will do -- they all share one -- so this works even
   * with no conversation open, which is most of the point: somebody wanting to
   * know what happened to a directory should not have to start a chat first.
   */
  folder(path: string): FolderReport {
    const journal = this.#live?.engine.journal ?? openJournal(this.options.journalPath);
    try {
      return { folder: path, files: touchedUnder(journal, path) };
    } finally {
      if (this.#live === undefined) {
        journal.close();
      }
    }
  }

  /**
   * An engine, running, with a session of its own.
   *
   * The approval callback is the whole of the approvals experience: the
   * journal gate waits for a decision rather than refusing, so a held call
   * parks here, raises a card in the window, and continues the instant
   * somebody answers. That is a thing a window can do and a terminal cannot.
   */
  async #startEngine(conversationId: string): Promise<Engine> {
    return startEngine({
      manifestPath: this.options.manifestPath,
      journalPath: this.options.journalPath,
      label: "synartesis desktop",
      ...(this.options.gateTimeoutMs === undefined
        ? {}
        : { gateTimeoutMs: this.options.gateTimeoutMs }),
      onApprovalNeeded: (request) => {
        this.options.emit(conversationId, {
          kind: "approval",
          request: {
            actionId: request.actionId,
            server: request.server,
            tool: request.tool,
            reason: request.why,
            args: isRecord(request.args) ? request.args : {},
          },
        });
      },
    });
  }

  async #leave(): Promise<void> {
    const live = this.#live;
    this.#live = undefined;
    if (live !== undefined) {
      this.#remember(live.conversation);
      await live.engine.close();
    }
  }

  /**
   * A conversation, with an engine of its own started underneath it.
   *
   * The id comes first because the approval callback is addressed to it, and
   * the engine is filled in afterwards -- the two need each other, and this is
   * the order that does not require either to exist before the other.
   */
  async #bring(
    id: string,
    was: { title: string; messages: readonly ChatMessage[]; sessions: string[] } | undefined,
  ): Promise<Conversation> {
    await this.#leave();
    const held: { engine?: Engine } = {};
    const conversation = new Conversation({
      id,
      engine: () => {
        if (held.engine === undefined) {
          throw new Error("the engine is not running");
        }
        return held.engine;
      },
      // Carried forward, so what an older session did is still summarised and
      // still reversible after this one is picked back up.
      sessions: was === undefined ? [] : [...was.sessions],
      ...(was === undefined ? {} : { title: was.title, messages: was.messages }),
      emit: (event) => {
        this.options.emit(id, event);
      },
    });
    const engine = await this.#startEngine(id);
    held.engine = engine;
    conversation.addSession(engine.runId);
    this.#live = { conversation, engine };
    this.#remember(conversation);
    return conversation;
  }

  async start(): Promise<OpenConversation> {
    return this.#view(await this.#bring(randomUUID(), undefined));
  }

  async open(id: string): Promise<OpenConversation> {
    if (this.#live?.conversation.id === id) {
      return this.#view(this.#live.conversation);
    }
    const stored = this.#stored.find((one) => one.id === id);
    if (stored === undefined) {
      throw new Error("That conversation is gone.");
    }
    return this.#view(
      await this.#bring(id, {
        title: stored.title,
        messages: stored.messages,
        sessions: stored.sessions,
      }),
    );
  }

  async send(id: string, text: string): Promise<void> {
    const live = this.#live;
    if (live === undefined || live.conversation.id !== id) {
      throw new Error("That conversation is not open.");
    }
    // Built per turn rather than held, so a model or a key changed in the
    // settings pane takes effect on the next thing said rather than on the
    // next restart.
    const provider = this.library.provider();
    await live.conversation.send(text, provider, this.library.reasoning());
    this.#remember(live.conversation);
  }

  stop(id: string): void {
    if (this.#live?.conversation.id === id) {
      this.#live.conversation.stop();
    }
  }

  /**
   * Let it through, in somebody's name.
   *
   * The journal keeps who approved what, and that is the record anybody will
   * read afterwards. Signed out it says "you", which is honest and useless;
   * signed in it says who.
   */
  approve(actionId: string): void {
    this.#journal().approve(actionId, this.#signed.actor);
    this.#announce(actionId);
  }

  deny(actionId: string, why: string): void {
    this.#journal().deny(actionId, this.#signed.actor, why);
    this.#announce(actionId);
  }

  #announce(actionId: string): void {
    if (this.#live !== undefined) {
      this.options.emit(this.#live.conversation.id, { kind: "approval-resolved", actionId });
    }
  }

  #journal(): Engine["journal"] {
    if (this.#live === undefined) {
      throw new Error("Nothing is running.");
    }
    return this.#live.engine.journal;
  }

  #open(id: string): { conversation: Conversation; engine: Engine } {
    if (this.#live === undefined || this.#live.conversation.id !== id) {
      throw new Error("That conversation is not open.");
    }
    return this.#live;
  }

  /**
   * A real read of everything the conversation touched.
   *
   * Deliberate and asked for, never automatic: this costs one upstream call
   * per resource, and a chat window that quietly did it after every turn would
   * be spending the person's rate limit to answer a question they had not
   * asked.
   */
  async verify(id: string): Promise<string> {
    const { conversation, engine } = this.#open(id);
    const parts: string[] = [];
    for (const session of conversation.sessions) {
      const seen = await inspect({ journal: engine.journal, router: engine.router, runId: session });
      if (seen.resources.length === 0) {
        continue;
      }
      const counted = tally(seen);
      parts.push(
        `${verdict(seen)}\n\nunchanged ${String(counted.unchanged)} · changed ${String(counted.changed)} · ` +
          `restored ${String(counted.restored)} · unknown ${String(counted.unknowable)}`,
      );
    }
    return parts.length === 0 ? "Nothing was changed in this conversation." : parts.join("\n\n");
  }

  async previewUndo(id: string): Promise<string> {
    const { conversation, engine } = this.#open(id);
    const lines: string[] = [];
    for (const session of [...conversation.sessions].reverse()) {
      const plan = await rollback({
        journal: engine.journal,
        router: engine.router,
        runId: session,
        dryRun: true,
      });
      for (const step of plan.steps) {
        lines.push(`${step.kind} · ${step.server}.${step.tool} · ${step.reason}`);
      }
      if (plan.halted !== undefined) {
        lines.push(`It would stop at step ${String(plan.halted.seq)}: ${plan.halted.reason}`);
      }
    }
    return lines.length === 0 ? "There is nothing to put back." : lines.join("\n");
  }

  /**
   * Put it back.
   *
   * Newest session first, and each one newest action first, which is the only
   * order in which one change undoing another comes out right. No force: if
   * somebody has edited something since, this stops and says so, and what to
   * do about that is a decision a person makes in front of the difference.
   */
  async undo(id: string): Promise<string> {
    const { conversation, engine } = this.#open(id);
    const lines: string[] = [];
    for (const session of [...conversation.sessions].reverse()) {
      const report = await rollback({
        journal: engine.journal,
        router: engine.router,
        runId: session,
      });
      const reverted = report.steps.filter((step) => step.kind === "revert").length;
      lines.push(`${report.status} · ${String(reverted)} put back`);
      if (report.halted !== undefined) {
        lines.push(
          `It stopped at step ${String(report.halted.seq)}: ${report.halted.reason}`,
          "Everything newer than that was put back. The rest is yours to decide.",
        );
        break;
      }
    }
    this.options.emit(id, { kind: "turn-done", summary: conversation.summary() });
    return lines.join("\n");
  }

  #view(conversation: Conversation): OpenConversation {
    return {
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages,
      summary: conversation.summary(),
    };
  }

  #remember(conversation: Conversation): void {
    const at = this.#stored.findIndex((one) => one.id === conversation.id);
    const row: StoredConversation = {
      id: conversation.id,
      title: conversation.title,
      startedAt: this.#stored[at]?.startedAt ?? Date.now(),
      sessions: [...conversation.sessions],
      messages: [...conversation.messages],
      pinned: this.#stored[at]?.pinned ?? false,
    };
    if (at === -1) this.#stored.push(row);
    else this.#stored[at] = row;
    this.#write();
  }

  #write(): void {
    const path = this.options.conversationsPath;
    mkdirSync(dirname(path), { recursive: true });
    // Beside and moved into place: a crash mid-write would otherwise leave a
    // truncated file, and the next start would find nonsense where the
    // person's history used to be.
    const beside = `${path}.writing`;
    writeFileSync(beside, JSON.stringify(this.#stored, null, 2), { mode: 0o600 });
    renameSync(beside, path);
  }

  async close(): Promise<void> {
    await this.#leave();
  }
}
