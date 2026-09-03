import tseslint from "typescript-eslint";

export default tseslint.config(
  // docs/ holds the build tooling for the user guide -- a Chrome DevTools
  // driver and a Python script -- not project source, so it is outside the
  // tsconfig the type-aware rules need and cannot be linted by them.
  { ignores: ["dist/**", "node_modules/**", "docs/**", "brand/**"] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // D8: the escape hatches are banned outright, not merely discouraged.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["*.config.ts", "eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
