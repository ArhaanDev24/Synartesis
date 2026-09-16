/**
 * The bridge the window actually gets, against the interface that describes it.
 *
 * `Bridge` was declared twice -- once in shared/ipc.ts, imported by nothing,
 * and once in the renderer -- and neither was connected to the preload, which
 * is the only one that was true. They had drifted on two counts: `stop`
 * returned a promise in one and not the other, and the preload exposed a
 * method that neither interface declared.
 *
 * A type cannot catch that on its own, because the failure mode is forgetting
 * one side and `keyof Bridge` is gone by run time. So the interface carries a
 * roster as a value, and this checks the preload against it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CALLS, EVENT_CHANNEL } from "../app/shared/ipc.js";

const exposed = new Map<string, unknown>();
const invoked: { channel: string; args: unknown[] }[] = [];
const listening: string[] = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      exposed.set(name, value);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      invoked.push({ channel, args });
      return Promise.resolve({ ok: true, value: undefined });
    },
    on: (channel: string) => {
      listening.push(channel);
    },
    off: () => undefined,
  },
}));

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

async function surface(): Promise<Record<string, unknown>> {
  await import("../app/preload/bridge.js");
  const bridge = exposed.get("synartesis");
  if (typeof bridge !== "object" || bridge === null) {
    throw new Error("the preload exposed nothing");
  }
  return Object.fromEntries(Object.entries(bridge));
}

afterEach(() => {
  invoked.length = 0;
  listening.length = 0;
});

describe("what the preload puts on the window", () => {
  it("exposes exactly what the interface declares, and nothing more", async () => {
    const bridge = await surface();
    // Both directions. A method the interface declares and the preload forgot
    // is a call the window makes into nothing; one the preload exposes and no
    // interface declares is a hole nobody is reviewing -- and that was the
    // live case, an onNoManifest neither Bridge had ever heard of.
    expect(Object.keys(bridge).sort()).toEqual(
      [...Object.keys(BRIDGE_CALLS), "onEvent"].sort(),
    );
  });

  it("sends each call down the channel the roster names", async () => {
    const bridge = await surface();
    for (const [name, channel] of Object.entries(BRIDGE_CALLS)) {
      invoked.length = 0;
      const method = bridge[name];
      if (!isCallable(method)) {
        throw new Error(`${name} is not callable`);
      }
      await method("one", "two");
      expect(invoked.map((one) => one.channel)).toEqual([channel]);
    }
  });

  it("listens on the one push channel, and names it once", async () => {
    const bridge = await surface();
    const onEvent = bridge["onEvent"];
    if (!isCallable(onEvent)) {
      throw new Error("onEvent is not callable");
    }
    onEvent(() => undefined);
    expect(listening).toEqual([EVENT_CHANNEL]);
  });

  it("takes no channel name from the page", async () => {
    // The rule the whole preload exists to keep: a renderer that can name its
    // own channel can reach every handler in the main process.
    const bridge = await surface();
    const settings = bridge["settings"];
    if (!isCallable(settings)) {
      throw new Error("settings is not callable");
    }
    await settings("gate:approve", "anything");
    expect(invoked.map((one) => one.channel)).toEqual(["settings:get"]);
  });
});
