import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      prettierConfig,
    ],
    languageOptions: {
      parserOptions: {
        // tsconfig.tests.json = the base project WITH test files included, so
        // type-aware rules cover the suites too (tsconfig.json excludes them).
        project: "./tsconfig.tests.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The dlog forwarder owns the one sanctioned console call (inline-disabled).
      "no-console": ["warn", { allow: ["error", "warn"] }],
      // Baseline decision (grand-cleanup Phase 2): react-hooks v7 ships new
      // compiler-era rules beyond the classic pair. They flag idioms this
      // codebase uses DELIBERATELY and at scale — render-mirror refs
      // (`ref.current = value` during render, e.g. zoomZRef) and
      // reset-state-on-input effects. Adopting them means refactors of
      // timing-sensitive paths, which is out of scope for a lint rollout.
      // rules-of-hooks and exhaustive-deps remain errors.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      // React ignores the return value of JSX event handlers, so passing an
      // async handler to onClick etc. is safe and idiomatic here.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // `_`-prefix = declared-unused by convention (params kept for signature shape).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test-suite relaxations (standard typescript-eslint guidance): vitest
    // mock assertions trip unbound-method; async interface stubs without an
    // await trip require-await; the deferred-invoke harness rejects with
    // plain strings on purpose to exercise error paths.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
);
