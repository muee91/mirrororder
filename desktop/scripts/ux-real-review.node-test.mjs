import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { verifyReviewPlayback, verifyReviewQueueNavigation } from "./ux-real-review.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
// Other Vite checks can run against this root simultaneously. Their optimizer
// generations must not invalidate modules already loaded by this test browser.
const cacheDir = mkdtempSync(resolve(desktopRoot, "node_modules/.vite-ux-real-review-"));
// sample.webm is synthetic: ffmpeg -f lavfi -i testsrc=size=64x48:rate=12 -t 2 -c:v libvpx -b:v 40k -an sample.webm
const fixtureRoot = resolve(desktopRoot, "../tests/fixtures/desktop-review");
const model = JSON.parse(readFileSync(resolve(fixtureRoot, "review-model.json"), "utf8"));
let server;
let browser;

before(async () => {
  server = await createServer({
    root: desktopRoot, cacheDir, configFile: false, plugins: [react()],
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  });
  await server.listen();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

async function openReview(t, { empty = false, missingMedia = false, takeCount = 3, projectId = "project" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t.after(() => page.close());
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/review-model")) {
      return route.fulfill({ json: { ...model, project: { ...model.project, project_id: projectId }, take_groups: empty ? [] : model.take_groups.slice(0, takeCount) } });
    }
    if (path.endsWith("/workspace")) return route.fulfill({ json: { projects: [{ ...model.project, project_id: projectId }] } });
    if (path.includes("/media/")) {
      return missingMedia
        ? route.fulfill({ status: 404, json: { error: "media missing" } })
        : route.fulfill({ contentType: "video/webm", body: readFileSync(resolve(fixtureRoot, "sample.webm")) });
    }
    if (path.endsWith("/editorial")) return route.fulfill({ json: { revision: 0, opinions: {}, decisions: {} } });
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=${encodeURIComponent(projectId)}`);
  await page.locator(".professional-area-nav").getByRole("button", { name: "审阅", exact: true }).click();
  return page;
}

test("real ReviewWorkspace compact rows are counted and selection advances twice", async t => {
  const page = await openReview(t);
  const result = await verifyReviewQueueNavigation(page);
  assert.equal(result.total, 3);
  assert.deepEqual(result.positions, [1, 2, 3]);
  assert.equal(result.rendered_rows, 3);
});

test("fixture obtains the requested project summary instead of hardcoding project", async t => {
  const page = await openReview(t, { projectId: "synthetic-alternate" });
  assert.equal((await verifyReviewQueueNavigation(page)).total, 3);
  assert.equal(await page.locator(".professional-project-identity strong").innerText(), model.project.name);
});

test("an actually empty queue fails the required assertion", async t => {
  const page = await openReview(t, { empty: true });
  await assert.rejects(verifyReviewQueueNavigation(page), /审阅队列为空/);
});

test("a clickable but inert Next button fails the selection assertion", async t => {
  const page = await openReview(t);
  await page.waitForSelector('.review-queue [data-take-state="current"]');
  await page.getByRole("button", { name: "下一个", exact: true }).evaluate(button => {
    button.addEventListener("click", event => event.stopImmediatePropagation());
  });
  await assert.rejects(verifyReviewQueueNavigation(page, { timeout: 800 }), /当前 Take 未切换/);
});

test("a valid single-Take queue verifies its disabled Next control", async t => {
  const page = await openReview(t, { takeCount: 1 });
  assert.deepEqual((await verifyReviewQueueNavigation(page)).positions, [1]);
});

test("generated WebM loads and the actual video playback clock advances", async t => {
  const page = await openReview(t);
  await verifyReviewQueueNavigation(page);
  const result = await verifyReviewPlayback(page);
  assert(result.duration > 0);
  assert(result.current_time > 0.05);
  assert(result.ready_state >= 2);
});

test("media 404 remains a playback failure even though the queue works", async t => {
  const page = await openReview(t, { missingMedia: true });
  assert.equal((await verifyReviewQueueNavigation(page)).total, 3);
  await assert.rejects(verifyReviewPlayback(page), /审阅媒体不可播放.*素材无法读取/);
});

test("metadata without a running playback clock fails", async t => {
  const page = await openReview(t);
  await verifyReviewQueueNavigation(page);
  await page.locator("video.take-player").evaluate(video => {
    video.play = async () => undefined;
  });
  await assert.rejects(verifyReviewPlayback(page, { timeout: 800 }), /播放时间未推进/);
});

test("a play promise waiting forever for media data has a bounded timeout", async t => {
  const page = await openReview(t);
  await verifyReviewQueueNavigation(page);
  await page.locator("video.take-player").evaluate(video => {
    video.play = () => new Promise(() => {});
  });
  await assert.rejects(verifyReviewPlayback(page, { timeout: 800 }), /启动播放超时/);
});
