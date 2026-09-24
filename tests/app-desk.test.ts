import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Desk } from "../app/main/desk.js";
import { openJournal } from "../src/journal/journal.js";
import { Library, type SecretStore } from "../app/main/settings.js";
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
function fakeKeychain(): SecretStore & { sealed: string[]; opened: string[] } {
  const sealed: string[] = [];
  const opened: string[] = [];
  return {
    sealed,
    opened,
    available: () => true,
    seal: (plain) => {
      sealed.push(plain);
      return Buffer.from(plain, "utf8").toString("base64");
    },
    open: (text) => {
      const plain = Buffer.from(text, "base64").toString("utf8");
      opened.push(plain);
      return plain;
    },
  };
}

/** What the scripted model does on its next turn. Changed between turns. */
interface Script {
  calls: { name: string; args: Record<string, unknown> }[];
  say: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  readonly secrets: SecretStore & { sealed: string[]; opened: string[] };
  /** A second desk over the same files, which is what restarting the app is. */
  readonly reopen: () => Desk;
  /** The fake provider, so a test can read what the app actually sent it. */
  readonly model: FakeModel;
}

async function bench(
  options: { gateTimeoutMs?: number; alsoBroken?: boolean } = {},
): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "synartesis-desk-"));
  dirs.push(root);
  const files = join(root, "files");
  mkdirSync(files, { recursive: true });
  writeFileSync(
    join(root, "synartesis.yaml"),
    readFileSync("manifests/filesystem.yaml", "utf8").replace(
      /servers:\n  fs:\n    command:.*\n    args:.*\n/,
      `servers:\n  fs:\n    command: "node"\n    args: ["${FS_SERVER}", "${files}"]\n` +
        (options.alsoBroken === true
          ? `  broken:\n    command: "node"\n    args: ["${join(root, "not-here.js")}"]\n`
          : ""),
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
  return { desk: make(), root, files, script, events, settingsPath, secrets, reopen: make, model: server };
}

describe("what the model is told before anybody says anything", () => {
  it("arrives knowing what Synartesis is, which calls stop, and which session this is", async () => {
    const { desk, model } = await bench();
    const opened = await desk.start();
    await desk.send(opened.id, "hello");

    const body = model.sent[0];
    const messages = body?.["messages"];
    expect(Array.isArray(messages)).toBe(true);
    const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
    const system = isRecord(first) ? first["content"] : undefined;
    expect(typeof system).toBe("string");
    const said = typeof system === "string" ? system : "";

    expect(said).toContain("You are the agent inside Synartesis");
    // The rule the whole product rests on.
    expect(said).toMatch(/[Nn]ever\s+look for a different tool/);
    // And the particulars, which is the half that cannot be written in
    // advance: this manifest, these servers, this session.
    expect(said).toContain("Connected: fs, synartesis");
    // A tool from this manifest that really is held. move_file used to be one
    // and is not any more: it is reversible where the destination is free, and
    // the proxy decides that per call from the pre-read rather than in advance.
    expect(said).toContain("fs.create_directory");
    expect(said).toMatch(/session [0-9a-f]{8}/);
  });

  it("puts each tool's class on the tool itself, where a model chooses between them", async () => {
    const { desk, model } = await bench();
    const opened = await desk.start();
    await desk.send(opened.id, "hello");

    const tools = model.sent[0]?.["tools"];
    expect(Array.isArray(tools)).toBe(true);
    const described = (Array.isArray(tools) ? tools : [])
      .map((tool) => (isRecord(tool) ? tool["function"] : undefined))
      .filter(isRecord);
    const of = (bare: string): string => {
      const found = described.find((fn) => String(fn["name"]).endsWith(bare));
      return typeof found?.["description"] === "string" ? found["description"] : "";
    };

    expect(of("write_file")).toContain("[Synartesis: reversible");
    expect(of("create_directory")).toContain("held for the person's approval");
    expect(of("read_file")).toContain("read-only");
    // The server's own description is still there; the note is added, not
    // substituted.
    expect(of("write_file")).toContain("Only works within allowed directories");
  });
});

describe("a server in the policy that will not start", () => {
  it("is in the transcript the window opens, not only in a log", async () => {
    const live = await bench({ alsoBroken: true });
    const opened = await live.desk.start();

    // The note has to be folded in before #view builds this, because #bring
    // runs before the window knows the conversation exists -- an emit here is
    // dropped, and the transcript is what the window actually reads.
    const notes = opened.messages.filter((message) => message.role === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain("broken did not start");
    expect(notes[0]?.text).toContain("not-here.js");
  });

  it("does not stop the servers that did start from working", async () => {
    const live = await bench({ alsoBroken: true });
    const opened = await live.desk.start();
    // One server failing is a fact about that server. The file below is
    // written through the one that came up.
    // An existing file: writing a new one has no prior state to restore, so it
    // is held for approval, which would be a test of the gate rather than of
    // the server that did come up.
    const path = join(live.files, "note.md");
    writeFileSync(path, "before\n");
    live.script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await live.desk.send(opened.id, "change it");
    expect(readFileSync(path, "utf8")).toBe("after\n");
  });
});

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

  it("stops asking about that tool for an hour when the person says so", async () => {
    const { desk, files, script, events } = await bench({ gateTimeoutMs: 4000 });
    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path: join(files, "one.txt"), content: "1\n" } }];
    const answered = new Promise<void>((settle) => {
      const watch = setInterval(() => {
        const ask = events.find((one) => one.event.kind === "approval");
        if (ask?.event.kind === "approval") {
          clearInterval(watch);
          desk.approve(ask.event.request.actionId, { forAnHour: true });
          settle();
        }
      }, 20);
    });
    await Promise.all([desk.send(opened.id, "make a file"), answered]);

    // The next one is not asked about, and nobody answers it.
    const asked = events.filter((one) => one.event.kind === "approval").length;
    const two = join(files, "two.txt");
    script.calls = [{ name: WRITE, args: { path: two, content: "2\n" } }];
    await desk.send(opened.id, "and another");
    expect(readFileSync(two, "utf8")).toBe("2\n");
    expect(events.filter((one) => one.event.kind === "approval")).toHaveLength(asked);
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

describe("the chat list", () => {
  it("holds pinned conversations above the rest, newest first otherwise", async () => {
    const { desk } = await bench();
    const first = await desk.start();
    await desk.send(first.id, "the older one");
    const second = await desk.start();
    await desk.send(second.id, "the newer one");

    expect(desk.conversations().map((one) => one.title)).toEqual([
      "the newer one",
      "the older one",
    ]);

    const pinned = desk.setPinned(first.id, true);
    expect(pinned.map((one) => one.title)).toEqual(["the older one", "the newer one"]);
    expect(pinned[0]?.pinned).toBe(true);
    expect(desk.setPinned(first.id, false)[0]?.title).toBe("the newer one");
  });

  it("forgets a conversation without forgetting what it changed", async () => {
    const { desk, files, script, root } = await bench();
    const path = join(files, "kept.txt");
    writeFileSync(path, "before\n");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await desk.send(opened.id, "change it");
    const session = (await desk.open(opened.id)).summary.sessionId;

    expect(await desk.forget(opened.id)).toHaveLength(0);
    expect(desk.conversations()).toHaveLength(0);

    // The transcript is gone; the record of what happened is not. Somebody
    // tidying their chat list must not thereby lose the ability to put a file
    // back, and `synartesis undo <session>` still can.
    const journal = openJournal(join(root, "journal.db"));
    try {
      const actions = journal.getActions(session);
      expect(actions.some((one) => one.tool === "write_file")).toBe(true);
      expect(actions.find((one) => one.tool === "write_file")?.inverse).toBeDefined();
    } finally {
      journal.close();
    }
  });

  it("reports what has happened to the files under a folder", async () => {
    const { desk, files, script } = await bench();
    const path = join(files, "report.txt");
    writeFileSync(path, "before\n");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await desk.send(opened.id, "change it");

    const report = desk.folder(files);
    const seen = report.files.find((one) => one.path === path);
    expect(seen?.changes).toBe(1);
    expect(seen?.recoverable).toBe(1);
    expect(seen?.undone).toBe(0);
    expect(seen?.lastTool).toBe("fs.write_file");
    expect(seen?.sessions).toHaveLength(1);

    // A folder nothing has been done in says so, rather than guessing.
    expect(desk.folder(join(files, "nowhere")).files).toHaveLength(0);
  });

  it("counts a file as put back once it has been", async () => {
    const { desk, files, script } = await bench();
    const path = join(files, "restored.txt");
    writeFileSync(path, "before\n");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await desk.send(opened.id, "change it");
    await desk.undo(opened.id);

    const seen = desk.folder(files).files.find((one) => one.path === path);
    // Not still counted as a change outstanding: the whole reason to look at a
    // folder is to find what has not been put back yet.
    expect(seen?.undone).toBe(1);
    expect(seen?.changes).toBe(0);
  });
});

describe("what the journal is left with", () => {
  it("leaves no trace of a window that was opened and closed", async () => {
    const { desk, root } = await bench();
    await desk.start();
    await desk.close();
    desks.length = 0;

    const journal = openJournal(join(root, "journal.db"));
    try {
      // Opening the window starts a session whether or not anything is said.
      // One row per launch is one line of `synartesis list` between somebody
      // and the run they are actually looking for.
      expect(journal.listRuns()).toHaveLength(0);
    } finally {
      journal.close();
    }
  });

  it("keeps a session the moment anything is recorded in it", async () => {
    const { desk, files, script, root } = await bench();
    const path = join(files, "kept.txt");
    writeFileSync(path, "before\n");

    const opened = await desk.start();
    script.calls = [{ name: WRITE, args: { path, content: "after\n" } }];
    await desk.send(opened.id, "change it");
    await desk.close();
    desks.length = 0;

    const journal = openJournal(join(root, "journal.db"));
    try {
      expect(journal.listRuns()).toHaveLength(1);
      const run = journal.listRuns()[0];
      expect(run === undefined ? [] : journal.getActions(run.id)).not.toHaveLength(0);
    } finally {
      journal.close();
    }
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

  /*
   * The half the other key tests do not cover.
   *
   * They prove a key never reaches disk, a log, or the window -- all of which
   * would still be true of a key that was quietly dropped on the way to the
   * provider. This follows the one path that matters: in through the sheet,
   * through the keychain seam, and back out as the thing the request is made
   * with.
   */
  it("gives back the key it was given, through the keychain and no further", () => {
    const root = mkdtempSync(join(tmpdir(), "synartesis-keys-"));
    dirs.push(root);
    const path = join(root, "models.json");
    const secrets = fakeKeychain();
    writeFileSync(
      path,
      JSON.stringify({
        models: [
          {
            id: "claude",
            name: "Claude",
            needsKey: true,
            note: "",
            config: { kind: "anthropic", model: "claude-opus-5" },
          },
        ],
        chosen: "claude",
      }),
    );

    const library = Library.open(path, secrets);
    // Without one, it says so rather than failing somewhere down the wire.
    expect(() => library.provider()).toThrow(/needs an API key/i);

    library.saveKey("claude", "sk-ant-round-trip");
    // It reached the provider: anthropic refuses to be built without a key,
    // so a provider existing is the key having survived seal and open.
    expect(library.provider().id).toBe("anthropic:claude-opus-5");
    expect(secrets.opened).toContain("sk-ant-round-trip");

    library.forgetKey("claude");
    expect(() => library.provider()).toThrow(/needs an API key/i);
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

describe("pointing a model somewhere else", () => {
  /*
   * What a person does when a provider retires a model.
   *
   * Every one of them eventually answers 404 naming a replacement, and until
   * this existed the only way out was editing a JSON file with the
   * application closed -- for a service the person is already paying for.
   */
  it("changes the name a model points at, and keeps the key", async () => {
    const { desk } = await bench();
    desk.saveKey("bench", "sk-keep-me");

    const before = desk.settings().models.find((one) => one.id === "bench");
    expect(before?.hasKey).toBe(true);

    const after = desk.setModel("bench", "some-newer-model").models.find((one) => one.id === "bench");
    // Read rather than asserted into shape: every provider config carries a
    // `model`, but two of the three make it optional, so this is what the
    // window itself has to do to show the name.
    const named: unknown = after === undefined ? undefined : { ...after.config }.model;
    expect(named).toBe("some-newer-model");
    // The key belongs to the account, not to the model name.
    expect(after?.hasKey).toBe(true);
  });

  it("refuses an empty name rather than saving one nothing can use", async () => {
    const { desk } = await bench();
    expect(() => desk.setModel("bench", "   ")).toThrow(/needs a name/i);
  });
});
