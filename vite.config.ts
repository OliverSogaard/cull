import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // The About tab shows the version the installer and the updater manifest
  // carry; package.json is the single source (bump it with Cargo.toml and
  // tauri.conf.json when releasing).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    // Vitest's default `css.include` is `[]`, which stubs out ALL css
    // module content — including `?raw` requests — regardless of the
    // query. Unit tests read design tokens straight out of src/styles/*.css
    // via `import.meta.glob(..., { query: "?raw" })`, so css must actually
    // be processed for those specific reads to see real content.
    // Scoped to only `?raw` requests (confirmed the module id shape by
    // logging it: `.../tokens.css?raw`) so a component test that
    // side-effect-imports a stylesheet (e.g. via App.tsx importing
    // styles/index.css) still gets Vitest's default stub instead of paying
    // for real CSS processing it doesn't need.
    css: { include: [/\.css\?.*\braw\b/] },

    // Coverage is MEASURED, not gated (Phase 4): there is no threshold here
    // and none in CI. A global floor would be sunk by App.tsx and the
    // presentational components, and would then be ignored. Per-directory
    // floors are the shape to add once the numbers exist.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Only the code a test could meaningfully cover: the entry point, the
      // type barrels and the test scaffolding itself are noise in the number.
      // A user `exclude` REPLACES Vitest's defaults, which is why the test
      // files and the fixtures have to be named here explicitly.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__fixtures__/**", // e.g. src/image/__fixtures__/metaBatching
        "src/test/**",
        "src/types/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
}));
