import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * A server that needs its token, all the way through, with real processes.
 *
 * Wrapping a server used to drop the environment the client gave it: `install`
 * copied `env` onto the proxy's entry, the proxy started the server with only
 * what the policy declared, and the SDK filled in nothing but PATH and HOME.
 * So a server that authenticates through its environment -- most of them --
 * stopped working the moment it was wrapped. And `undo`, run from a terminal
 * that has never seen the client's token, could not start the server at all:
 * an undo that cannot authenticate does not undo anything.
 *
 * The server here is the toy CRM behind a gate that refuses to start without
 * `CRM_TOKEN`, so every failure mode above is a hard, visible failure rather
 * than a subtle one.
 */

const CLI = resolve("dist/cli.js");
const CRM = resolve("dist/toy-crm.js");
const POLICY = resolve("manifests/toy-crm.yaml");
const TOKEN = "s3cret-for-the-test";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The CLI with exactly this environment, nothing inherited from the test. */
function run(args: readonly string[], env: Record<string, string>, stdin?: string): Promise<Ran> {
  return new Promise<Ran>((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

const HELLO = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
].join("\n");

function call(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

const stateShape = z.looseObject({
  customers: z.record(z.string(), z.looseObject({ notes: z.string() })),
});

interface Bench {
  readonly home: string;
  readonly manifest: string;
  readonly journal: string;
  readonly state: string;
}

/**
 * A scratch machine: a home with a Cursor config wrapping the server the way
 * `install` writes it, a policy pointing at the gated CRM, and a state file so
 * the CRM survives from the proxy's process to undo's.
 */
function bench(extra: Record<string, string> = {}): Bench {
  const dir = mkdtempSync(join(tmpdir(), "synartesis-env-"));
  dirs.push(dir);
  const home = join(dir, "home");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const state = join(dir, "crm.json");
  const journal = join(dir, "journal.db");
  const manifest = join(dir, "synartesis.yaml");

  // Refuses to start without the token, then becomes the ordinary toy CRM.
  // process.argv is left alone, so the CRM reads its own --state from it.
  const gate = join(dir, "gated-crm.mjs");
  writeFileSync(
    gate,
    [
      `if (process.env.CRM_TOKEN !== ${JSON.stringify(TOKEN)}) {`,
      `  console.error("Please set CRM_TOKEN");`,
      `  process.exit(1);`,
      `}`,
      `await import(${JSON.stringify(CRM)});`,
    ].join("\n"),
  );

  writeFileSync(
    manifest,
    readFileSync(POLICY, "utf8").replace(
      'args: ["dist/toy-crm.js"]',
      `args: [${JSON.stringify(gate)}, "--state", ${JSON.stringify(state)}]`,
    ),
  );

  // What install writes: the client starts the proxy for one server, and the
  // token the client configured sits on the entry.
  writeFileSync(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        crm: {
          command: process.execPath,
          args: [CLI, "proxy", "--manifest", manifest, "--server", "crm"],
          env: { CRM_TOKEN: TOKEN, ...extra },
        },
      },
    }),
  );
  return { home, manifest, journal, state };
}

function notesOf(state: string, id: string): string | undefined {
  return stateShape.parse(JSON.parse(readFileSync(state, "utf8"))).customers[id]?.notes;
}

describe("a server that needs its token, wrapped", () => {
  it("still gets it through the proxy", async () => {
    const { home, manifest, journal, state } = bench();

    // As the client starts the proxy: with the entry's env.
    const proxied = await run(
      ["proxy", "--manifest", manifest, "--server", "crm", "--journal", journal],
      { HOME: home, CRM_TOKEN: TOKEN },
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "written through the proxy" })}\n`,
    );

    // Before: the server was started with only PATH and HOME, printed
    // "Please set CRM_TOKEN" and the proxy never came up.
    expect(proxied.stderr).not.toContain("Please set CRM_TOKEN");
    expect(notesOf(state, "c_001")).toBe("written through the proxy");
  });

  it("gets it again when undo is run from a shell that never had it", async () => {
    const { home, manifest, journal, state } = bench();
    await run(
      ["proxy", "--manifest", manifest, "--server", "crm", "--journal", journal],
      { HOME: home, CRM_TOKEN: TOKEN },
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "the agent's edit" })}\n`,
    );
    const before = notesOf(state, "c_001");
    expect(before).toBe("the agent's edit");

    // A terminal with no CRM_TOKEN in it. The token is found where it really
    // lives: on the client entry that wraps the server.
    const undone = await run(["undo", "--manifest", manifest, "--journal", journal], { HOME: home });

    expect(undone.stderr).not.toContain("Please set CRM_TOKEN");
    expect(undone.stdout).toContain("all undone");
    expect(notesOf(state, "c_001")).not.toBe("the agent's edit");
  });

  it("does not hand the proxy's own secret to the server", async () => {
    const { home, manifest, journal } = bench();
    // A server that prints what it was given, in place of the CRM.
    const dump = join(home, "dump.mjs");
    const seen = join(home, "seen.json");
    writeFileSync(
      dump,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));\nprocess.exit(1);\n`,
    );
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(/args: \[[^\]]*\]/, `args: [${JSON.stringify(dump)}]`),
    );

    await run(
      ["proxy", "--manifest", manifest, "--server", "crm", "--journal", journal],
      {
        HOME: home,
        CRM_TOKEN: TOKEN,
        SYNARTESIS_TOKEN: "the-proxy's-own-http-bearer",
        npm_config_package: "synartesis",
      },
      `${HELLO}\n`,
    );

    const keys = z.array(z.string()).parse(JSON.parse(readFileSync(seen, "utf8")));
    expect(keys).toContain("CRM_TOKEN");
    expect(keys).not.toContain("SYNARTESIS_TOKEN");
    expect(keys).not.toContain("npm_config_package");
  });

  it("refuses an undo whose server would not be the one the session used", async () => {
    // A variable the gate ignores, so this can only fail on the check itself
    // and never on authentication. In real use it is MEMORY_FILE_PATH: the
    // client entry is changed after the session, the undo starts the server
    // against the new file, sends its inverse there, and reports success.
    const { home, manifest, journal, state } = bench({ CRM_REGION: "eu" });
    await run(
      ["proxy", "--manifest", manifest, "--server", "crm", "--journal", journal],
      { HOME: home, CRM_TOKEN: TOKEN, CRM_REGION: "eu" },
      `${HELLO}\n${call(2, "update_customer", { id: "c_001", notes: "the agent's edit" })}\n`,
    );

    // Somebody edits the client config afterwards.
    const config = join(home, ".cursor", "mcp.json");
    writeFileSync(config, readFileSync(config, "utf8").replace('"CRM_REGION":"eu"', '"CRM_REGION":"us"'));

    const undone = await run(["undo", "--manifest", manifest, "--journal", journal], { HOME: home });

    expect(undone.stderr).toContain("CRM_REGION");
    expect(undone.stderr).toContain("not what this session's crm server was started with");
    // Neither value is ever printed.
    expect(undone.stderr).not.toContain('"eu"');
    expect(`${undone.stdout}${undone.stderr}`).not.toContain(TOKEN);
    // And nothing was written: the agent's edit is still there.
    expect(notesOf(state, "c_001")).toBe("the agent's edit");
  });
});
