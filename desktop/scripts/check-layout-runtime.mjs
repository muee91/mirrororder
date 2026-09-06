import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = resolve(desktopRoot, "artifacts/layout-runtime");
const stubId = "\0mirrororder-layout-golden-slate";

function goldenSlateStubPlugin() {
  return {
    name: "mirrororder-layout-golden-slate-stub",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "../slate/GoldenSlateWorkbench"
        && importer?.replaceAll("\\", "/").endsWith("/src/features/material/MaterialWorkspace.tsx")
      ) {
        return stubId;
      }
      return null;
    },
    load(id) {
      if (id !== stubId) return null;
      return `
        import { createElement as h } from "react";
        import "/src/features/slate/golden-slate.css";

        export function GoldenSlateWorkbench() {
          return h(
            "section",
            { className: "golden-slate-workbench", "data-layout-test": "golden-slate", "aria-label": "场记工作台" },
            h(
              "header",
              { className: "golden-slate-toolbar" },
              h("div", { className: "golden-slate-title" }, h("strong", null, "场记"), h("span", null, "668 Take · 68 需关注")),
              h("span", { className: "golden-slate-mode" }, "拍摄事实"),
              h("div", { className: "golden-slate-actions" }, h("button", { type: "button" }, "保存")),
            ),
            h(
              "div",
              { className: "golden-slate-quick" },
              h("input", { "aria-label": "快速场记", placeholder: "输入场、镜、Take" }),
            ),
            h(
              "div",
              { className: "golden-slate-body" },
              h(
                "div",
                { className: "golden-slate-table-shell" },
                h(
                  "table",
                  { className: "golden-slate-table", "aria-label": "场记数据" },
                  h("thead", null, h("tr", null, h("th", null, "Take"), h("th", null, "状态"))),
                  h(
                    "tbody",
                    null,
                    h(
                      "tr",
                      { "data-layout-test": "slate-data-row" },
                      h("td", null, "Take 668"),
                      h("td", null, "可用"),
                    ),
                  ),
                ),
              ),
            ),
          );
        }
      `;
    },
  };
}

function approxEqual(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

async function collectMetrics(page) {
  return page.evaluate(() => {
    const required = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing layout element: ${selector}`);
      return element;
    };
    const rect = (selector) => {
      const value = required(selector).getBoundingClientRect();
      return {
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        left: value.left,
        width: value.width,
        height: value.height,
      };
    };
    const workbench = required(".professional-project-workbench");
    const main = required(".project-workbench-main");
    const row = required('[data-layout-test="slate-data-row"]');
    const canvasRect = required(".project-workbench-canvas").getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowVisibleHeight = Math.max(0, Math.min(rowRect.bottom, canvasRect.bottom) - Math.max(rowRect.top, canvasRect.top));

    return {
      workbench: rect(".professional-project-workbench"),
      toolbar: rect(".professional-project-toolbar"),
      canvas: rect(".project-workbench-canvas"),
      main: rect(".project-workbench-main"),
      material: rect(".material-workspace"),
      domainBar: rect(".material-domain-bar"),
      activeSubtitle: rect('.material-view-nav button[aria-current="page"] span'),
      slate: rect('[data-layout-test="golden-slate"]'),
      dataRow: rect('[data-layout-test="slate-data-row"]'),
      rowVisibleHeight,
      gridRows: getComputedStyle(workbench).gridTemplateRows.trim().split(/\s+/).filter(Boolean),
      mainOverflow: getComputedStyle(main).overflow,
    };
  });
}

function assertLayout(name, viewport, metrics) {
  assert.equal(metrics.gridRows.length, 2, `${name}: ProjectWorkbench must have exactly toolbar + canvas grid rows (${metrics.gridRows.join(" ")})`);
  approxEqual(metrics.canvas.top, metrics.toolbar.bottom, 1.5, `${name}: canvas must begin immediately after toolbar`);
  approxEqual(metrics.canvas.height, metrics.workbench.height - metrics.toolbar.height, 2, `${name}: canvas must consume the remaining workbench height`);
  assert.ok(metrics.canvas.height > viewport.height * 0.65, `${name}: production canvas collapsed to ${metrics.canvas.height}px`);
  assert.equal(metrics.mainOverflow, "hidden", `${name}: guard must exercise the production clipping boundary`);

  approxEqual(metrics.material.height, metrics.main.height, 2, `${name}: Material workspace must fill the production canvas`);
  assert.ok(metrics.domainBar.bottom <= metrics.canvas.bottom + 1, `${name}: Material domain bar escapes the production canvas`);
  assert.ok(metrics.activeSubtitle.top >= metrics.domainBar.top - 1, `${name}: active Material subtitle starts outside its bar`);
  assert.ok(metrics.activeSubtitle.bottom <= metrics.domainBar.bottom + 1, `${name}: active Material subtitle is clipped by its own bar`);
  assert.ok(metrics.activeSubtitle.bottom <= metrics.canvas.bottom + 1, `${name}: active Material subtitle is clipped by an ancestor canvas`);

  approxEqual(metrics.slate.top, metrics.domainBar.bottom, 2, `${name}: Slate must start directly after Material navigation`);
  assert.ok(metrics.slate.height > 250, `${name}: Slate body collapsed to ${metrics.slate.height}px`);
  assert.ok(metrics.slate.bottom <= metrics.canvas.bottom + 2, `${name}: Slate extends beyond the production canvas`);
  assert.ok(metrics.rowVisibleHeight > 0, `${name}: representative Slate data row is not visible`);
}

const server = await createServer({
  root: desktopRoot,
  configFile: false,
  logLevel: "error",
  plugins: [react(), goldenSlateStubPlugin()],
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "Vite layout runtime server did not expose a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.MIRRORORDER_CHROMIUM_EXECUTABLE?.trim();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "compact", width: 1024, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    try {
      await page.goto(`${baseUrl}/scripts/fixtures/project-workbench-layout.html`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-layout-test="slate-data-row"]', { state: "attached" });
      const metrics = await collectMetrics(page);
      assertLayout(viewport.name, viewport, metrics);
      assert.equal(pageErrors.length, 0, `${viewport.name}: runtime exception: ${pageErrors.map((error) => error.message).join(" | ")}`);
      console.log(`[layout-runtime] ${viewport.name} OK`, JSON.stringify(metrics));
    } catch (error) {
      mkdirSync(artifactDir, { recursive: true });
      const screenshot = resolve(artifactDir, `${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.error(`[layout-runtime] ${viewport.name} FAILED; screenshot: ${screenshot}`);
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
