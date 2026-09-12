import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The renderer bundle.
 *
 * Relative asset paths, because this page is loaded over `file://` rather than
 * served -- an absolute `/assets/...` would resolve to the root of the disk.
 */
export default defineConfig({
  root: "app/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
  },
});
