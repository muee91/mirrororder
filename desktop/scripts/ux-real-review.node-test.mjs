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

async function openReview(t, { empty = false, missingMedia = false, takeCount = 3, projectId = "project" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const projectName = projectId === "synthetic-alternate" ? "Synthetic Alternate Project" : model.project.name;
  t.after(() => page.close());
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/review-model")) {
      return route.fulfill({ json: { ...model, project: { ...model.project, project_id: projectId, name: projectName }, take_groups: empty ? [] : model.take_groups.slice(0, takeCount) } });
    }
    if (path.endsWith("/workspace")) return route.fulfill({ json: { projects: [{ ...model.project, project_id: projectId, name: projectName }] } });
    if (path.includes("/media/")) {
      return missingMedia
        ? route.fulfill({ status: 404, json: { error: "media missing" } })
        : route.fulfill({ contentType: "video/webm", body: readFileSync(resolve(fixtureRoot, "sample.webm")) });
    }
    if (path.endsWith("/editorial")) return route.fulfill({ json: { revision: 0, opinions: {}, decisions: {} } });
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=${encodeURIComponent(projectId)}`);
  await page.locator(".project-module-rail").getByRole("button", { name: /^看片审阅/ }).click();
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

test("decision conflict recovery requires a read retry and refreshes the real review queue", async t => {
  const page = await openReview(t);
  const panel = page.locator(".review-decision-panel");
  await panel.locator(".editorial-decision-actions button:not([disabled])").first().waitFor();
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
  await panel.getByRole("button", { name: "Best", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "最新状态读取失败" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Best", exact: true }).isDisabled(), true);
  assert.equal(await panel.getByText("当前 Take 尚未形成最终决定。", { exact: true }).count(), 0);

  await panel.getByRole("button", { name: "重新读取状态", exact: true }).click();
  await panel.locator("button.is-selected.state-keep").waitFor();
  await page.waitForFunction(() => document.querySelector(".review-queue-summary")?.textContent.includes("1 已决定"));
  assert.equal(await panel.getByRole("button", { name: "Best", exact: true }).isDisabled(), false);
  assert.equal(writes, 1, "conflicting Best must not be replayed after the read retry");
  assert.equal(recoveryReads, 2);
});

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
    if (path.includes("/media/")) {
      const bytes = readFileSync(resolve(fixtureRoot, "sample.webm"));
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
      if (!range) return route.fulfill({ contentType: "video/webm", body: bytes });
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      return route.fulfill({ status: 206, contentType: "video/webm",
        headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
        body: bytes.subarray(start, end + 1),
      });
    }
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=project`);
  await page.locator(".professional-project-workbench").waitFor().catch(async () => assert.fail(await page.locator("body").innerText()));
  const search = page.getByRole("button", { name: /搜索/ }).first();
  await search.click();
  const input = page.getByRole("textbox", { name: "搜索画面、对白或场记" });
  await input.fill("对白");
  await input.press("Enter");
  await page.getByRole("button", { name: /现场实际说过的对白/ }).click();
  const preview = page.getByRole("dialog", { name: "定位媒体证据" });
  await preview.getByText(/原片 0.50 秒/).waitFor();
  await page.waitForFunction(() => {
    const video = document.querySelector(".evidence-preview video");
    return video?.readyState >= 2 && Math.abs(video.currentTime - 0.5) < 0.03;
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
  for (const destination of ["在素材中打开", "在剧本中打开"]) {
    await navigation.getByRole("button", { name: destination, exact: true }).click();
    await expectCameraFAtPosition(".take-player");
    await page.getByRole("button", { name: "返回场记", exact: true }).click();
    await expectCameraFAtPosition(".golden-slate-player video");
  }
  // The rail uses the shared selection published by Slate, not the inspector's direct link.
  const rail = page.locator(".project-module-rail");
  await rail.getByRole("button", { name: /^看片审阅/ }).click();
  await expectCameraFAtPosition(".review-workspace .take-player");
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
        tracks: [{ track_id: "video:A", label: "A 机位", camera: "A", kind: "video", clip_count: 1,
          clips: [{ clip_id: "synthetic-a", camera: "A", day: "day1", name: "A001.MOV", timeline_start: 0, duration: 2 }] }],
      } });
    if (path.endsWith("/media-binding")) return route.fulfill({ json: { summary: { roots: ["fixture-root"] } } });
    return route.fulfill({ status: 404, json: { error: "synthetic endpoint not provided" } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/ux-real.html?project_id=project`);
  await page.locator(".professional-project-workbench").waitFor().catch(async () => assert.fail(await page.locator("body").innerText()));
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
