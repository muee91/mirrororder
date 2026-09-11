// Dev-only: drives the real ProjectWorkbench against the real local Host
// (start it first: PYTHONPATH=src python3 -m script_organizer.cli serve
//  workspace.toml --host 127.0.0.1 --port 8765 --local-only).
// Uses the ux-real.html fixture (real project identity) and a Vite /api
// proxy, timing the five-step main chain at real production scale.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostUrl = process.env.MIRRORORDER_HOST_URL ?? "http://127.0.0.1:8765";

const server = await createServer({
  root: desktopRoot,
  configFile: false,
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    host: "127.0.0.1",
    proxy: { "/api": { target: hostUrl, changeOrigin: false } },
  },
  logLevel: "error",
});
await server.listen();
const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
console.log("vite at", baseUrl);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const started = Date.now();
const apiLog = [];
page.on("response", (response) => {
  if (response.url().includes("/api/")) apiLog.push(`${response.status()} ${response.url().split("/api/")[1]} +${Date.now() - started}ms`);
});
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console.error]", message.text().slice(0, 240));
});
const timings = [];
async function timed(label, action) {
  const start = Date.now();
  await action();
  const ms = Date.now() - start;
  timings.push(`${label}: ${ms}ms`);
  console.log(`${label}: ${ms}ms`);
}
async function diagnose() {
  console.log("--- DIAGNOSTIC ---");
  console.log("api calls:\n ", apiLog.slice(-14).join("\n  ") || "(none)");
  console.log("page text:", (await page.evaluate(() => document.body.innerText)).slice(0, 400));
  await page.screenshot({ path: "/tmp/ux-shots/real-fail.png" });
}

await page.goto(`${baseUrl}/scripts/fixtures/ux-real.html`);
await page.waitForSelector("[class*=workbench]", { timeout: 30000 });
await page.waitForTimeout(3000);

try {
  await timed("script workspace ready", async () => {
    await page.getByRole("button", { name: /^剧本$/ }).first().click();
    await page.waitForSelector(".script-block", { timeout: 30000 });
  });
} catch {
  await diagnose();
  throw new Error("script blocks never rendered");
}
await page.screenshot({ path: "/tmp/ux-shots/real-script.png" });

await timed("script search 3 keystrokes", async () => {
  const search = page.getByRole("searchbox", { name: "搜索剧本" });
  await search.click();
  await search.type("账本", { delay: 40 });
  await page.waitForTimeout(400);
});
await page.screenshot({ path: "/tmp/ux-shots/real-script-search.png" });

try {
  await timed("open segment drawer", async () => {
    await page.getByRole("button", { name: "匹配素材" }).first().click({ timeout: 5000 });
    await page.waitForSelector(".workspace-context-drawer", { timeout: 10000 });
  });
  await page.screenshot({ path: "/tmp/ux-shots/real-drawer.png" });
  await timed("close drawer", async () => {
    await page.getByRole("button", { name: "关闭" }).first().click();
  });
} catch (error) {
  console.log("drawer step skipped:", error.message.split("\n")[0]);
}

try {
  await timed("review workspace ready", async () => {
    await page.getByRole("button", { name: /^审阅$/ }).first().click();
    await page.waitForSelector(".review-queue", { timeout: 30000 });
  });
  await timed("review next-take x2", async () => {
    await page.getByRole("button", { name: "下一个" }).click();
    await page.getByRole("button", { name: "下一个" }).click();
  });
  await page.screenshot({ path: "/tmp/ux-shots/real-review.png" });
} catch (error) {
  console.log("review step failed:", error.message.split("\n")[0]);
  await diagnose();
}

try {
  await timed("material workspace ready", async () => {
    await page.getByRole("button", { name: /^素材$/ }).first().click();
    await page.waitForTimeout(2500);
  });
  await page.screenshot({ path: "/tmp/ux-shots/real-material.png" });
  await timed("timeline workspace ready", async () => {
    await page.getByRole("button", { name: /^时间线$/ }).first().click();
    await page.waitForTimeout(2500);
  });
  await page.screenshot({ path: "/tmp/ux-shots/real-timeline.png" });
} catch (error) {
  console.log("material/timeline step failed:", error.message.split("\n")[0]);
}

console.log("---");
console.log(timings.join("\n"));
await browser.close();
await server.close();
console.log("done");
