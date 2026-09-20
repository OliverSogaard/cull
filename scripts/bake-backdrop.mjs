// Bakes the backdrop tone into src/assets/backdrop.jpg and
// src/assets/desert.jpg: grayscale(1) brightness(0.85) contrast(1.05),
// composited at opacity 0.11 over --bg (#0c0c0d), resampled to 2560px wide
// with a Lanczos3 pass (scripts/bake-backdrop/bake.html) so the upscale
// beats the browser's own. Shipped at quality q=0.82 for both assets
// (backdrop 2560x1461, desert 2560x1422) — see the run's printed diff/size
// line for the numbers this shipped with.
//
// No new dependency: node:http serves scripts/bake-backdrop/ (the page) and
// its sources/ subfolder over loopback HTTP — a file:// image taints the
// canvas in Chromium, so toDataURL throws SecurityError — then headless
// Microsoft Edge (`--dump-dom`) renders the page and prints the composited
// JPEG as a data URL plus a diff report; this script decodes that data URL
// to disk.
//
// Re-run: `node scripts/bake-backdrop.mjs` (add `--force` to write past the
// max|Δ| > 8/255 guard — that guard means the tone chain is wrong, not that
// the threshold is). The originals under scripts/bake-backdrop/sources/ are
// the untouched sources — never bake from an already-baked file.

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_ROOT = fileURLToPath(new URL("./bake-backdrop", import.meta.url));
const ASSETS_DIR = fileURLToPath(new URL("../src/assets", import.meta.url));
const EDGE_INSTALL_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const WIDTH = 2560;
const START_QUALITY = 0.82;
const MAX_BYTES = 320 * 1024;
const MAX_ABS_DIFF = 8;
const FORCE = process.argv.includes("--force");

const ASSETS = [
  { name: "backdrop", src: "/sources/backdrop.jpg" },
  { name: "desert", src: "/sources/desert.jpg" },
];

const MIME_TYPES = { ".html": "text/html", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** Serves PAGE_ROOT (the bake page and its sources/ images) over loopback HTTP. */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      const filePath = join(PAGE_ROOT, pathname);
      if (!filePath.startsWith(PAGE_ROOT) || !existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": contentType });
      res.end(readFileSync(filePath));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** First path `where` reports for `command`, or null if it is not on PATH. */
function which(command) {
  const result = spawnSync("where", [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

/** msedge on PATH, then chrome on PATH, then the well-known Edge install path. */
function resolveBrowser() {
  const found = which("msedge") ?? which("chrome") ?? (existsSync(EDGE_INSTALL_PATH) ? EDGE_INSTALL_PATH : null);
  if (found) return found;
  throw new Error(
    "No headless-capable browser found on PATH or at the well-known Edge install path. " +
      "Run by hand once a browser is available, e.g.:\n" +
      `"${EDGE_INSTALL_PATH}" --headless=new --disable-gpu --virtual-time-budget=30000 --dump-dom ` +
      '"http://127.0.0.1:<port>/bake.html?src=/sources/backdrop.jpg&w=2560&q=0.82"',
  );
}

/**
 * Spawns the browser once against `url` and returns the dumped DOM text.
 * Deliberately async `spawn`, not `spawnSync`: the page's own image fetch
 * hits the static server running in THIS process, and `spawnSync` blocks
 * the event loop for the whole child lifetime — the server could never
 * answer, and the browser would hang until its own timeout. A throwaway
 * --user-data-dir keeps this from colliding with (or hanging behind the
 * profile lock of) any Edge windows the user already has open.
 */
function dumpDom(browser, url) {
  const profileDir = mkdtempSync(join(tmpdir(), "cull-bake-backdrop-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--virtual-time-budget=30000",
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(profileDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`headless browser exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Pulls the text content of `<script type="text/plain" id="${id}">` out of a dumped DOM. */
function extractScriptText(dom, id) {
  const match = dom.match(new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`));
  if (!match) throw new Error(`no #${id} in the dumped DOM`);
  return match[1];
}

/** Runs one bake at `quality` and returns the decoded data URL plus its diff report. */
async function bakeOnce(browser, port, asset, quality) {
  const url = `http://127.0.0.1:${String(port)}/bake.html?src=${asset.src}&w=${String(WIDTH)}&q=${String(quality)}`;
  const dom = await dumpDom(browser, url);
  const dataUrl = extractScriptText(dom, "out");
  const diff = JSON.parse(extractScriptText(dom, "diff"));
  return { dataUrl, diff };
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const browser = resolveBrowser();

  try {
    for (const asset of ASSETS) {
      let quality = START_QUALITY;
      let { dataUrl, diff } = await bakeOnce(browser, port, asset, quality);
      while (diff.bytes > MAX_BYTES && quality > 0.5) {
        quality = Math.round((quality - 0.02) * 100) / 100;
        ({ dataUrl, diff } = await bakeOnce(browser, port, asset, quality));
      }

      console.log(
        `${asset.name}: ${String(diff.w)}x${String(diff.h)} q${String(quality)} ${String(diff.bytes)}B ` +
          `mean|Δ|=${String(diff.meanAbsDiff)} max|Δ|=${String(diff.maxAbsDiff)}`,
      );

      if (diff.maxAbsDiff > MAX_ABS_DIFF && !FORCE) {
        throw new Error(
          `${asset.name}: max|Δ| ${String(diff.maxAbsDiff)} > ${String(MAX_ABS_DIFF)} — the tone chain looks ` +
            "wrong (wrong filter order, alpha applied twice, or the --bg fill missing). Fix that, not the " +
            "threshold, or pass --force to write anyway.",
        );
      }

      const jpegBuffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      writeFileSync(join(ASSETS_DIR, `${asset.name}.jpg`), jpegBuffer);
    }
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
