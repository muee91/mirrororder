// Dev-only visual audit harness (not part of CI):
//   node scripts/ux-audit.mjs
// Renders the real ProjectWorkbench with synthetic 400-take data and
// captures per-workspace screenshots to /tmp/ux-shots for UX review.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.UX_SHOT_DIR ?? "/tmp/ux-shots";
mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root: desktopRoot,
  configFile: false,
  plugins: [react()],
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
  logLevel: "error",
});

await server.listen();
const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ?? "http://127.0.0.1:5199";
console.log("vite at", baseUrl);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  window.fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/review-model") || url.includes("/script-supervisor")) {
      return window.__uxFetch(input);
    }
    return new Response(JSON.stringify({ error: "not mocked" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
});

await page.goto(`${baseUrl}/scripts/fixtures/ux-audit.html`);
await page.waitForSelector("[class*=workbench]", { timeout: 20000 });
await page.waitForTimeout(2500);

async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("saved", name);
}

for (const [label, name] of [["剧本", "03-script"], ["审阅", "05-review"], ["时间线", "04-timeline"]]) {
  const tab = page.getByRole("button", { name: new RegExp(`^${label}$`) }).first();
  await tab.click({ timeout: 6000 });
  await page.waitForTimeout(1500);
  await shot(name);
}

await browser.close();
await server.close();
console.log("done");
