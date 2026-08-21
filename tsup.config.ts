import { defineConfig } from "tsup";

export default defineConfig({
  // Entries are added as they are built. Nothing here is a stub.
  entry: { "toy-crm": "fixtures/toy-crm/stdio.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
});
