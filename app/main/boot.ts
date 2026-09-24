import type { Desk } from "./desk.js";
import type { Reasoning, Theme } from "../shared/ipc.js";

/**
 * Everything after the window is ready, with no Electron in it.
 *
 * This lived inside main(), which drew a window for the no-policy case and
 * then returned -- before the IPC handlers were registered and before the
 * quit handlers were attached. On macOS that is invisible, because closing a
 * window there does not end the application anyway. On Windows and Linux it
 * left a process running with no window and no way to stop it.
 *
 * Copying the lifecycle block into the early return would have fixed that
 * case and set the next one up: there would be two copies of the `leaving`
 * latch, and the next hook would be added to one of them. So there is one
 * path instead, taking a desk that may not exist.
 *
 * The seam is here for a second reason. The key-page allowlist below is the
 * one piece of this file that decides whether a window may open an address
 * somebody else's text named, and until it could be called without starting
 * Electron, nothing tested it.
 */
export interface Host {
  readonly platform: NodeJS.Platform;
  on(event: "activate" | "window-all-closed" | "before-quit", listener: (event: LifecycleEvent) => void): void;
  quit(): void;
  /** How many windows are open, for `activate` on macOS. */
  windowCount(): number;
  openWindow(theme: Theme | undefined): void;
  handle(channel: string, answer: (...args: unknown[]) => Promise<unknown>): void;
  openExternal(url: string): void;
  /** The operating system's folder picker. The renderer has no filesystem. */
  pickFolder(): Promise<string | undefined>;
}

export interface LifecycleEvent {
  preventDefault(): void;
}

/**
 * What the window is told before it asks anything else.
 *
 * Main decides; the window waits. It used to be a push -- a `no-manifest`
 * message sent on did-finish-load -- which arrives strictly after React has
 * mounted and already asked two questions, so with no policy the person saw
 * two "No handler registered" errors before the screen explaining the real
 * situation replaced them.
 */
export type Startup =
  | { readonly kind: "ready" }
  | { readonly kind: "no-policy"; readonly manifestPath: string };

const NO_POLICY =
  "There is no policy yet. Run `synartesis init` in a terminal, then reopen this window.";

/**
 * The desk, or a sentence a person can act on.
 *
 * Every channel is registered either way, from one map, so the two paths
 * cannot come to disagree about which channels exist -- which is what went
 * wrong: on the no-policy path none of them were registered at all, and the
 * window met Electron's "No handler registered for 'settings:get'".
 */
function need(desk: Desk | undefined): Desk {
  if (desk === undefined) {
    throw new Error(NO_POLICY);
  }
  return desk;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected text");
  }
  return value;
}

function asTheme(value: unknown): Theme {
  if (value === "light" || value === "dark") {
    return value;
  }
  throw new Error("expected light or dark");
}

function asReasoning(value: unknown): Reasoning {
  if (value === "brief" || value === "balanced" || value === "thorough") {
    return value;
  }
  throw new Error("expected brief, balanced or thorough");
}

/** Every call from the window, in one place, so none of them is implicit. */
export function answersFor(
  host: Host,
  desk: Desk | undefined,
  manifestPath: string,
): Record<string, (...args: unknown[]) => unknown> {
  return {
    "app:start": (): Startup =>
      desk === undefined ? { kind: "no-policy", manifestPath } : { kind: "ready" },

    "settings:get": () => need(desk).settings(),
    "settings:choose": (id) => need(desk).chooseModel(asString(id)),
    "settings:reasoning": (reasoning) => need(desk).setReasoning(asReasoning(reasoning)),
    "settings:theme": (theme) => need(desk).setTheme(asTheme(theme)),
    "settings:set-model": (id, model) => need(desk).setModel(asString(id), asString(model)),
    "settings:save-key": (id, key) => need(desk).saveKey(asString(id), asString(key)),
    "settings:forget-key": (id) => need(desk).forgetKey(asString(id)),

    /**
     * Open a provider's key page in the person's browser.
     *
     * Checked against the addresses the models themselves name, not taken on
     * trust. A bridge that opened whatever the page asked for would be a way
     * to make this window launch anything, and this is a window that renders
     * text somebody else wrote.
     */
    "open:key-page": (url) => {
      const asked = asString(url);
      const allowed = need(desk)
        .settings()
        .models.map((model) => model.keyUrl)
        .filter((known): known is string => known !== undefined);
      if (!allowed.includes(asked)) {
        throw new Error("That is not one of the providers' key pages.");
      }
      host.openExternal(asked);
    },
    "account:sign-in": () => need(desk).signIn(),
    "account:sign-out": () => need(desk).signOut(),

    "chat:list": () => need(desk).conversations(),
    "chat:pin": (id, pinned) => need(desk).setPinned(asString(id), pinned === true),
    "chat:forget": (id) => need(desk).forget(asString(id)),
    "chat:start": () => need(desk).start(),
    "chat:open": (id) => need(desk).open(asString(id)),
    "chat:send": (id, text) => need(desk).send(asString(id), asString(text)),
    "chat:stop": (id) => {
      need(desk).stop(asString(id));
    },

    "gate:approve": (actionId) => {
      need(desk).approve(asString(actionId));
    },
    "gate:approve-hour": (actionId) => {
      need(desk).approve(asString(actionId), { forAnHour: true });
    },
    "gate:deny": (actionId, why) => {
      need(desk).deny(asString(actionId), asString(why));
    },

    "folder:choose": async () => await host.pickFolder(),
    "folder:report": (path) => need(desk).folder(asString(path)),

    "undo:verify": (id) => need(desk).verify(asString(id)),
    "undo:preview": (id) => need(desk).previewUndo(asString(id)),
    "undo:do": (id) => need(desk).undo(asString(id)),
  };
}

export function boot(host: Host, desk: Desk | undefined, manifestPath: string): void {
  for (const [channel, answer] of Object.entries(answersFor(host, desk, manifestPath))) {
    host.handle(channel, async (...args: unknown[]) => {
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

  host.openWindow(desk?.theme());

  host.on("activate", () => {
    if (host.windowCount() === 0) {
      host.openWindow(desk?.theme());
    }
  });

  // A desk with nothing to put away is still a desk, so this reads the same
  // either way rather than branching on whether one exists.
  const close = async (): Promise<void> => {
    await desk?.close();
  };

  host.on("window-all-closed", () => {
    void close().finally(() => {
      if (host.platform !== "darwin") {
        host.quit();
      }
    });
  });

  /*
   * Quit, but not before the engine has put itself away.
   *
   * Electron does not wait for a promise handed to `before-quit`, and what is
   * left undone is not nothing: a run is finalised, an empty one is taken back
   * out of the journal, and the servers underneath are asked to stop. Quitting
   * over the top of that left a row behind every time. So the first quit is
   * held, the close is awaited, and the second one -- ours -- goes through.
   */
  let leaving = false;
  host.on("before-quit", (event) => {
    if (leaving) {
      return;
    }
    leaving = true;
    event.preventDefault();
    void close().finally(() => {
      host.quit();
    });
  });
}
