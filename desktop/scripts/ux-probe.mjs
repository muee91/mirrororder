// Dev-only probe: sets the operator, then inspects decision button state.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root: desktopRoot, configFile: false, plugins: [react()], server: { port: 5199, strictPort: true, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  window.fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("/review-model") || url.includes("/script-supervisor")) return window.__uxFetch(input);
    if (url.includes("/editorial")) {
      return new Response(JSON.stringify({ version: 2, revision: 1, updated_at: "", opinions: {}, decisions: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "no" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
});
await page.goto(`${baseUrl}/scripts/fixtures/ux-audit.html`);
await page.waitForSelector("[class*=workbench]", { timeout: 20000 });
await page.waitForTimeout(1800);
await page.getByRole("button", { name: /^审阅$/ }).first().click();
await page.waitForTimeout(1200);

// 设置操作者
await page.locator(".current-operator-chip").click();
await page.locator(".current-operator-popover input").fill("大王");
await page.getByRole("button", { name: "使用此身份" }).click();
await page.waitForTimeout(600);

const clip = await page.locator(".editorial-decision-section").boundingBox();
await page.screenshot({ path: "/tmp/ux-shots/08-decision-with-operator.png", clip });
const styles = await page.evaluate(() => {
  const button = document.querySelector(".editorial-decision-actions button");
  const cs = getComputedStyle(button);
  return { color: cs.color, border: cs.borderTopColor, disabled: button.disabled };
});
console.log(JSON.stringify(styles));
await browser.close();
await server.close();
