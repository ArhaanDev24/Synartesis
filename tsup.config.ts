import { defineConfig } from "tsup";

export default defineConfig({
  // Entries are added as they are built. Nothing here is a stub.
  entry: {
    "toy-crm": "fixtures/toy-crm/stdio.ts",
    proxy: "src/proxy/stdio.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
});
