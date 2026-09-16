import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";

import { boot, type Host } from "./boot.js";
import { Desk } from "./desk.js";
import type { SecretStore } from "./settings.js";
import { home, JOURNAL_NAME, MANIFEST_NAME } from "../../src/locate.js";
import type { SessionEvent, Theme } from "../shared/ipc.js";

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

/**
 * The ground the frame paints before the page has drawn anything.
 *
 * Read from the stored preference rather than fixed, because a window that
 * flashes oxblood and then turns parchment is a window that looks broken for
 * a third of a second on every launch.
 */
const GROUND: Record<Theme, string> = { light: "#f4ece5", dark: "#5e1420" };

function makeWindow(theme: Theme = "light"): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: GROUND[theme],
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

/** Electron, as boot.ts needs it and no more. */
const host: Host = {
  platform: process.platform,
  // One branch per event: Electron types `app.on` with a separate overload
  // per event name, so a union of names matches none of them.
  on: (event, listener) => {
    if (event === "activate") {
      app.on("activate", () => {
        listener({ preventDefault: () => undefined });
      });
      return;
    }
    if (event === "window-all-closed") {
      app.on("window-all-closed", () => {
        listener({ preventDefault: () => undefined });
      });
      return;
    }
    app.on("before-quit", (quitting) => {
      listener(quitting);
    });
  },
  quit: () => {
    app.quit();
  },
  windowCount: () => BrowserWindow.getAllWindows().length,
  openWindow: (theme) => {
    makeWindow(theme);
  },
  handle: (channel, answer) => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => await answer(...args));
  },
  openExternal: (url) => {
    void shell.openExternal(url);
  },
  pickFolder: async () => {
    const window = BrowserWindow.getAllWindows()[0];
    const picked = await (window === undefined
      ? dialog.showOpenDialog({ properties: ["openDirectory"] })
      : dialog.showOpenDialog(window, { properties: ["openDirectory"] }));
    return picked.canceled ? undefined : picked.filePaths[0];
  },
};

async function main(): Promise<void> {
  // Before anything asks for a path: userData is derived from the name, and a
  // window that quietly stored a person's conversations under "Electron" would
  // lose them the moment this is packaged properly.
  app.setName("Synartesis");
  await app.whenReady();
  const { manifestPath, journalPath } = places();

  // Nothing here can guess which servers a person wants guarded, and a
  // manifest invented on their behalf would be a policy they never wrote
  // governing tools they never listed. So with no policy there is no desk --
  // and boot still runs, because the window still has to be able to close.
  const desk = existsSync(manifestPath)
    ? Desk.open({
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
      })
    : undefined;

  boot(host, desk, manifestPath);
}

void main();
