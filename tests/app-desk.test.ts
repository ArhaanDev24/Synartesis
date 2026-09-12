import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Desk } from "../app/main/desk.js";
import type { SecretStore } from "../app/main/settings.js";
import { SEPARATOR } from "../src/proxy/routing.js";
import type { SessionEvent } from "../app/shared/ipc.js";
import { fakeModel, openAIEvent, type FakeModel } from "./helpers/fake-model.js";

/**
 * The app, without the window.
 *
 * Everything a person does goes through the desk -- say something, watch it
 * act, ask what changed, put it back, answer a held call -- and the desk is
 * deliberately free of Electron so all of it can be checked. What is left in
 * the main process is making a window and carrying messages, which is the part
 * these cannot reach and the part with the least in it.
 */

const FS_SERVER = resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");

/**
 * What `write_file` is really called here.
 *
 * Qualified, because this app always fronts the person's servers and its own.
 * If this were wrong the calls below would simply fail, and the journal
 * assertions would catch it -- which is why they are written against the
 * journal rather than against the model's reply.
 */
const WRITE = `fs${SEPARATOR}write_file`;

const dirs: string[] = [];
const desks: Desk[] = [];
const servers: FakeModel[] = [];
afterEach(async () => {
  for (const desk of desks.splice(0)) await desk.close();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for the OS keychain.
 *
 * Reversible on purpose -- a test must not need a real one -- but it goes
 * through the same seam the real one does, which is what the storage test
 * actually checks: that a key reaches `seal` and never the file directly.
 */
function fakeKeychain(): SecretStore & { sealed: string[] } {
  const sealed: string[] = [];
  return {
    sealed,
    available: () => true,
    seal: (plain) => {
      sealed.push(plain);
      return Buffer.from(plain, "utf8").toString("base64");
    },
    open: (text) => Buffer.from(text, "base64").toString("utf8"),
  };
}

/** What the scripted model does on its next turn. Changed between turns. */
interface Script {
  calls: { name: string; args: Record<string, unknown> }[];
  say: string;
}

async function scriptedServer(script: Script): Promise<FakeModel> {
  const server = await fakeModel(() => {
    const calls = script.calls.splice(0);
    if (calls.length === 0) {
      return {
        sse: [
          openAIEvent({ choices: [{ index: 0, delta: { content: script.say } }] }),
          "data: [DONE]\n\n",
        ],
      };
    }
    return {
      sse: [
        openAIEvent({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: calls.map((call, at) => ({
                  index: at,
                  id: `call_${String(at)}`,
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              },
            },
          ],
        }),
        "data: [DONE]\n\n",
      ],
    };
  });
  servers.push(server);
  return server;
}

interface Bench {
  readonly desk: Desk;
  readonly root: string;
  readonly files: string;
  readonly script: Script;
  readonly events: { id: string; event: SessionEvent }[];
  readonly settingsPath: string;
  readonly secrets: SecretStore & { sealed: string[] };
  /** A second desk over the same files, which is what restarting the app is. */
  readonly reopen: () => Desk;
}

async function bench(options: { gateTimeoutMs?: number } = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-desk-"));
  dirs.push(root);
  const files = join(root, "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(
    join(root, "synartesis.yaml"),
    readFileSync("manifests/filesystem.yaml", "utf8").replace(
      /servers:\n  fs:\n    command:.*\n    args:.*\n/,
      `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${files}"]\n`,
    ),
  );

  const script: Script = { calls: [], say: "Done." };
  const server = await scriptedServer(script);
  const settingsPath = join(root, "models.json");
  // Written by hand, which is also how a person adds a model this app ships no
  // preset for -- so this doubles as a check that the settings reader accepts
  // one it did not write itself.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      models: [
        {
          id: "bench",
          name: "Bench",
          needsKey: false,
          note: "",
          config: { kind: "openai-compatible", model: "bench", baseURL: `${server.url}/v1` },
        },
      ],
      chosen: "bench",
      reasoning: "balanced",
    }),
  );

  const events: { id: string; event: SessionEvent }[] = [];
  const secrets = fakeKeychain();
  const make = (): Desk => {
    const desk = Desk.open({
      manifestPath: join(root, "synartesis.yaml"),
      journalPath: join(root, "journal.db"),
      settingsPath,
      conversationsPath: join(root, "conversations.json"),
      accountPath: join(root, "account.sealed"),
      secrets,
      emit: (id, event) => {
        events.push({ id, event });
      },
      gateTimeoutMs: options.gateTimeoutMs ?? 400,
    });
    desks.push(desk);
    return desk;
  };
  return { desk: make(), root, files, script, events, settingsPath, secrets, reopen: make };
}

describe("saying something and watching it happen", () => {
  it("counts what changed, and puts it back on the second yes", async () => {
    const { desk, files, script } = await bench();
    const path = join(files, "report.txt");
    const original = "Region   Revenue\nNorth    412,000\n";
    writeFileSync(path, original);

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "Region   Revenue\nNorth    0\n" } }];
    await desk.send(opened.id, "zero out the north revenue");

    expect(readFileSync(path, "utf8")).toContain("North    0");

    // The standing summary, from the journal alone -- no upstream reads.
    const desks2 = await desk.open(opened.id);
    expect(desks2.summary.touched).toBe(1);
    expect(desks2.summary.recoverable).toBe(1);
    expect(desks2.summary.held).toBe(0);

    // The plan a person is shown before they are asked.
    const plan = await desk.previewUndo(opened.id);
    expect(plan).toMatch(/revert/);
    expect(readFileSync(path, "utf8")).toContain("North    0");

    expect(await desk.undo(opened.id)).toMatch(/rolled_back/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("shows what the proxy made of a call while it is still on screen", async () => {
    const { desk, files, script, events } = await bench();
    const path = join(files, "notes.md");
    writeFileSync(path, "before\n");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await desk.send(opened.id, "change it");

    const results = events.filter((one) => one.event.kind === "result");
    const card = results[0]?.event.kind === "result" ? results[0].event.call : undefined;
    // The point of the card: you can see it is recoverable as it happens,
    // rather than finding out when you come to undo it.
    expect(card?.recorded?.class).toBe("reversible");
    expect(card?.recorded?.reversible).toBe(true);
    expect(card?.recorded?.status).toBe("applied");
  });

  it("holds a call that cannot be undone, and does it once a person says yes", async () => {
    const { desk, files, script, events } = await bench({ gateTimeoutMs: 4000 });
    const fresh = join(files, "new.txt");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path: fresh, content: "hello\n" } }];

    // Creating a file has no prior state to restore and this server cannot
    // delete, so the policy holds it. The person answering is the whole
    // difference between a window and a terminal here.
    const answered = new Promise<void>((settle) => {
      const watch = setInterval(() => {
        const ask = events.find((one) => one.event.kind === "approval");
        if (ask?.event.kind === "approval") {
          clearInterval(watch);
          desk.approve(ask.event.request.actionId);
          settle();
        }
      }, 20);
    });

    await Promise.all([desk.send(opened.id, "make a file"), answered]);
    expect(readFileSync(fresh, "utf8")).toBe("hello\n");
  });

  it("does not do a held call when nobody answers", async () => {
    const { desk, files, script } = await bench({ gateTimeoutMs: 250 });
    const fresh = join(files, "unasked.txt");
    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path: fresh, content: "hello\n" } }];
    await desk.send(opened.id, "make a file");

    expect(() => readFileSync(fresh, "utf8")).toThrow();
    const summary = (await desk.open(opened.id)).summary;
    // And it says so, rather than reporting that nothing happened. Silence is
    // not consent, so this ends refused -- but the person still has to be told
    // the model asked for something and did not get it.
    expect(summary.held).toBe(1);
    expect(summary.touched).toBe(0);
  });
});

describe("coming back to it", () => {
  it("still has the conversation, and can still undo the older session", async () => {
    const first = await bench();
    const path = join(first.files, "kept.txt");
    writeFileSync(path, "before\n");

    const opened = await first.desk.start();
    first.script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await first.desk.send(opened.id, "change it");
    await first.desk.close();
    desks.length = 0;

    // A new desk over the same files: what restarting the app is.
    const again = first.reopen();
    const list = again.conversations();
    expect(list.map((one) => one.id)).toContain(opened.id);
    expect(list[0]?.title).toBe("change it");

    const back = await again.open(opened.id);
    // What was said, what it did, and what it said afterwards -- in that order,
    // read back off the disk exactly as it was on screen.
    expect(back.messages.map((one) => one.role)).toEqual(["you", "model", "model"]);
    expect(back.messages[1]?.calls[0]?.name).toBe(WRITE);
    expect(back.messages[1]?.calls[0]?.recorded?.reversible).toBe(true);
    expect(back.messages[2]?.text).toBe("Done.");
    // The older session is carried forward, so the work is still counted and
    // still reversible. Forgetting it would be telling somebody their changes
    // are gone when they are sitting in the journal.
    expect(back.summary.touched).toBe(1);

    await again.undo(opened.id);
    expect(readFileSync(path, "utf8")).toBe("before\n");
  });
});

describe("keys", () => {
  it("never writes one where anybody can read it", async () => {
    const { desk, settingsPath, secrets } = await bench();
    desk.chooseModel("bench");
    desk.saveKey("bench", "sk-ant-super-secret-value");

    const onDisk = readFileSync(settingsPath, "utf8");
    expect(onDisk).not.toContain("sk-ant-super-secret-value");
    // It went through the keychain rather than around it.
    expect(secrets.sealed).toContain("sk-ant-super-secret-value");
  });

  it("never hands one back to the window", async () => {
    const { desk } = await bench();
    desk.saveKey("bench", "sk-ant-super-secret-value");
    const view = desk.settings();
    expect(JSON.stringify(view)).not.toContain("sk-ant-super-secret-value");
    // Only whether there is one, which is all the window needs to know.
    expect(view.models.find((model) => model.id === "bench")?.hasKey).toBe(true);
  });

  it("says a hosted model needs a key instead of failing mid-request", async () => {
    const { settingsPath, reopen } = await bench();
    writeFileSync(
      settingsPath,
      JSON.stringify({
        models: [
          { id: "claude", name: "Claude", needsKey: true, note: "", config: { kind: "anthropic" } },
        ],
        chosen: "claude",
        reasoning: "balanced",
      }),
    );
    const desk = reopen();
    const opened = await desk.start();
    // Before the request rather than as a 401 four layers down, which is the
    // difference between a sentence a person can act on and a stack trace.
    await expect(desk.send(opened.id, "hello")).rejects.toThrow(/needs an API key/);
  });
});
