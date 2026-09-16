import { defineConfig } from "tsup";

export default defineConfig({
  // Entries are added as they are built. Nothing here is a stub.
  entry: {
    "toy-crm": "fixtures/toy-crm/stdio.ts",
    proxy: "src/proxy/stdio.ts",
    cli: "src/cli.ts",
    "demo-agent": "demo/agent.ts",
  },
  format: ["esm"],
  // Matches the engines floor in package.json, which is set by better-sqlite3:
  // it declares >=22 and on Node 20 it does not fail politely, it segfaults the
  // moment a database opens. Targeting node20 here compiled for a runtime the
  // package refuses to install on -- harmless, since a lower target is always
  // valid on a higher runtime, but it said the wrong thing about what this
  // supports, and it was the one place a reader could check.
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
});
