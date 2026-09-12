/**
 * Run the window against a throwaway everything.
 *
 *   pnpm app:sandbox            parchment, the default
 *   pnpm app:sandbox -- --dark  the other theme
 *
 * Makes a policy, a journal, a settings file and a directory of sample files
 * under app/dev/.sandbox, starts the stand-in model, and launches the app
 * pointed at all of it. Nothing here touches ~/.synartesis, so a turn that
 * writes a file writes a sample one -- which is the point: the window can be
 * worked on all day without a key, a network, or anything real at risk.
 *
 * Ctrl-C stops both. Delete app/dev/.sandbox to start from nothing.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const sandbox = join(here, ".sandbox");
const home = join(sandbox, "home");
const files = join(sandbox, "files");
const userData = join(sandbox, "userdata");

const dark = process.argv.includes("--dark");
const fresh = process.argv.includes("--fresh");
if (fresh) {
  rmSync(sandbox, { recursive: true, force: true });
}
for (const dir of [home, files, userData]) {
  mkdirSync(dir, { recursive: true });
}

// A policy for one filesystem server, rooted at the sample files. The tool
// classes come from the shipped manifest, so what is held and what is
// reversible here is what a real setup would do.
const server = resolve(root, "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
writeFileSync(
  join(home, "synartesis.yaml"),
  readFileSync(join(root, "manifests/filesystem.yaml"), "utf8").replace(
    /servers:\n {2}fs:\n {4}command:.*\n {4}args:.*\n/,
    `servers:\n  fs:\n    command: "node"\n    args: ["${server}", "${files}"]\n`,
  ),
);

writeFileSync(join(files, "report.txt"), "Region   Revenue\nNorth    412,000\nSouth    288,400\n");
writeFileSync(join(files, "notes.md"), "# Notes\n\nNothing yet.\n");

writeFileSync(
  join(userData, "models.json"),
  `${JSON.stringify(
    {
      models: [
        {
          id: "ollama",
          name: "Ollama",
          needsKey: false,
          note: "On this machine. Free, private, and nothing leaves the laptop.",
          config: {
            kind: "openai-compatible",
            model: "stand-in",
            baseURL: "http://127.0.0.1:11888/v1",
            label: "Ollama",
          },
        },
        // Two hosted models, so the keys sheet has more than one row to lay
        // out and the "get a key" link has somewhere to point.
        {
          id: "claude",
          name: "Claude",
          needsKey: true,
          keyUrl: "https://console.anthropic.com/settings/keys",
          note: "Anthropic. Charged per token. Thinking effort applies.",
          config: { kind: "anthropic", model: "claude-opus-5" },
        },
        {
          id: "gemini",
          name: "Gemini",
          needsKey: true,
          keyUrl: "https://aistudio.google.com/apikey",
          note: "Google. Charged per token. Thinking level applies.",
          config: { kind: "gemini", model: "gemini-3-pro-preview" },
        },
      ],
      chosen: "ollama",
      reasoning: "balanced",
      theme: dark ? "dark" : "light",
    },
    null,
    2,
  )}\n`,
);

const running = [
  spawn(process.execPath, [join(here, "stand-in.mjs")], {
    stdio: "inherit",
    env: { ...process.env, SANDBOX_FILE: join(files, "report.txt") },
  }),
  spawn(
    join(root, "node_modules/.bin/electron"),
    [join(root, "app/dist/main/index.js"), `--user-data-dir=${userData}`, ...process.argv.slice(2).filter((flag) => flag.startsWith("--remote"))],
    {
      stdio: "inherit",
      env: { ...process.env, SYNARTESIS_HOME: home },
    },
  ),
];

const stop = () => {
  for (const child of running) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
running[1].on("exit", stop);

console.log(`\n  sandbox: ${sandbox}\n  files the model can touch: ${files}\n`);
