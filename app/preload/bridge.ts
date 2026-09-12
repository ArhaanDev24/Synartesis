import { contextBridge, ipcRenderer } from "electron";

/**
 * The only way the window can reach anything.
 *
 * The renderer runs sandboxed with no Node and no module resolution, so this
 * is the whole surface: a fixed list of named calls and one event stream.
 * Nothing here takes a channel name from the page, which is the difference
 * between a bridge and a hole -- a renderer that can name its own channel can
 * reach every handler in the main process, and a chat window is a place where
 * text somebody else wrote gets rendered.
 */

interface Answer {
  ok: boolean;
  value?: unknown;
  why?: string;
}

function isAnswer(value: unknown): value is Answer {
  return typeof value === "object" && value !== null && "ok" in value;
}

async function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const answer: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isAnswer(answer)) {
    throw new Error(`The engine answered ${channel} with something unreadable.`);
  }
  if (answer.ok) {
    return answer.value;
  }
  // Rebuilt as a real Error here so the window can catch it the ordinary way,
  // carrying the sentence the desk wrote rather than Electron's wrapper.
  throw new Error(answer.why ?? "Something went wrong.");
}

const bridge = {
  settings: () => call("settings:get"),
  chooseModel: (id: string) => call("settings:choose", id),
  setReasoning: (reasoning: string) => call("settings:reasoning", reasoning),
  setTheme: (theme: string) => call("settings:theme", theme),
  saveKey: (id: string, key: string) => call("settings:save-key", id, key),
  forgetKey: (id: string) => call("settings:forget-key", id),
  signIn: () => call("account:sign-in"),
  signOut: () => call("account:sign-out"),

  conversations: () => call("chat:list"),
  setPinned: (id: string, pinned: boolean) => call("chat:pin", id, pinned),
  forget: (id: string) => call("chat:forget", id),
  chooseFolder: () => call("folder:choose"),
  folder: (path: string) => call("folder:report", path),
  start: () => call("chat:start"),
  open: (id: string) => call("chat:open", id),
  send: (id: string, text: string) => call("chat:send", id, text),
  stop: (id: string) => call("chat:stop", id),

  approve: (actionId: string) => call("gate:approve", actionId),
  deny: (actionId: string, why: string) => call("gate:deny", actionId, why),

  verify: (id: string) => call("undo:verify", id),
  previewUndo: (id: string) => call("undo:preview", id),
  undo: (id: string) => call("undo:do", id),

  onEvent(listener: (id: string, event: unknown) => void): () => void {
    const relay = (_event: unknown, id: string, payload: unknown): void => {
      listener(id, payload);
    };
    ipcRenderer.on("session:event", relay);
    return () => {
      ipcRenderer.off("session:event", relay);
    };
  },

  onNoManifest(listener: (path: string) => void): () => void {
    const relay = (_event: unknown, path: string): void => {
      listener(path);
    };
    ipcRenderer.on("app:no-manifest", relay);
    return () => {
      ipcRenderer.off("app:no-manifest", relay);
    };
  },
};

contextBridge.exposeInMainWorld("synartesis", bridge);
