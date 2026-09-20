import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

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
    // module content — including `?raw`/`?url` requests — regardless of
    // the query. Unit tests read design tokens straight out of
    // src/styles/*.css via `import.meta.glob(..., { query: "?raw" })`, so
    // css must actually be processed for those reads to see real content.
    // Unanchored on purpose: the module id still carries the `?raw` query
    // (e.g. `tokens.css?raw`), so a trailing `$` would never match.
    css: { include: [/\.css/] },
  },
}));
