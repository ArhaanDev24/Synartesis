import type {
  ConversationSummary,
  FolderReport,
  OpenConversation,
  Reasoning,
  SessionEvent,
  Settings,
  Theme,
} from "../shared/ipc.js";

/**
 * The engine, as the window can reach it.
 *
 * Everything crosses a process boundary as plain data, so nothing that comes
 * back can be trusted to have a shape merely because TypeScript says so. It is
 * typed here for the window's benefit; the checking that matters happens on
 * the other side, where the data is produced.
 */

export interface Bridge {
  settings(): Promise<Settings>;
  chooseModel(id: string): Promise<Settings>;
  setReasoning(reasoning: Reasoning): Promise<Settings>;
  setTheme(theme: Theme): Promise<Settings>;
  saveKey(id: string, key: string): Promise<Settings>;
  forgetKey(id: string): Promise<Settings>;
  openKeyPage(url: string): Promise<void>;
  signIn(): Promise<Settings>;
  signOut(): Promise<Settings>;

  conversations(): Promise<readonly ConversationSummary[]>;
  setPinned(id: string, pinned: boolean): Promise<readonly ConversationSummary[]>;
  forget(id: string): Promise<readonly ConversationSummary[]>;
  chooseFolder(): Promise<string | undefined>;
  folder(path: string): Promise<FolderReport>;
  start(): Promise<OpenConversation>;
  open(id: string): Promise<OpenConversation>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;

  approve(actionId: string): Promise<void>;
  deny(actionId: string, why: string): Promise<void>;

  verify(id: string): Promise<string>;
  previewUndo(id: string): Promise<string>;
  undo(id: string): Promise<string>;

  onEvent(listener: (id: string, event: SessionEvent) => void): () => void;
  onNoManifest(listener: (path: string) => void): () => void;
}

declare global {
  interface Window {
    readonly synartesis: Bridge;
  }
}

export const engine: Bridge = window.synartesis;
