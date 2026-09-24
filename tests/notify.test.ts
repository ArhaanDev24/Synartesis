import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { createRetryGate } from "../src/gate/gate.js";
import { openJournal } from "../src/journal/journal.js";
import { desktopNotifier, shown, type HeldNotice } from "../src/notify.js";

/**
 * Telling the person a call is waiting. Nothing did: whether anybody heard
 * depended on the agent relaying it, or on `watch` already being open.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-notify-"));
  dirs.push(dir);
  return dir;
}

describe("when a call is held", () => {
  it("tells the person once, not once per retry", async () => {
    const dir = scratch();
    const journal = openJournal(join(dir, "j.db"));
    try {
      const told: HeldNotice[] = [];
      const gate = createRetryGate(journal, (id) => `synartesis approve ${id.slice(0, 8)}`, (notice) => {
        told.push(notice);
      });
      const runId = journal.beginRun("agent");
      const secret = "sk-live-this-must-never-be-shown";
      const pending = journal.recordPending({
        runId,
        server: "crm",
        tool: "send_email",
        args: { to: "a@b.c", body: secret },
        class: "irreversible",
      });
      const request = {
        actionId: pending.actionId,
        runId,
        seq: pending.seq,
        server: "crm",
        tool: "send_email",
        args: { to: "a@b.c", body: secret },
        why: "this action cannot be undone",
        signal: new AbortController().signal,
      };
      // The agent is refused, then retries the identical call twice more.
      await gate.decide(request);
      await gate.decide(request);
      await gate.decide(request);

      expect(told).toHaveLength(1);
      expect(told[0]?.tool).toBe("send_email");
      expect(told[0]?.approve).toContain(pending.actionId.slice(0, 8));
      // Arguments carry tokens and file contents, and macOS keeps
      // notification history. Nothing of them is in what is shown.
      expect(JSON.stringify(told)).not.toContain(secret);
    } finally {
      journal.close();
    }
  });
});

describe("what a notification shows of a name it was given", () => {
  it("drops the characters that can make one name look like another", () => {
    // U+202E reverses what follows it on screen.
    expect(shown("evil‮loot.fdp")).toBe("evilloot.fdp");
    expect(shown("line\nbreak\u0007")).toBe("linebreak");
    expect(shown("x".repeat(200)).length).toBe(60);
  });
});

describe.runIf(platform() === "darwin")("the macOS notifier", () => {
  it("hands the text to osascript as arguments, never as script", async () => {
    // A stand-in osascript first on PATH, recording exactly what it was run
    // with, so nothing real appears on screen during a test run.
    const bin = scratch();
    const log = join(bin, "argv.json");
    writeFileSync(
      join(bin, "osascript"),
      `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(log)} "$@"\n`,
    );
    chmodSync(join(bin, "osascript"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}:${saved ?? ""}`;
    try {
      desktopNotifier({})({
        server: 'x" & (do shell script "echo pwned") & "',
        tool: "-rf",
        actionId: "1a2b3c4d",
        approve: "synartesis approve 1a2b3c4d",
      });
      // Up to five seconds: the stand-in starts node, and on a loaded machine
      // that alone took longer than the one second this used to allow.
      for (let i = 0; i < 250 && !existsSync(log); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const argv = z.array(z.string()).parse(JSON.parse(readFileSync(log, "utf8")));
      // The script is fixed; the names only ever appear after `--`.
      const script = argv.slice(0, argv.indexOf("--")).join(" ");
      expect(script).not.toContain("pwned");
      expect(script).not.toContain("-rf");
      expect(argv.slice(argv.indexOf("--") + 1).join(" ")).toContain("pwned");
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("is silent when switched off", () => {
    // Nothing to spawn and nothing to assert on screen; the notifier returned
    // must simply do nothing.
    expect(() => {
      desktopNotifier({ SYNARTESIS_NOTIFY: "0" })({
        server: "crm",
        tool: "send_email",
        actionId: "1a2b3c4d",
        approve: "synartesis approve 1a2b3c4d",
      });
    }).not.toThrow();
  });
});

describe.runIf(platform() !== "win32")("the Linux notifier", () => {
  it("puts every name after --, and escapes the markup notify-send would render", async () => {
    // notify-send renders a subset of HTML in the body, so a tool named
    // <a href=...> would become a link in the notification.
    const bin = scratch();
    const log = join(bin, "argv.json");
    writeFileSync(
      join(bin, "notify-send"),
      `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(log)} "$@"\n`,
    );
    chmodSync(join(bin, "notify-send"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}:${saved ?? ""}`;
    try {
      desktopNotifier({}, "linux")({
        server: "--help",
        tool: '<a href="https://evil.example">click</a> & more',
        actionId: "1a2b3c4d",
        approve: "synartesis approve 1a2b3c4d",
      });
      for (let i = 0; i < 250 && !existsSync(log); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const argv = z.array(z.string()).parse(JSON.parse(readFileSync(log, "utf8")));
      const names = argv.slice(argv.indexOf("--") + 1);
      // A server called --help is a name, not an option.
      expect(argv.indexOf("--")).toBeGreaterThan(-1);
      expect(argv.slice(0, argv.indexOf("--")).join(" ")).not.toContain("--help");
      expect(names.join(" ")).not.toContain("<a ");
      expect(names.join(" ")).toContain("&lt;a");
      expect(names.join(" ")).toContain("&amp;");
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("stays silent on a platform it has no notifier for", () => {
    expect(() => {
      desktopNotifier({}, "win32")({ server: "a", tool: "b", actionId: "c", approve: "d" });
    }).not.toThrow();
  });
});
