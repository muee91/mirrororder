// P0 evidence gate: drives the Production surfaces against the real local Host at
// real project scale, asserts the main chain actually rendered, and archives the run.
//
// Prerequisite (explicit, never auto-started):
//   PYTHONPATH=src python3 script-organizer serve workspace.toml --port 8795
//   cd desktop
//   MIRRORORDER_HOST_URL=http://127.0.0.1:8795 MIRRORORDER_UX_PROJECT_ID=project npm run check:ux-real
//
// Semantics this file must keep honest:
//   exit 2 = NOT RUN (no Host reachable); never a PASS.
//   exit 1 = FAIL (a required step did not render/assertion failed).
//   exit 0 = PASS (all required steps asserted green); optional steps print WARN only.
// Artifacts land in desktop/artifacts/ux-real/<run>/ (git-ignored) so the evidence can
// be reviewed after the fact instead of living in /tmp and vanishing.
//
// Known limitation, printed in the report: this mounts the ux-real fixture shell, not
// the packaged Application shell, so a PASS here proves data/render/interaction health
// at the surface level — it is not a substitute for the packaged-app acceptance run.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { verifyReviewPlayback, verifyReviewQueueNavigation } from "./ux-real-review.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostUrl = (process.env.MIRRORORDER_HOST_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
const projectId = process.env.MIRRORORDER_UX_PROJECT_ID?.trim() || "project";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = resolve(desktopRoot, "artifacts", "ux-real", runId);

async function hostReachable() {
  try {
    const response = await fetch(`${hostUrl}/api/v1/ping`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return response.ok && body?.status === "ok" && body?.service === "mirrororder-host";
  } catch {
    return false;
  }
}

if (!(await hostReachable())) {
  console.log(`NOT RUN: 没有可达的 MirrorOrder Host（${hostUrl}/api/v1/ping）。`);
  console.log("NOT RUN: 先按文件头部说明启动 Host，再重跑本 gate；本次没有产生任何验收证据。");
  process.exit(2);
}

mkdirSync(artifactDir, { recursive: true });

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// The gate profile is fresh every run; seed the operator identity and the guided
// flag so the first-use onboarding popover cannot cover the buttons later steps
// click. Mirrors what a returning user's browser already has.
await page.addInitScript(() => {
  try {
    globalThis.localStorage.setItem("mirrororder.productionActor", "镜序验收");
    globalThis.localStorage.setItem("mirrororder.operator-guided", "1");
    globalThis.localStorage.setItem("mirrororder.desktop-v2.review-actor", "镜序验收");
  } catch { /* storage unavailable: surfaces fall back to their own prompts */ }
});
const started = Date.now();
const apiLog = [];
const consoleErrors = [];
page.on("response", (response) => {
  if (response.url().includes("/api/")) {
    apiLog.push({ status: response.status(), path: response.url().split("/api/")[1], ms: Date.now() - started });
  }
});
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
});

const results = [];
const timings = [];

async function shot(name) {
  await page.screenshot({ path: resolve(artifactDir, `${name}.png`) });
}

/**
 * A step is required unless it explicitly opts out with a reason. Recording a failure
 * instead of throwing keeps the run going so one broken surface does not hide the state
 * of the rest of the chain — but the recorded failure decides the exit code.
 */
async function step(label, action, { required = true, reason = "" } = {}) {
  const start = Date.now();
  try {
    const detail = await action();
    const ms = Date.now() - start;
    timings.push({ label, ms, status: "PASS" });
    results.push({ label, status: "PASS", required, ms, detail: detail ?? null });
    const summary = typeof detail === "object" ? JSON.stringify(detail) : detail;
    console.log(`PASS  ${label} (${ms}ms)${summary ? ` — ${summary}` : ""}`);
  } catch (error) {
    const ms = Date.now() - start;
    const message = String(error.message ?? error).split("\n")[0];
    const status = required ? "FAIL" : "WARN";
    timings.push({ label, ms, status });
    results.push({ label, status, required, ms, message, optional_reason: required ? null : reason });
    console.log(`${status}  ${label} (${ms}ms) — ${message}`);
    // Chinese labels collapse to an empty slug under [^\w]; index the file instead of
    // the label so two failures in one run cannot overwrite each other's evidence.
    await shot(`fail-${String(results.length).padStart(2, "0")}`);
  }
}

async function clickWorkspace(name) {
  await page.getByRole("button", { name }).first().click({ timeout: 10000 });
}

function firstFailureText() {
  return apiLog.filter((row) => row.status >= 400).slice(-6).map((row) => `${row.status} ${row.path}`).join(" | ");
}

await page.goto(`${baseUrl}/scripts/fixtures/ux-real.html?project_id=${encodeURIComponent(projectId)}`, { timeout: 60000 });
await step("shell mount", async () => {
  await page.waitForSelector(".project-production-workbench, [role='alert']", { timeout: 30000 });
  if (await page.locator("[role='alert']").count()) throw new Error(await page.locator("[role='alert']").first().innerText());
  const title = await page.evaluate(() => document.body.innerText.slice(0, 80).replace(/\s+/g, " "));
  return title;
});

await step("剧本：ScriptBlock 主画布渲染", async () => {
  await clickWorkspace(/^剧本$/);
  await page.waitForSelector(".script-block", { timeout: 30000 });
  const count = await page.locator(".script-block").count();
  if (count < 1) throw new Error(`剧本画布只有 ${count} 个 ScriptBlock`);
  return `${count} 个剧本块`;
});
await shot("script");

await step("剧本：搜索后仍有结果或给出可读空状态", async () => {
  const search = page.getByRole("searchbox", { name: "搜索剧本" });
  await search.click();
  await search.type(process.env.MIRRORORDER_UX_QUERY ?? "账本", { delay: 40 });
  await page.waitForTimeout(600);
  const blocks = await page.locator(".script-block").count();
  if (blocks > 0) return `${blocks} 个结果`;
  // Zero matches is a legitimate outcome; the defect being guarded against is an
  // unexplained blank canvas, so the empty state itself has to be asserted.
  const emptyCopy = page.locator(".empty-copy");
  if ((await emptyCopy.count()) < 1) throw new Error("搜索后既无结果也没有可读的空状态说明");
  return `0 个结果，空状态文案：${(await emptyCopy.first().innerText()).slice(0, 40)}`;
});
await shot("script-search");

await step("剧本：段详情抽屉可开可关", async () => {
  await page.getByRole("button", { name: "匹配素材" }).first().click({ timeout: 8000 });
  await page.waitForSelector(".workspace-context-drawer", { timeout: 10000 });
  await page.getByRole("button", { name: "关闭" }).first().click({ timeout: 5000 });
  await page.waitForSelector(".workspace-context-drawer", { state: "detached", timeout: 10000 });
}, { required: false, reason: "部分项目在剧本段上没有匹配素材入口" });
await shot("drawer");

await step("审阅：队列非空并可连续换 Take", async () => {
  await clickWorkspace(/^审阅$/);
  return verifyReviewQueueNavigation(page);
});
await shot("review");

await step("审阅：媒体加载并实际播放", () => verifyReviewPlayback(page));
await shot("review-playback");

await step("素材：Take/场记画布渲染", async () => {
  await clickWorkspace(/^素材$/);
  await page.waitForTimeout(2500);
  const cards = await page.locator(".take-card, .mo-take-list-row, .mo-media-card, .slate-row").count();
  if (cards < 1) throw new Error("素材画布没有渲染任何 canonical 对象");
  return `${cards} 个对象`;
});
await shot("material");

await step("时间线：编辑器画布就绪", async () => {
  await clickWorkspace(/^时间线$/);
  await page.waitForTimeout(2500);
  const stage = await page.locator("[class*=timeline], [class*=editor-stage], .timeline-track").count();
  if (stage < 1) throw new Error("时间线画布没有渲染");
  return `${stage} 个时间线元素`;
});
await shot("timeline");

const requiredFailures = results.filter((row) => row.status === "FAIL");
const verdict = requiredFailures.length ? "FAIL" : "PASS";
const report = {
  verdict,
  run_id: runId,
  host: hostUrl,
  project_id: projectId,
  surface_note: "ux-real fixture shell; packaged-app acceptance is a separate native gate",
  acceptance_not_run: ["人工 placement 与最终决定写入", "Rust Timeline 插入与持久化", "原生播放、声音与 A/V 同步"]
    .map((check) => ({ check, status: "NOT RUN" })),
  timed: timings,
  steps: results,
  http_failures: apiLog.filter((row) => row.status >= 400),
  console_errors: consoleErrors,
  heaviest_api_calls: [...apiLog].sort((left, right) => right.ms - left.ms).slice(0, 12),
};
writeFileSync(resolve(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log("---");
console.log(timings.map((row) => `${row.label}: ${row.ms}ms`).join("\n"));
if (consoleErrors.length) console.log(`console.error 计数: ${consoleErrors.length}`);
console.log(`证据目录: ${artifactDir}`);
console.log(`${verdict}: 必需步骤 ${results.filter((row) => row.required).length} 项，失败 ${requiredFailures.length} 项`);
if (requiredFailures.length) console.log(`首个失败: ${requiredFailures[0].label} — ${requiredFailures[0].message}${firstFailureText() ? ` | ${firstFailureText()}` : ""}`);

await browser.close();
await server.close();
process.exit(requiredFailures.length ? 1 : 0);
