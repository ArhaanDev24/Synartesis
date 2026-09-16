import { contextBridge, ipcRenderer } from "electron";

import {
  EVENT_CHANNEL,
  type Answers,
  type Bridge,
  type Reasoning,
  type SessionEvent,
  type Theme,
} from "../shared/ipc.js";

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

interface Answered<T> {
  readonly ok: true;
  readonly value: T;
}

interface Refused {
  readonly ok: false;
  readonly why?: string;
}

/**
 * Predicates, not assertions. This file is the boundary: what comes back is
 * unknown until it has been looked at, and `as` would only be TypeScript being
 * told to stop checking at exactly the point where checking is the job.
 */
function answered<T>(value: unknown): value is Answered<T> {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function refused(value: unknown): value is Refused {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

async function call<C extends keyof Answers>(
  channel: C,
  ...args: unknown[]
): Promise<Answers[C]> {
  const answer: unknown = await ipcRenderer.invoke(channel, ...args);
  if (answered<Answers[C]>(answer)) {
    return answer.value;
  }
  if (refused(answer)) {
    // Rebuilt as a real Error here so the window can catch it the ordinary
    // way, carrying the sentence the desk wrote rather than Electron's
    // wrapper.
    throw new Error(answer.why ?? "Something went wrong.");
  }
  throw new Error(`The engine answered ${channel} with something unreadable.`);
}

/**
 * Annotated, not inferred.
 *
 * With `: Bridge` on the literal, a method the interface declares and this
 * forgets is an error here, an extra one is an error here, and a wrong
 * signature is an error here -- checked by `pnpm typecheck`, which already
 * covers this directory. Inferred, as it was, nothing connected this object to
 * either interface and the three drifted apart silently.
 */
const bridge: Bridge = {
  startup: () => call("app:start"),
  settings: () => call("settings:get"),
  chooseModel: (id: string) => call("settings:choose", id),
  setReasoning: (reasoning: Reasoning) => call("settings:reasoning", reasoning),
  setTheme: (theme: Theme) => call("settings:theme", theme),
  setModel: (id: string, model: string) => call("settings:set-model", id, model),
  saveKey: (id: string, key: string) => call("settings:save-key", id, key),
  forgetKey: (id: string) => call("settings:forget-key", id),
  openKeyPage: (url: string) => call("open:key-page", url),
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

  onEvent(listener: (id: string, event: SessionEvent) => void): () => void {
    // The relay's own parameters carry the types rather than an assertion at
    // the call site: same trust either way, stated once, where the channel is
    // named.
    const relay = (_event: unknown, id: string, payload: SessionEvent): void => {
      listener(id, payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, relay);
    return () => {
      ipcRenderer.off(EVENT_CHANNEL, relay);
    };
  },
};

contextBridge.exposeInMainWorld("synartesis", bridge);
