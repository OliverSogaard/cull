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
  },
}));
