/**
 * Everything after the window is ready, without Electron.
 *
 * The window with no policy used to be drawn by a branch that returned before
 * the IPC handlers were registered and before the quit handlers were attached.
 * On macOS that is invisible: closing a window there does not end the
 * application anyway. On Windows and Linux it left a process running with no
 * window and no way to stop it, and the window itself met Electron's "No
 * handler registered for 'settings:get'" for every question it asked.
 *
 * None of that was testable while it lived inside a function that needed a
 * screen. It does not any more.
 */
import { describe, expect, it } from "vitest";

import { answersFor, boot, type Host, type LifecycleEvent } from "../app/main/boot.js";

interface Fake extends Host {
  readonly registered: Map<string, (...args: unknown[]) => Promise<unknown>>;
  readonly listeners: Map<string, (event: LifecycleEvent) => void>;
  readonly opened: (string | undefined)[];
  readonly external: string[];
  quits: number;
  fire(event: string): { prevented: boolean };
  ask(channel: string, ...args: unknown[]): Promise<unknown>;
}

function host(platform: NodeJS.Platform = "linux"): Fake {
  const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const listeners = new Map<string, (event: LifecycleEvent) => void>();
  const fake: Fake = {
    platform,
    registered,
    listeners,
    opened: [],
    external: [],
    quits: 0,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    quit: () => {
      fake.quits += 1;
    },
    windowCount: () => fake.opened.length,
    openWindow: (theme) => {
      fake.opened.push(theme);
    },
    handle: (channel, answer) => {
      registered.set(channel, answer);
    },
    openExternal: (url) => {
      fake.external.push(url);
    },
    pickFolder: () => Promise.resolve(undefined),
    fire: (event) => {
      let prevented = false;
      listeners.get(event)?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      return { prevented };
    },
    ask: async (channel, ...args) => {
      const answer = registered.get(channel);
      if (answer === undefined) {
        throw new Error(`nothing registered for ${channel}`);
      }
      return await answer(...args);
    },
  };
  return fake;
}

const NOWHERE = "/nowhere/synartesis.yaml";

describe("starting with no policy", () => {
  it("still registers every channel the window can ask for", () => {
    const fake = host();
    boot(fake, undefined, NOWHERE);
    // The whole class of bug: not one of these existed, so the window's first
    // two questions came back as "No handler registered" and were drawn as
    // errors before the screen explaining the real situation replaced them.
    const expected = Object.keys(answersFor(fake, undefined, NOWHERE));
    expect([...fake.registered.keys()].sort()).toEqual(expected.sort());
    expect(expected).toContain("settings:get");
  });

  it("says which situation the window is in, rather than being asked to guess", async () => {
    const fake = host();
    boot(fake, undefined, NOWHERE);
    expect(await fake.ask("app:start")).toEqual({
      ok: true,
      value: { kind: "no-policy", manifestPath: NOWHERE },
    });
  });

  it("answers the rest with a sentence somebody can act on", async () => {
    const fake = host();
    boot(fake, undefined, NOWHERE);
    const answered = await fake.ask("settings:get");
    expect(answered).toMatchObject({ ok: false });
    // install, not init: bare `init` is a usage error, so the one sentence
    // this window had to offer sent people to a command that refused them.
    expect(JSON.stringify(answered)).toContain("synartesis install");
  });

  it("can still be quit", () => {
    const fake = host("linux");
    boot(fake, undefined, NOWHERE);
    // The defect exactly: on Windows and Linux this listener was never
    // attached, so closing the only window left the process alive.
    expect(fake.listeners.has("window-all-closed")).toBe(true);
    fake.fire("window-all-closed");
    expect(fake.listeners.has("before-quit")).toBe(true);
  });
});

describe("the quit lifecycle", () => {
  it("holds the first quit and lets the second through", () => {
    const fake = host();
    boot(fake, undefined, NOWHERE);
    // The first is held so the engine can put itself away; ours follows.
    expect(fake.fire("before-quit").prevented).toBe(true);
    expect(fake.fire("before-quit").prevented).toBe(false);
  });

  it("does not quit on macOS when the last window closes", async () => {
    const fake = host("darwin");
    boot(fake, undefined, NOWHERE);
    fake.fire("window-all-closed");
    await Promise.resolve();
    expect(fake.quits).toBe(0);
  });

  it("opens a window again when the dock icon is clicked and none is left", () => {
    const fake = host("darwin");
    boot(fake, undefined, NOWHERE);
    expect(fake.opened).toHaveLength(1);
    fake.opened.length = 0;
    fake.fire("activate");
    expect(fake.opened).toHaveLength(1);
  });
});
