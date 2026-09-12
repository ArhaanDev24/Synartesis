import { defineConfig } from "vitest/config";

// Browser-facing helpers need their own JSX project, just like type checking.
export default defineConfig({ test: { include: ["app/renderer/*.test.tsx"] } });
