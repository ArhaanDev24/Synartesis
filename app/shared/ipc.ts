import type { ProviderConfig, Reasoning } from "../providers/index.js";

/**
 * What the window and the engine say to each other.
 *
 * Type-only, and imported by both sides, so a channel cannot be renamed in one
 * process and left alone in the other. The renderer never sees the journal, a
 * router, or a provider -- it sees these, which are all plain data and all
 * safe to send across a bridge.
 */

export type { ProviderConfig, Reasoning };

/** One tool call, as the window draws it. */
export interface CallCard {
  readonly id: string;
  /** Qualified, as the model sees it: `fs__write_file`. */
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly state: "running" | "done" | "failed";
  readonly result?: string;
  /**
   * What Synartesis made of it, once it has been through the proxy. Absent
   * while the call is in flight, and absent afterwards only if the call never
   * reached the journal -- which is itself worth showing.
   */
  readonly recorded?: Recorded;
}

export interface Recorded {
  /** readonly · reversible · compensable · irreversible. */
  readonly class: string;
  readonly status: string;
  /** Whether the state it replaced was captured, which is what undo needs. */
  readonly reversible: boolean;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "you" | "model" | "note";
  readonly text: string;
  readonly calls: readonly CallCard[];
}

/**
 * The standing answer to "what has this conversation done?".
 *
 * Read from the journal, not from the world: it is recomputed after every turn
 * and must not cost an upstream read each time. Checking whether those records
 * still match reality is a separate, deliberate act.
 */
export interface ChangeSummary {
  readonly sessionId: string;
  /** Changes that actually landed. */
  readonly touched: number;
  /** Of those, the ones whose prior state was captured. */
  readonly recoverable: number;
  /**
   * Calls that were asked about and did not happen -- waiting for an answer
   * right now, or refused, including refused by nobody being there. Worth its
   * own number: the person should be told the model tried and was stopped,
   * rather than discovering later that something they asked for was not done.
   */
  readonly held: number;
}

/** A call the proxy is holding. Nothing happens until somebody answers. */
export interface ApprovalCard {
  readonly actionId: string;
  readonly server: string;
  readonly tool: string;
  readonly reason: string;
  readonly args: Record<string, unknown>;
}

export type SessionEvent =
  | { readonly kind: "text"; readonly chunk: string }
  | { readonly kind: "call"; readonly call: CallCard }
  | { readonly kind: "result"; readonly call: CallCard }
  | { readonly kind: "turn-done"; readonly summary: ChangeSummary }
  | { readonly kind: "stopped"; readonly why: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "approval"; readonly request: ApprovalCard }
  | { readonly kind: "approval-resolved"; readonly actionId: string };

/** A model the person has set up, as the picker shows it. */
export interface ModelChoice {
  readonly id: string;
  readonly name: string;
  readonly config: ProviderConfig;
  readonly needsKey: boolean;
  readonly note: string;
  /** Whether a key is on file. Never the key itself. */
  readonly hasKey: boolean;
  /** Whether the thinking control reaches anything on this one. */
  readonly thinks: boolean;
}

export interface Settings {
  readonly models: readonly ModelChoice[];
  readonly chosen?: string;
  readonly reasoning: Reasoning;
  /** False when the OS has no keychain, so the window can say why. */
  readonly canKeepSecrets: boolean;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly startedAt: number;
  readonly sessionId: string;
}

export interface OpenConversation {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly ChatMessage[];
  readonly summary: ChangeSummary;
}

/** What the preload puts on the window. Implemented in main, called in the UI. */
export interface Bridge {
  settings(): Promise<Settings>;
  chooseModel(id: string): Promise<Settings>;
  setReasoning(reasoning: Reasoning): Promise<Settings>;
  /** The key goes straight to the OS keychain and is never read back out. */
  saveKey(id: string, key: string): Promise<Settings>;
  forgetKey(id: string): Promise<Settings>;

  conversations(): Promise<readonly ConversationSummary[]>;
  open(id: string): Promise<OpenConversation>;
  start(): Promise<OpenConversation>;

  send(id: string, text: string): Promise<void>;
  stop(id: string): void;

  approve(actionId: string): Promise<void>;
  deny(actionId: string, why: string): Promise<void>;

  /** A real read of every resource the session touched. Costs upstream calls. */
  verify(id: string): Promise<string>;
  /** Plan the undo. Changes nothing. */
  previewUndo(id: string): Promise<string>;
  /** Do it. The window asks twice before calling this. */
  undo(id: string): Promise<string>;

  onEvent(listener: (id: string, event: SessionEvent) => void): () => void;
}
