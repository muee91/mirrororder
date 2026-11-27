import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { formatPlaybackFailure, verifyReviewPlayback, verifyReviewQueueNavigation } from "./ux-real-review.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
// Other Vite checks can run against this root simultaneously. Their optimizer
// generations must not invalidate modules already loaded by this test browser.
const cacheDir = mkdtempSync(resolve(desktopRoot, "node_modules/.vite-ux-real-review-"));
// sample.webm is synthetic: ffmpeg -f lavfi -i testsrc=size=64x48:rate=12 -t 2 -c:v libvpx -b:v 40k -an sample.webm
const fixtureRoot = resolve(desktopRoot, "../tests/fixtures/desktop-review");
const model = JSON.parse(readFileSync(resolve(fixtureRoot, "review-model.json"), "utf8"));
let server;
let browser;

test("normalizes Linux Chromium source error 4 without hiding playback failure", () => {
  assert.equal(formatPlaybackFailure(4), "素材无法读取");
  assert.equal(formatPlaybackFailure(3), "媒体解码错误 3");
});

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

function serveFixtureVideo(route) {
  const bytes = readFileSync(resolve(fixtureRoot, "sample.webm"));
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
  if (!range) return route.fulfill({ contentType: "video/webm", body: bytes });
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
  if (start > end) return route.fulfill({ status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
  return route.fulfill({ status: 206, contentType: "video/webm",
    headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
    body: bytes.subarray(start, end + 1),
  });
}

async function openReview(t, { empty = false, missingMedia = false, reviewUnavailable = false, takes = model.take_groups, episodes = model.episodes, takeCount = 3, projectId = "project", slate, speech } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const projectName = projectId === "synthetic-alternate" ? "Synthetic Alternate Project" : model.project.name;
  t.after(() => page.close());
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/review-model")) {
      if (reviewUnavailable) return route.fulfill({ status: 503, json: { error: "暂时无法读取审阅队列" } });
      return route.fulfill({ json: { ...model, episodes, project: { ...model.project, project_id: projectId, name: projectName }, take_groups: empty ? [] : takes.slice(0, takeCount) } });
    }
    if (path.endsWith("/workspace")) return route.fulfill({ json: { projects: [{ ...model.project, project_id: projectId, name: projectName }] } });
    if (speech && path.endsWith("/speech-evidence")) {
      const clipId = new URL(route.request().url()).searchParams.get("clip_id");
      if (speech[clipId]) return route.fulfill({ json: speech[clipId] });
    }
    if (path.includes("/media/")) {
      return missingMedia
        ? route.fulfill({ status: 404, json: { error: "media missing" } })
        : serveFixtureVideo(route);
    }
    if (path.endsWith("/editorial")) return route.fulfill({ json: { revision: 0, opinions: {}, decisions: {} } });
    if (slate && path.endsWith("/script-supervisor")) return route.fulfill({ json: slate });
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=${encodeURIComponent(projectId)}`);
  await page.locator(".project-module-rail").getByRole("button", { name: /^看片审阅/ }).click();
  return page;
}

test("review command targets stay anchored across script lengths, result ranges, search, and watch mode", async t => {
  const takes = structuredClone(model.take_groups.slice(0, 2));
  const blocks = ["好。", "她穿过庭院，回头看了看停在门口的人。".repeat(50), "还没找到对应镜头。"].map((text, index) => ({
    segment_id: `line-${index}`, type: "dialogue", text, raw_text: text, order: index, episode: 1,
    scene_id: "1-1", speaker: index === 1 ? "一位很久没有回到村子的客人" : "许", issues: [],
  }));
  const episodes = [{ episode: 1, scenes: [{ scene_id: "1-1", heading: "村口", script_blocks: blocks, take_group_ids: [] }] }];
  takes[0].effective_mapping = { source: "human", script_segment_ids: ["line-0", "line-1"], episode_ids: [1], mapping_status: "confirmed" };
  const primary = [".review-mode-switch", ".review-search-scope", ".review-search-input", ".review-filters select", ".review-hide-ng"];
  const range = [1, 2, 3].map(index => `.review-coverage-range button:nth-child(${index})`);
  const page = await openReview(t, { takes, episodes });
  await page.waitForFunction(() => {
    const frame = document.querySelector(".review-coverage-card .mo-media-thumb");
    const poster = frame?.querySelector("canvas");
    const video = frame?.querySelector("video");
    return poster?.dataset.painted === "true" && video?.currentTime > 0 &&
      poster.getContext("2d").getImageData(poster.width >> 1, poster.height >> 1, 1, 1).data[3] === 255;
  });
  async function boxes(selectors) {
    await page.evaluate(() => document.fonts.ready);
    return page.evaluate(selectors => selectors.map(selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return [x, y, width, height];
    }), selectors);
  }
  for (const [width, height] of [[1440, 900], [1180, 640], [740, 760]]) {
    await page.setViewportSize({ width, height });
    const lines = page.locator(".review-outline-line");
    await lines.nth(0).click();
    const take = page.locator(".review-coverage-card").first();
    await take.waitFor();
    const headerTargets = [...primary, ...range];
    const cardTargets = [".review-coverage-card-list", ".review-coverage-card .review-open-slate"];
    const headers = await boxes(headerTargets);
    const card = await boxes(cardTargets);
    assert.ok(headers.slice(0, primary.length).every((r) => r[3] === 34), `toolbar control height at ${width}`);
    await lines.nth(1).click();
    assert.equal(await lines.nth(1).getAttribute("aria-pressed"), "true");
    assert.equal(await lines.nth(1).locator(".review-outline-text").textContent(), blocks[1].text);
    assert.deepEqual(await boxes(headerTargets), headers, `long text at ${width}`);
    assert.deepEqual(await boxes(cardTargets), card, `first card and slate action at ${width}`);
    await page.getByRole("button", { name: "在全项目找", exact: true }).click();
    assert.deepEqual(await boxes(headerTargets), headers);
    await lines.nth(2).click();
    await page.getByRole("button", { name: "在本集找素材", exact: true }).click();
    await page.getByText("这段剧本还没有关联素材，可从下方找到对应画面。", { exact: true }).waitFor();
    assert.deepEqual(await boxes(headerTargets), headers, "missing footage hint");
    const query = page.getByLabel("搜索审阅素材");
    await query.fill("不存在的画面".repeat(12));
    assert.deepEqual(await boxes(primary), headers.slice(0, primary.length));
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    await page.getByLabel("选片状态").selectOption("slate_ng");
    assert.deepEqual(await boxes(headerTargets), headers, "NG filter and empty result");
    await page.getByLabel("选片状态").selectOption("all");
    await page.getByRole("button", { name: "逐条看片", exact: true }).click();
    await page.getByLabel("按集筛选").selectOption("1");
    assert.deepEqual(await boxes(primary), headers.slice(0, primary.length), "watch mode with episode candidates");
    await page.getByRole("button", { name: "剧本对照", exact: true }).click();
  }
});

test("material filter targets stay in place when search, file counts and inventory freshness change", async t => {
  const page = await openReview(t);
  await page.setViewportSize({ width: 1180, height: 640 });
  let count = 2;
  await page.route("**/media-inventory", route => route.fulfill({ json: {
    project_id: "project", contract: "media-inventory.v1", scan_required: count > 2,
    summary: { files: count, indexed: count, unindexed: 0, labeled: 0, auxiliary: 0 },
    items: Array.from({ length: count }, (_, i) => ({
      media_id: `sample-${i}`, display_name: `C${i}.mov`, inferred_camera: "A", indexed: true,
      state: count > 2 ? "missing" : "online", label: {},
    })), semantics: {},
  } }));
  await page.route("**/media-roles", route => route.fulfill({ json: { contract: "media-roles.v1", revision: 1, media: {} } }));
  await page.locator(".project-module-rail").getByRole("button", { name: "素材库", exact: true }).click();
  const files = page.locator(".media-library-filters button").first().locator("small");
  await files.getByText("2", { exact: true }).waitFor();
  const targets = page.locator(".media-library-toolbar input, .media-library-toolbar button:not(.media-library-more-popover button), .media-library-more-menu > summary");
  const bounds = () => targets.evaluateAll(items => items.map(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return [x, y, width, height];
  }));
  const original = await bounds();
  await page.getByLabel("搜索素材", { exact: true }).fill("这一批没有对应文件名");
  assert.deepEqual(await bounds(), original, "typing and clearing a filter");
  await page.getByRole("button", { name: "清除所有素材筛选" }).click();
  count = 125;
  await page.getByRole("button", { name: "刷新素材清单" }).click();
  await files.getByText("125", { exact: true }).waitFor();
  await page.getByText("上次清单 · 待重新扫描", { exact: true }).waitFor();
  assert.deepEqual(await bounds(), original, "counts, empty categories and a stale inventory");
});

test("an action opens the nearby dialogue recording and keeps a separate insert and its own camera clock", async t => {
  const [dialogueTake, insert, otherScene] = structuredClone(model.take_groups.slice(0, 3));
  const block = (segment_id, type, text, order) => ({ segment_id, type, text, raw_text: text, order, episode: 1,
    scene_id: "room", speaker: type === "dialogue" ? "江遥" : "", issues: [] });
  const action = block("glass", "action", "她接过杯子。", 2);
  const line = block("words", "dialogue", "（递出杯子）先喝口水。", 1);
  const elsewhere = { ...line, segment_id: "elsewhere", scene_id: "hall" };
  const takes = [dialogueTake, insert, otherScene];
  for (const [index, id] of [line.segment_id, action.segment_id, elsewhere.segment_id].entries()) {
    takes[index].effective_mapping = { source: "human", script_segment_ids: [id], episode_ids: [1], mapping_status: "confirmed" };
  }
  const episodes = [{ episode: 1, scenes: [{ scene_id: "room", heading: "房间", script_blocks: [line, action], take_group_ids: [] },
    { scene_id: "hall", heading: "外景", script_blocks: [elsewhere], take_group_ids: [] }] }];
  const angle = dialogueTake.angles[0];
  const speech = { [angle.clip_id]: { contract: "mirrororder.speech_evidence.v1", coordinate_space: "source-relative-seconds",
    status: "available", outcome: "transcribed", clip_id: angle.clip_id, media_id: angle.media_id,
    segments: [{ start: 0.6, end: 1.65, text: "先喝口水" }] } };
  const page = await openReview(t, { takes, episodes, speech });
  const writes = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/review")) writes.push(request.url()); });
  await page.locator(".review-coverage-neighbors").getByRole("button", { name: /她接过杯子/ }).click();
  const cards = page.locator(".review-coverage-card");
  await cards.nth(1).waitFor();
  assert.equal(await cards.count(), 2);
  assert.match(await cards.first().innerText(), /人工归属/);
  assert.match(await cards.nth(1).innerText(), /可能同拍 · 待核画面/);
  const cue = cards.nth(1).getByRole("button", { name: /定位A机相邻台词 0:00.6/ });
  await cue.click();
  await page.waitForFunction(() => {
    const video = document.querySelector(".review-monitor-picture video");
    return video && !video.seeking && Math.abs(video.currentTime - 0.6) < 0.09;
  });
  await page.getByRole("button", { name:"剧本对照", exact:true }).click();
  await cards.nth(1).getByRole("button", { name: "去确认同拍" }).click();
  const pair = page.getByRole("region", { name: "动作与台词同拍" });
  await pair.getByRole("button", { name: "确认动作与台词同拍" }).waitFor();
  assert.match(await pair.innerText(), /先喝口水/);
  assert.deepEqual(writes, []);
});

test("the startup Host address can be typed and corrected after an invalid submission", async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText("手动打开与连接", { exact: true }).click();
  const address = page.getByLabel("本机服务地址");
  await address.fill("");
  await address.pressSequentially("h");
  await address.press("Enter");
  await page.getByText("高级连接地址无效。", { exact: true }).waitFor();
  await address.fill("");
  await address.pressSequentially("http://127.0.0.1:8765");
  assert.equal(await address.inputValue(), "http://127.0.0.1:8765");
  assert.equal(await page.getByRole("button", { name: "连接已运行服务" }).isEnabled(), true);
});

test("review exposes the recorded reason, usable interval and camera scope independently from the editorial choice", async t => {
  const [first, next] = structuredClone(model.take_groups);
  const a = first.angles[0];
  const b = { ...a, camera: "B", clip_id: "B_second", media_id: "M_second", name: "B.webm" };
  first.angles.push(b);
  first.editorial_state.editorial_decision = { group: { state: "keep", actor: "剪辑师" } };
  const makeRecord = (id, take, status, note) => ({ record_id: id, source_group_id: take.group_id, status, note,
    episode: 1, scene: "1", shot: "", script_scene_id: "", take_number: 1, preferred_clip_id: "", attachments: [], updated_at: "", actor: "场记" });
  const main = { ...makeRecord("main", first, "partial", "入画以后可用"), preferred_clip_id: a.clip_id, usable_range: { start: 0.5, end: 1.8 } };
  const lens = { ...makeRecord("lens", { group_id: "" }, "ng", "尾段虚焦"), attachments: [{ clip_id: b.clip_id, media_id: b.media_id, camera: b.camera, display_name: b.name, source_role: "", shot_type: "unknown", note: "焦点落在背景" }] };
  const second = makeRecord("second", next, "ng", "收音中断");
  const slate = { revision: 1, records: { main, lens, second }, entries: {} };
  const page = await openReview(t, { takes: [first, next], takeCount: 2, slate });
  const cards = page.locator(".review-take-card");
  await cards.first().getByText("场记 部分可用", { exact: true }).waitFor();
  assert.match(await cards.first().innerText(), /剪辑 · 保留/);
  assert.match(await cards.first().innerText(), /0:00.5–0:01.8/);
  assert.match(await cards.first().innerText(), /入画以后可用/);
  await page.getByRole("button", { name: "隐藏场记 NG" }).click();
  assert.equal(await cards.count(), 1);
  await page.getByLabel("选片状态").selectOption("slate_ng");
  assert.equal(await cards.count(), 2);
  await page.getByLabel("选片状态").selectOption("slate_partial");
  await page.getByRole("button", { name: "多机位同看", exact: true }).click();
  const popup = page.getByRole("dialog");
  const lenses = popup.locator(".review-mc-angle");
  assert.match(await lenses.first().innerText(), /场记首选机位/);
  assert.doesNotMatch(await lenses.first().innerText(), /尾段虚焦|场记 NG/);
  assert.match(await lenses.nth(1).innerText(), /场记 NG/);
  assert.match(await lenses.nth(1).innerText(), /焦点落在背景/);
  await popup.getByRole("button", { name: "返回审阅" }).click();
  await page.getByLabel("选片状态").selectOption("reject");
  assert.equal(await cards.count(), 0);
});

test("real ReviewWorkspace compact rows are counted and selection advances twice", async t => {
  const page = await openReview(t);
  const result = await verifyReviewQueueNavigation(page);
  assert.equal(result.total, 3);
  assert.deepEqual(result.positions, [1, 2, 3]);
  assert.equal(result.rendered_rows, 3);
});

test("reviewer can recover a failed initial queue read without leaving the page", async t => {
  const page = await openReview(t, { reviewUnavailable: true });
  const retry = page.getByRole("button", { name: "重新读取审阅队列" });
  await retry.waitFor();
  await page.route("**/review-model", route => route.fulfill({ json: model }));
  await retry.click();
  await page.locator(".review-queue .review-take-select").first().waitFor();
  assert.equal(await page.locator(".review-queue .review-take-select").count(), 3);
});

test("the focused queue follows arrow keys and restores the ordinary Take's paused playhead", async t => {
  const page = await openReview(t);
  await page.setViewportSize({ width: 1180, height: 640 });
  const rows = page.locator(".review-take-select");
  await rows.first().focus();
  await rows.first().press("ArrowDown");
  assert.equal(await rows.nth(1).evaluate(row => row === document.activeElement), true);
  const video = page.locator(".review-monitor-picture video");
  await page.waitForFunction(() => {
    const v = document.querySelector(".review-monitor-picture video");
    return v?.dataset.clipId === "C_TEST_2" && v.readyState >= 2;
  });
  await video.evaluate(v => { v.currentTime = 0.85; });
  await page.waitForFunction(() => !document.querySelector(".review-monitor-picture video").seeking);
  const dock = page.locator(".review-action-dock");
  await dock.getByRole("button", { name: "下一条" }).click();
  await page.locator('.review-take-select[aria-pressed="true"]').filter({ hasText: "Take #3" }).waitFor();
  await dock.getByRole("button", { name: "上一条" }).click();
  await page.waitForFunction(() => {
    const v = document.querySelector(".review-monitor-picture video");
    return v?.dataset.clipId === "C_TEST_2" && v.readyState >= 2 && !v.seeking
      && v.paused && Math.abs(v.currentTime - 0.85) < 0.05;
  });
  const controlBounds = await dock.boundingBox();
  assert.ok(controlBounds && controlBounds.y + controlBounds.height <= 640);
  assert.ok((await video.boundingBox()).height >= 270, "keep the portrait picture usable at the smallest desktop window");
});

test("single-Take playback and queue previews use each source's native shape", async t => {
  const page = await openReview(t);
  const video = page.locator(".review-monitor-picture video");
  for (const [width, height] of [[1180, 640], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    for (const [w, h] of [[216, 384], [240, 240], [384, 216]]) {
      await page.locator(".review-monitor-picture video, .review-take-card.is-selected .mo-media-thumb video").evaluateAll((videos, [w, h]) => {
        for (const v of videos) {
          v.srcObject?.getTracks().forEach(track => track.stop());
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const source = canvas.captureStream(1);
          v.srcObject = source;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#4682b4";
          ctx.fillRect(0, 0, w, h);
          source.getVideoTracks()[0].requestFrame();
        }
      }, [w, h]);
      await page.waitForFunction(([w, h]) => {
        const monitor = document.querySelector(".review-monitor-picture video");
        const thumb = document.querySelector(".review-take-card.is-selected .mo-media-thumb:has(video)");
        if (monitor?.videoWidth !== w || !thumb) return false;
        return [monitor, thumb].every(node => {
          const box = node.getBoundingClientRect();
          return box.height > 20 && Math.abs(box.width / box.height - w / h) < 0.025;
        });
      }, [w, h], { timeout: 6000 });
      const geometry = await video.evaluate(v => Object.fromEntries([v, v.parentElement, v.parentElement.parentElement,
        v.closest(".take-inspector"), v.closest(".review-viewer-body")].map(node => [node.className,
          [node.clientWidth, node.clientHeight, getComputedStyle(node).display, getComputedStyle(node).flex]])));
      assert.ok((await video.boundingBox()).height >= 200, JSON.stringify({ width, height, w, h, geometry }));
    }
  }
});

test("returning to a paused Take uses its presented frame when the playback clock lags", async t => {
  const page = await openReview(t);
  const video = page.locator(".review-monitor-picture video");
  const shown = await video.evaluate(async player => {
    let frameTime = 0;
    let callback;
    const track = (_, frame) => {
      frameTime = frame.mediaTime;
      callback = player.requestVideoFrameCallback(track);
    };
    callback = player.requestVideoFrameCallback(track);
    await player.play();
    await new Promise(resolve => {
      function check() {
        if (frameTime >= 0.6) resolve();
        else requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
    player.pause();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    player.cancelVideoFrameCallback(callback);
    // WebKit can freeze currentTime at the preceding timeupdate on pause.
    Object.defineProperty(player, "currentTime", { configurable: true, get: () => frameTime - 0.21 });
    return frameTime;
  });
  await page.getByRole("button", { name: "下一条", exact: true }).click();
  await page.getByRole("button", { name: "上一条", exact: true }).click();
  await page.waitForFunction(expected => {
    const v = document.querySelector(".review-monitor-picture video");
    return v?.dataset.clipId === "C_TEST_1" && v.readyState >= 2 && v.paused
      && !v.seeking && Math.abs(v.currentTime - expected) < 0.04;
  }, shown);
});

test("a long queue keeps the full shooting order while mounting only nearby footage", async t => {
  const original = model.take_groups[0];
  const takes = Array.from({ length: 512 }, (_, index) => {
    const angle = original.angles[0];
    const clipId = `C_LONG_${index}`;
    return { ...original, group_id: `G_LONG_${index}`, start: index * 2, end: index * 2 + 2, take_index: index + 1,
      angles: [{ ...angle, clip_id: clipId, name: `camera-${index}.webm`,
        playback: { ...angle.playback, url: `/api/v1/projects/project/media/${clipId}` } }],
    };
  });
  const page = await openReview(t, { takes, takeCount: takes.length });
  const list = page.locator(".review-take-card-list");
  const first = list.locator('[data-queue-index="0"]');
  const last = list.locator('[data-queue-index="511"]');
  await first.focus();
  await first.press("End");
  await last.waitFor();
  assert.equal(await last.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator(".review-monitor-title strong").innerText(), "Take #512");
  assert.ok(await list.evaluate(el => el.scrollTop > 0));
  assert.ok(await list.locator(".review-take-select").count() < 50);
  await last.press("ArrowUp");
  assert.equal(await page.locator(".review-monitor-title strong").innerText(), "Take #511");
  await list.locator('[data-queue-index="510"]').press("Home");
  assert.equal(await page.locator(".review-monitor-title strong").innerText(), "Take #1");
  assert.equal(await first.evaluate(el => el === document.activeElement), true);
  await page.getByRole("group", { name: "结果视图" }).getByRole("button", { name: "片段" }).click();
  await list.locator(".review-fragment-card").first().waitFor();
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await list.getByRole("button", { name: /查看 Take #512/ }).click();
  await last.waitFor();
  assert.equal(await page.locator(".review-monitor-title strong").innerText(), "Take #512");
});

test("fixture obtains the requested project summary instead of hardcoding project", async t => {
  const page = await openReview(t, { projectId: "synthetic-alternate" });
  assert.equal((await verifyReviewQueueNavigation(page)).total, 3);
  assert.equal(
    await page.locator(".professional-project-workbench").getAttribute("aria-label"),
    "项目工作台：Synthetic Alternate Project",
  );
});

test("an actually empty queue fails the required assertion", async t => {
  const page = await openReview(t, { empty: true });
  await assert.rejects(verifyReviewQueueNavigation(page), /审阅队列为空/);
});

test("a clickable but inert Next button fails the selection assertion", async t => {
  const page = await openReview(t);
  await page.waitForSelector('.review-queue .review-take-select[aria-pressed="true"]');
  await page.getByRole("button", { name: "下一条", exact: true }).evaluate(button => {
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

test("decision conflict recovery requires a read retry and refreshes the real review queue", async t => {
  const page = await openReview(t);
  const panel = page.locator(".review-decision-panel");
  await panel.locator(".editorial-decision-actions button:not([disabled])").first().waitFor();
  const commandBounds = () => page.locator(".editorial-decision-actions button[aria-pressed], .review-transport-actions button")
    .evaluateAll(buttons => buttons.map(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return [x, y, width, height];
    }));
  const beforeFeedback = await commandBounds();
  const groupId = model.take_groups[0].group_id;
  const finalDecision = {
    target: { kind: "group", group_id: groupId, segment_id: "" },
    state: "keep", actor: "另一位剪辑师", updated_at: "",
  };
  let writes = 0;
  let recoveryReads = 0;
  await page.route("**/editorial-decision", route => {
    writes += 1;
    return route.fulfill({ status: 409, json: { error: "团队意见已更新" } });
  });
  await page.route("**/editorial", route => {
    recoveryReads += 1;
    if (recoveryReads === 1) return route.fulfill({ status: 503, json: { error: "暂时无法读取团队状态" } });
    return route.fulfill({ json: { revision: 2, opinions: {}, decisions: { [`group|${groupId}`]: finalDecision } } });
  });
  await page.route("**/review-model", route => route.fulfill({
    json: {
      ...model,
      take_groups: model.take_groups.slice(0, 3).map(take => take.group_id === groupId ? {
        ...take,
        editorial_state: { ...take.editorial_state, editorial_decision: { group: finalDecision, assignments: [] } },
      } : take),
    },
  }));

  // The editor identity now lives in the shared operator control, not in a
  // duplicate per-Take textbox. Set the same device-local identity and notify
  // the current ReviewDecisionPanel before exercising the real write path.
  await page.evaluate(() => {
    window.localStorage.setItem("mirrororder.productionActor", "当前剪辑师");
    window.localStorage.setItem("mirrororder.desktop-v2.review-actor", "当前剪辑师");
    window.dispatchEvent(new CustomEvent("mirrororder:operator-change", { detail: "当前剪辑师" }));
  });
  await panel.getByRole("button", { name: "首选", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "最新状态读取失败" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "首选", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByText("当前 Take 尚未形成最终决定。", { exact: true }).count(), 0);

  assert.deepEqual(await commandBounds(), beforeFeedback, "read-error feedback keeps the decision and transport buttons anchored");
  await panel.getByRole("button", { name: "重新读取状态", exact: true }).click();
  await panel.locator("button.is-selected.state-keep").waitFor();
  await page.locator(".review-queue .review-take-card.is-selected .review-final-state.state-keep").waitFor();
  assert.equal(await panel.getByRole("button", { name: "首选", exact: true }).isDisabled(), false);
  assert.deepEqual(await commandBounds(), beforeFeedback, "saved judgment and clear action preserve all previous targets");
  assert.equal(writes, 1, "conflicting 首选 must not be replayed after the read retry");
  assert.equal(recoveryReads, 2);
});

for (const [direction, expected] of [["上一条", "Take #1"], ["下一条", "Take #3"]]) {
  test(`a decided Take stays in the monitor, then ${direction} continues from its former queue position`, async t => {
    const page = await openReview(t);
    await page.getByRole("combobox", { name: "选片状态" }).selectOption("unreviewed");
    await page.locator(".review-take-select").nth(1).click();
    const groupId = model.take_groups[1].group_id;
    const decision = { target: { kind: "group", group_id: groupId }, state: "keep", actor: "剪辑师", updated_at: "" };
    await page.route("**/editorial-decision", route => {
      assert.equal(route.request().postDataJSON().group_id, groupId);
      return route.fulfill({ json: { editorial: { revision: 1, opinions: {}, decisions: { [`group|${groupId}`]: decision } } } });
    });
    await page.route("**/review-model", route => route.fulfill({ json: {
      ...model, take_groups: model.take_groups.map(take => take.group_id === groupId ? {
        ...take, editorial_state: { editorial_decision: { group: decision, assignments: [] } },
      } : take),
    } }));
    await page.getByRole("button", { name: "保留", exact: true }).click();
    await page.getByText("当前 Take 不在筛选结果中").waitFor();
    assert.equal(await page.locator(".review-monitor-title strong").innerText(), "Take #2");
    assert.equal(await page.locator(".review-take-select").count(), 2);
    await page.getByRole("button", { name: direction, exact: true }).click();
    assert.equal(await page.locator(".review-monitor-title strong").innerText(), expected);
    await page.locator('.review-take-select[aria-pressed="true"]').filter({ hasText: expected }).waitFor();
  });
}

test("search, slate and Take workspaces retain the evidence and playback position", async t => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    if (errors.length) t.diagnostic(errors.join("\n"));
    await page.close();
  });
  const take = model.take_groups[0];
  const angle = take.angles[0];
  const cameras = ["A", "B", "C", "D", "E", "F"];
  const angles = cameras.map(camera => {
    const clip_id = camera === "A" ? angle.clip_id : `C_SYNTH_${camera}`;
    const media_id = camera === "A" ? angle.media_id : `M_SYNTH_${camera}`;
    return {
      ...angle, clip_id, media_id, camera, name: `synthetic-angle-${camera}.webm`,
      source_start: 0.25, source_end: 1.9,
      playback: { ...angle.playback, url: `/api/v1/projects/project/media/${clip_id}`, source_start: 0.25, source_end: 1.9 },
    };
  });
  const record = {
    record_id: "manual-record", source_group_id: "", script_scene_id: "", episode: 1, scene: "补拍",
    shot: "", take_number: null, status: "unmarked", note: "窗外逆光补拍", attachments: [], preferred_clip_id: "",
  };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/workspace")) return route.fulfill({ json: { projects: [{ ...model.project, input_kind: "fcpxml", project_id: "project" }] } });
    if (path.endsWith("/review-model")) return route.fulfill({ json: {
      ...model, take_groups: [{ ...take, cameras, angles }],
    } });
    if (path.endsWith("/script-supervisor")) return route.fulfill({ json: { revision: 1, records: { [record.record_id]: record }, entries: {} } });
    if (path.endsWith("/semantic-search")) return route.fulfill({ json: {
      contract: "semantic_search.v1", mode: "keyword", summary: { documents: 2 }, results: [
        { document_id: "speech", group_id: take.group_id, clip_id: angle.clip_id, media_id: angle.media_id,
          start: 0.25, end: 0.75, source: "speech", snippet: "现场实际说过的对白", metadata: { time_basis: "take_relative" } },
        { document_id: "standalone", group_id: "", clip_id: "", media_id: "", start: 0, end: 0, source: "slate",
          snippet: record.note, metadata: { record_id: record.record_id } },
      ],
    } });
    if (path.includes("/media/")) return serveFixtureVideo(route);
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=project`);
  await page.locator(".professional-project-workbench").waitFor().catch(async () => assert.fail(await page.locator("body").innerText()));
  const search = page.getByRole("button", { name: /搜索/ }).first();
  await search.click();
  const input = page.getByRole("textbox", { name: "搜索画面、对白或场记" });
  await input.fill("对白");
  await input.press("Enter");
  await page.evaluate(() => {
    window.evidencePreviewFirstSeek = null;
    document.addEventListener("seeking", (event) => {
      if (window.evidencePreviewFirstSeek === null && event.target.matches?.(".evidence-preview video")) {
        window.evidencePreviewFirstSeek = event.target.currentTime;
      }
    }, { capture: true });
  });
  await page.getByRole("button", { name: /现场实际说过的对白/ }).click();
  const preview = page.getByRole("dialog", { name: "定位媒体证据" });
  await preview.getByText(/原片 0.50 秒/).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector(".evidence-preview video");
    return video?.readyState >= 2 && window.evidencePreviewFirstSeek !== null
      && Math.abs(window.evidencePreviewFirstSeek - 0.5) < 0.03;
  });
  await page.keyboard.press("Escape");
  await search.click();
  await page.getByRole("button", { name: /窗外逆光补拍/ }).click();
  await preview.getByRole("button", { name: "打开场记" }).click();
  const row = page.locator('[data-record-id="manual-record"][aria-current="true"]');
  await row.waitFor();
  const note = page.locator(".golden-inspector-field textarea");
  await note.fill("补拍草稿待确认");
  await page.locator(".project-module-rail").getByRole("button", { name: /^剧本关联/ }).click();
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent("mirrororder:operator-change", { detail: "验收操作员" })));
  await page.locator(".project-module-rail").getByRole("button", { name: /^交互场记/ }).click();
  assert.equal(await note.inputValue(), "补拍草稿待确认");
  assert.equal(await row.count(), 1);

  for (const camera of cameras) {
    await page.getByRole("columnheader", { name: `${camera} 机`, exact: true }).first().waitFor();
  }
  await page.locator("tbody").getByRole("button", { name: /选择 F · synthetic-angle-F\.webm/ }).click();
  const slatePlayer = page.locator(".golden-slate-player video");
  await page.waitForFunction(() => document.querySelector(".golden-slate-player video")?.readyState >= 2);
  await slatePlayer.evaluate(video => { video.currentTime = 1.2; });
  const expectCameraFAtPosition = async selector => {
    await page.waitForFunction(target => {
      const video = document.querySelector(target);
      return video?.currentSrc.endsWith("/C_SYNTH_F") && video.readyState >= 2 && !video.seeking
        && Math.abs(video.currentTime - 1.2) < 0.03;
    }, selector);
  };
  await expectCameraFAtPosition(".golden-slate-player video");
  const navigation = page.locator(".golden-inspector-navigation");
  const detailScope = page.getByRole("group", { name: "详情范围" });
  for (const destination of ["在素材中打开", "在剧本中打开"]) {
    if (destination === "在剧本中打开") await detailScope.getByRole("button", { name: "Take", exact: true }).click();
    await navigation.getByRole("button", { name: destination, exact: true }).click();
    await expectCameraFAtPosition(".take-player");
    await page.getByRole("button", { name: "返回场记", exact: true }).click();
    await detailScope.getByRole("button", { name: "素材", exact: true }).click();
    await expectCameraFAtPosition(".golden-slate-player video");
  }
  // The rail uses the shared selection published by Slate, not the inspector's direct link.
  const rail = page.locator(".project-module-rail");
  await rail.getByRole("button", { name: /^看片审阅/ }).click();
  await expectCameraFAtPosition(".review-workspace .take-player");
  const finder = page.getByRole("textbox", { name: "搜索审阅素材" });
  await finder.fill("synthetic-angle-F.webm");
  await page.getByRole("group", { name: "结果视图" }).getByRole("button", { name: "片段" }).click();
  await page.locator(".review-fragment-card").getByText(/synthetic-angle-F\.webm/).waitFor();
  await page.getByRole("button", { name: /^加入对比 Take/ }).click();
  await page.getByRole("button", { name: "打开素材", exact: true }).click();
  await expectCameraFAtPosition(".material-take-view .take-player");
  await page.getByRole("button", { name: "返回看片", exact: true }).click();
  await expectCameraFAtPosition(".review-workspace .take-player");
  assert.equal(await finder.inputValue(), "synthetic-angle-F.webm");
  assert.equal(await page.getByRole("group", { name: "结果视图" }).getByRole("button", { name: "片段" }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("group", { name: "对比 Take", exact: true }).locator(".review-comparison-item").count(), 1);
  await rail.getByRole("button", { name: /^交互场记/ }).click();
  await expectCameraFAtPosition(".golden-slate-player video");
  await page.locator('[data-record-id="manual-record"] td.col-index').click();
  assert.equal(await note.inputValue(), "补拍草稿待确认");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test("a failed sync read preserves the verification page and last valid master", async t => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    if (errors.length) t.diagnostic(errors.join("\n"));
    await page.close();
  });
  const projectId = "project";
  let offline = false;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/workspace")) return route.fulfill({ json: { projects: [
      { project_id: projectId, name: "合成断连项目", input_kind: "media-directory" },
    ] } });
    if (path.endsWith("/sync-timeline")) return offline
      ? route.fulfill({ status: 503, json: { error: "Host 暂时未响应" } })
      : route.fulfill({ json: {
        contract_version: "multicam_sync_timeline.v1", project_id: projectId, ready: true, phase: "completed",
        message: "同步完成", task: { task_id: "version-1", status: "completed", stage: "completed", message: "同步完成" },
        cameras: ["A"], duration_seconds: 2, clip_count: 1,
        timebase: { status: "confirmed", source: "fixture", numerator: 25, denominator: 1 },
        tracks: [{ track_id: "video:A", label: "A 机位", camera: "A", kind: "video", clip_count: 1,
          clips: [{ clip_id: "synthetic-a", camera: "A", day: "day1", name: "A001.MOV", timeline_start: 0, duration: 2,
            timecode: "00:00:00:00", clip_number: "1" }] }],
      } });
    if (path.endsWith("/media-binding")) return route.fulfill({ json: { summary: { roots: ["fixture-root"], items: [] } } });
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=project`);
  await page.locator(".professional-project-workbench").waitFor().catch(async () => assert.fail(await page.locator("body").innerText()));
  await page.getByRole("heading", { name: "同步母版已就绪" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导出到剪辑软件…" }).isEnabled(), true);
  assert.equal(await page.locator(".multicam-sync-angle-grid").count(), 0);
  const inspect = page.locator(".project-module-rail").getByRole("button", { name: /^同步核对/ });
  await inspect.click();
  await page.locator(".multicam-sync-angle-grid").waitFor();
  offline = true;
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.getByRole("alert").filter({ hasText: "同步状态读取失败" }).waitFor();
  await page.locator(".multicam-sync-angle-grid").waitFor();
  assert.equal(await inspect.getAttribute("aria-current"), "page");
  offline = false;
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByRole("alert").filter({ hasText: "同步状态读取失败" }).waitFor({ state: "hidden" });
  assert.equal(await inspect.getAttribute("aria-current"), "page");
});

test("project search applies the source filter to the submitted query and Enter activates the focused control", async t => {
  const page = await openReview(t);
  const requests = [];
  await page.route("**/semantic-search?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    const query = params.get("q");
    const source = params.get("sources");
    requests.push([query, source]);
    return route.fulfill({ json: {
      query, mode: "keyword", summary: { documents: 2 },
      results: source === "speech" ? [] : [{
        document_id: query, source: "file", metadata: { file_name: query }, clip_id: "synthetic-clip",
        snippet: query, start: 0, end: 0,
      }],
    } });
  });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "搜索项目素材" });
  const input = dialog.getByRole("textbox");
  await input.fill("A001");
  await input.press("Enter");
  const result = dialog.locator(".semantic-search-result");
  await result.filter({ hasText: "A001" }).waitFor();
  await dialog.getByRole("button", { name: "对白", exact: true }).press("Enter");
  await dialog.getByRole("status").filter({ hasText: "在对白中没有找到结果" }).waitFor();
  assert.equal(await result.count(), 0);
  await dialog.getByRole("button", { name: "全部", exact: true }).click();
  await result.filter({ hasText: "A001" }).waitFor();
  await input.fill("B002");
  assert.equal(await result.count(), 0);
  await input.press("Enter");
  await result.filter({ hasText: "B002" }).waitFor();
  await input.press("ArrowDown");
  assert.ok(await result.evaluate(button => button === document.activeElement));
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "定位媒体证据" }).getByText("B002", { exact: true }).waitFor();
  assert.deepEqual(requests, [["A001", null], ["A001", "speech"], ["A001", null], ["B002", null]]);
});

test("the multicam viewer sizes adjacent columns to portrait, landscape and square source pictures", async t => {
  const take = structuredClone(model.take_groups[0]);
  const first = take.angles[0];
  for (const camera of ["B", "C"]) {
    take.angles.push({ ...first, camera, clip_id: `C_SYNTH_${camera}`, media_id: `M_SYNTH_${camera}`, name: `${camera}.webm` });
  }
  const page = await openReview(t, { takes: [take] });
  await page.getByRole("button", { name: "多机位同看", exact: true }).click();
  const videos = page.getByRole("dialog", { name: "多机位同看" }).locator(".review-mc-picture video");
  await videos.first().waitFor();
  const portrait = [216, 384], landscape = [384, 216], square = [240, 240];
  for (const dimensions of [[portrait, portrait, portrait], [portrait, landscape, square]]) {
    const allPortrait = dimensions.every(([width, height]) => width < height);
    await videos.evaluateAll((elements, sizes) => elements.forEach((video, index) => {
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = sizes[index];
      const previous = video.srcObject;
      const stream = canvas.captureStream(1);
      video.srcObject = stream;
      previous?.getTracks().forEach(track => track.stop());
      canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
      stream.getVideoTracks()[0].requestFrame();
    }), dimensions);
    await page.waitForFunction(sizes => [...document.querySelectorAll(".review-mc-picture video")]
      .every((video, index) => video.videoWidth === sizes[index][0] && video.videoHeight === sizes[index][1]), dimensions);
    for (const [width, height] of [[1180, 640], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const frames = await videos.evaluateAll(elements => elements.map(video => {
        const bounds = video.getBoundingClientRect();
        const frame = video.parentElement.getBoundingClientRect();
        const column = video.closest("article").getBoundingClientRect();
        const transport = video.closest("article").querySelector(".review-mc-controls");
        const viewport = video.closest(".review-mc-grid").getBoundingClientRect();
        return { x: frame.x, y: frame.y, width: frame.width, height: frame.height, column: column.width,
          controlsVisible: transport.getBoundingClientRect().bottom <= viewport.bottom + 1,
          fits: getComputedStyle(video).objectFit === "contain"
            && ["top", "right", "bottom", "left"].every(edge => Math.abs(bounds[edge] - frame[edge]) < 1) };
      }));
      assert.equal(frames.length, dimensions.length);
      for (const [index, frame] of frames.entries()) {
        const [sourceWidth, sourceHeight] = dimensions[index];
        const context = `${width}×${height}, ${sourceWidth}×${sourceHeight} source`;
        assert.ok(frame.fits, `video fills its picture frame at ${context}`);
        assert.ok(frame.controlsVisible, `the entire playback control row is visible at ${context}`);
        assert.ok(Math.abs(frame.width - frame.height * sourceWidth / sourceHeight) < 1, `no letterboxing at ${context}`);
        assert.ok(Math.abs(frame.column - frame.width) < 1, `the column follows its picture at ${context}`);
        assert.ok(frame.height >= height * (allPortrait ? 0.58 : 0.39), `usable picture size at ${context}`);
        if (index > 0) {
          const previous = frames[index - 1];
          assert.ok(Math.abs(frame.y - previous.y) < 1 && Math.abs(frame.height - previous.height) < 1, `same screening row at ${context}`);
          const gap = frame.x - previous.x - previous.width;
          assert.ok(gap >= 0 && gap <= 18, `no empty landscape columns between cameras at ${context}`);
        }
      }
    }
  }
});
