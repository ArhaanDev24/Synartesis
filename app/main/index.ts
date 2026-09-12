import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";

import { Desk } from "./desk.js";
import type { SecretStore } from "./settings.js";
import { home, JOURNAL_NAME, MANIFEST_NAME } from "../../src/locate.js";
import type { Reasoning, SessionEvent } from "../shared/ipc.js";

/**
 * The window, and nothing else.
 *
 * Everything interesting is in `desk.ts`, which knows nothing about Electron.
 * What is left here is the part that cannot be tested without a screen: making
 * a window, locking it down, and carrying messages between it and the desk.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const RENDERER = join(here, "../renderer/index.html");
const PRELOAD = join(here, "../preload/bridge.cjs");

/**
 * The OS keychain, or an honest refusal.
 *
 * `safeStorage` is Keychain on macOS, DPAPI on Windows, and libsecret on Linux
 * -- where it may genuinely be absent. When it is, this says so and nothing is
 * stored, rather than falling back to something weaker that looks the same
 * from the outside.
 */
const keychain: SecretStore = {
  available: () => safeStorage.isEncryptionAvailable(),
  seal: (plain) => safeStorage.encryptString(plain).toString("base64"),
  open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
};

/** Broadcast to whatever window is open. A closed one is not an error. */
function tell(id: string, event: SessionEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("session:event", id, event);
  }
}

function makeWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 540,
    // The page paints its own ground; without this the frame flashes white
    // before the first paint, which on this palette is a slap.
    backgroundColor: "#5e1420",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: PRELOAD,
      // The renderer is a view. It gets no Node, no module resolution and no
      // shared globals with the page -- only the handful of functions the
      // preload puts on the bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  // A link in a model's answer opens in the person's browser. A chat window
  // that navigates itself to a page a model produced is a chat window that can
  // be talked into loading anything.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  void window.loadFile(RENDERER);
  return window;
}

function wire(desk: Desk): void {
  /** Every call from the window, in one place, so none of them is implicit. */
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    "settings:get": () => desk.settings(),
    "settings:choose": (id) => desk.chooseModel(asString(id)),
    "settings:reasoning": (reasoning) => desk.setReasoning(asReasoning(reasoning)),
    "settings:save-key": (id, key) => desk.saveKey(asString(id), asString(key)),
    "settings:forget-key": (id) => desk.forgetKey(asString(id)),
    "account:sign-in": () => desk.signIn(),
    "account:sign-out": () => desk.signOut(),

    "chat:list": () => desk.conversations(),
    "chat:start": () => desk.start(),
    "chat:open": (id) => desk.open(asString(id)),
    "chat:send": (id, text) => desk.send(asString(id), asString(text)),
    "chat:stop": (id) => {
      desk.stop(asString(id));
    },

    "gate:approve": (actionId) => {
      desk.approve(asString(actionId));
    },
    "gate:deny": (actionId, why) => {
      desk.deny(asString(actionId), asString(why));
    },

    "undo:verify": (id) => desk.verify(asString(id)),
    "undo:preview": (id) => desk.previewUndo(asString(id)),
    "undo:do": (id) => desk.undo(asString(id)),
  };

  for (const [channel, answer] of Object.entries(answers)) {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return { ok: true, value: await answer(...args) };
      } catch (error: unknown) {
        // Sent back rather than thrown across the bridge, so the window can
        // put the sentence in front of the person instead of showing them a
        // stack trace with "Error invoking remote method" in front of it.
        return { ok: false, why: error instanceof Error ? error.message : String(error) };
      }
    });
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected text");
  }
  return value;
}

function asReasoning(value: unknown): Reasoning {
  if (value === "brief" || value === "balanced" || value === "thorough") {
    return value;
  }
  throw new Error("expected brief, balanced or thorough");
}

/**
 * The same policy and the same journal the command line uses.
 *
 * Shared on purpose: something this app did is undoable from a terminal with
 * `synartesis undo`, and something an agent did in a terminal shows up here.
 * Two journals would be two accounts of what happened.
 */
function places(): { manifestPath: string; journalPath: string } {
  const root = home();
  return { manifestPath: join(root, MANIFEST_NAME), journalPath: join(root, JOURNAL_NAME) };
}

/**
 * The OAuth client id belongs to whoever builds this, not to the source.
 *
 * One baked in here would be a client id anybody could point at their own
 * application. Absent, the window says signing in is unavailable and
 * everything else works unchanged.
 */
const clientId = process.env["SYNARTESIS_GOOGLE_CLIENT_ID"];

async function main(): Promise<void> {
  // Before anything asks for a path: userData is derived from the name, and a
  // window that quietly stored a person's conversations under "Electron" would
  // lose them the moment this is packaged properly.
  app.setName("Synartesis");
  await app.whenReady();
  const { manifestPath, journalPath } = places();

  if (!existsSync(manifestPath)) {
    // Nothing here can guess which servers a person wants guarded, and a
    // manifest invented on their behalf would be a policy they never wrote
    // governing tools they never listed.
    const window = makeWindow();
    window.webContents.once("did-finish-load", () => {
      window.webContents.send("app:no-manifest", manifestPath);
    });
    return;
  }

  const desk = Desk.open({
    manifestPath,
    journalPath,
    settingsPath: join(app.getPath("userData"), "models.json"),
    conversationsPath: join(app.getPath("userData"), "conversations.json"),
    accountPath: join(app.getPath("userData"), "account.sealed"),
    secrets: keychain,
    emit: tell,
    ...(clientId === undefined
      ? {}
      : {
          google: {
            clientId,
            // The person's own browser, never a window this application
            // draws. An application that renders a password field can read
            // what is typed into it.
            open: (url: string) => {
              void shell.openExternal(url);
            },
          },
        }),
  });
  wire(desk);
  makeWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      makeWindow();
    }
  });

  app.on("window-all-closed", () => {
    void desk.close().finally(() => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  });

  app.on("before-quit", () => {
    void desk.close();
  });
}

void main();
