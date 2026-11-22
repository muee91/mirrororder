// Production layout runtime guard for the Desktop material workspace.
//
// It mounts the real ProjectWorkbench / MaterialWorkspace shell (the Slate body is
// stubbed so the guard measures workbench, navigation and pane geometry instead of
// Slate data) in Chromium and asserts that the canvas fills the window and that the
// document never overflows horizontally.
//
// Supported window sizes:
// - desktop 1280×800, 1440×900 and 1920×1080.
// - compact 1180×768: `tauri.conf.json` sets `minWidth: 1180` and `src/styles.css`
//   keeps html/body/#root at `min-width: 1180px`, so 1180 is the narrowest real
//   product window. A narrower viewport only measured a clipped 1180px surface and
//   could never fail, which is why the old 1024 viewport was a fake gate.
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
    const canvas = required(".project-workbench-canvas");
    const canvasRect = canvas.getBoundingClientRect();
    const canvasStyle = getComputedStyle(canvas);
    const rowRect = row.getBoundingClientRect();
    const rowVisibleHeight = Math.max(0, Math.min(rowRect.bottom, canvasRect.bottom) - Math.max(rowRect.top, canvasRect.top));

    return {
      workbench: rect(".professional-project-workbench"),
      toolbar: rect(".professional-project-toolbar"),
      layout: rect(".project-production-layout"),
      moduleNav: rect(".project-module-rail"),
      canvas: rect(".project-workbench-canvas"),
      canvasMargin: {
        top: parseFloat(canvasStyle.marginTop),
        right: parseFloat(canvasStyle.marginRight),
        bottom: parseFloat(canvasStyle.marginBottom),
        left: parseFloat(canvasStyle.marginLeft),
      },
      main: rect(".project-workbench-main"),
      material: rect(".material-workspace"),
      slate: rect('[data-layout-test="golden-slate"]'),
      dataRow: rect('[data-layout-test="slate-data-row"]'),
      rowVisibleHeight,
      gridRows: getComputedStyle(workbench).gridTemplateRows.trim().split(/\s+/).filter(Boolean),
      mainOverflow: getComputedStyle(main).overflow,
      innerWidth: window.innerWidth,
      documentWidth: document.scrollingElement?.scrollWidth ?? 0,
    };
  });
}

function assertLayout(name, viewport, metrics) {
  assert.equal(metrics.innerWidth, viewport.width, `${name}: browser viewport width drifted from the requested size`);
  assert.equal(metrics.gridRows.length, 2, `${name}: ProjectWorkbench must have exactly toolbar + canvas grid rows (${metrics.gridRows.join(" ")})`);
  // The module navigation and the inset canvas must fill the same project
  // body. Measure the canvas margins so the check also catches clipping at
  // the edge of the layout, where the canvas content is otherwise hidden.
  approxEqual(metrics.layout.top, metrics.toolbar.bottom, 1.5, `${name}: module layout must follow project header`);
  approxEqual(metrics.layout.height, metrics.workbench.height - metrics.toolbar.height, 2,
    `${name}: module layout must consume the workbench body`);
  const verticalRail = Math.abs(metrics.moduleNav.right - metrics.canvas.left) <= 2
    && Math.abs(metrics.moduleNav.top - metrics.canvas.top) <= 2;
  const horizontalRail = Math.abs(metrics.moduleNav.bottom + metrics.canvasMargin.top - metrics.canvas.top) <= 2
    && Math.abs(metrics.moduleNav.left + metrics.canvasMargin.left - metrics.canvas.left) <= 2
    && Math.abs(metrics.moduleNav.right - metrics.canvasMargin.right - metrics.canvas.right) <= 2;
  assert.ok(verticalRail || horizontalRail,
    `${name}: module rail must remain beside or immediately above the production canvas`);
  approxEqual(metrics.canvas.bottom + metrics.canvasMargin.bottom, metrics.layout.bottom, 2,
    `${name}: the inset canvas must fit within the bottom of the workbench`);
  assert.ok(metrics.canvas.height > viewport.height * 0.65, `${name}: production canvas collapsed to ${metrics.canvas.height}px`);
  assert.equal(metrics.mainOverflow, "hidden", `${name}: guard must exercise the production clipping boundary`);

  approxEqual(metrics.material.height, metrics.main.height, 2, `${name}: Material workspace must fill the production canvas`);
  approxEqual(metrics.slate.top, metrics.material.top, 2, `${name}: slate uses the full project workspace without a duplicate tab bar`);

  assert.ok(metrics.slate.height > 250, `${name}: Slate body collapsed to ${metrics.slate.height}px`);
  assert.ok(metrics.slate.bottom <= metrics.canvas.bottom + 2, `${name}: Slate extends beyond the production canvas`);
  assert.ok(metrics.rowVisibleHeight > 0, `${name}: representative Slate data row is not visible`);

  const boxes = [
    ["workbench", metrics.workbench],
    ["toolbar", metrics.toolbar],
    ["layout", metrics.layout],
    ["moduleNav", metrics.moduleNav],
    ["canvas", metrics.canvas],
    ["main", metrics.main],
    ["material", metrics.material],
    ["slate", metrics.slate],
    ["dataRow", metrics.dataRow],
  ];
  assert.ok(
    metrics.documentWidth <= metrics.innerWidth,
    `${name}: document scrolls horizontally (${metrics.documentWidth}px > ${metrics.innerWidth}px viewport)`,
  );
  const escaped = boxes
    .filter(([, box]) => box.left < -0.5 || box.right > metrics.innerWidth + 0.5)
    .map(([label, box]) => `${label} [${box.left.toFixed(1)}, ${box.right.toFixed(1)}]`);
  assert.deepEqual(escaped, [], `${name}: layout escapes the ${metrics.innerWidth}px viewport horizontally: ${escaped.join(", ")}`);
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
    { name: "small-desktop", width: 1280, height: 800 },
    { name: "desktop", width: 1440, height: 900 },
    { name: "large-desktop", width: 1920, height: 1080 },
    // 1180 = tauri.conf.json minWidth = styles.css root min-width, the real floor.
    { name: "compact", width: 1180, height: 768 },
  ]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    try {
      await page.goto(`${baseUrl}/scripts/fixtures/project-workbench-layout.html`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-layout-test="slate-data-row"]', { state: "attached" });
      await page.locator(".professional-project-toolbar").getByRole("button", { name: "小镜", exact: true }).waitFor({ state: "visible" });
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
