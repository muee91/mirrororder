// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { MulticamSyncTimeline as SyncTimeline } from "../../api/syncTimeline";
import { MulticamSyncTimeline } from "./MulticamSyncTimeline";

it("renders six separate camera tracks with distinct colors and a separate unclassified track", () => {
  const labels = [..."ABCDEF", "?"];
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1", project_id: "synthetic", phase: "completed", ready: true,
    message: "同步已完成", cameras: [..."ABCDEF"], clip_count: 7, duration_seconds: 2, task: null,
    tracks: labels.map((camera) => ({
      track_id: `video:${camera}`, kind: "video", camera, label: camera === "?" ? "未分类机位" : `${camera} 机位`, clip_count: 1,
      clips: [{ clip_id: `clip-${camera}`, camera, day: "day1", name: `${camera}.MP4`, timeline_start: 0, duration: 2, timecode: "", clip_number: "1" }],
    })),
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MulticamSyncTimeline, { syncTimeline: payload }));
  const tracks = [...host.querySelectorAll<HTMLElement>(".multicam-sync-track")];
  expect(tracks).toHaveLength(7);
  expect(tracks.map((row) => row.querySelector("strong")?.textContent)).toEqual(labels);
  expect(new Set(tracks.slice(0, 6).map((row) => row.style.getPropertyValue("--camera-color"))).size).toBe(6);
  expect([...host.querySelectorAll(".sync-camera-cell")].map(cell => cell.getAttribute("data-camera"))).toEqual(labels);
  expect(host.querySelector(".sync-master-heading")?.textContent).toContain("6 机位");
});


it("shows a live worker stage and only labels true algorithm checkpoints", () => {
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1",
    project_id: "project", phase: "running", ready: false,
    message: "任务运行中", cameras: [], clip_count: 0, duration_seconds: 0, tracks: [],
    task: {
      task_id: "task1", status: "running", stage: "sync",
      message: "提取同步音频缓存",
      progress: { done: 2, total: 8 },
      started_at: "2026-11-17T08:00:00+00:00",
      updated_at: "2026-11-17T08:05:00+00:00",
    },
  };
  const html = renderToStaticMarkup(createElement(MulticamSyncTimeline, { syncTimeline: payload, onMulticamSync: () => {} }));
  expect(html).toContain("提取同步音频缓存");
  expect(html).toContain('aria-label="同步算法检查点进度"');
  expect(html).toContain('value="2" max="8"');
  expect(html).toContain("最近活动");
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(host.querySelector<HTMLButtonElement>(".sync-task-actions button")?.disabled).toBe(true);
});

it("shows a failed sync reason with a retry action instead of the old opaque gate", () => {
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1",
    project_id: "project", phase: "failed", ready: false,
    message: "多机位同步失败", cameras: [], clip_count: 0, duration_seconds: 0, tracks: [],
    task: { task_id: "task2", status: "failed", stage: "failed", message: "任务失败",
      error: "素材目录不存在", progress: {} },
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MulticamSyncTimeline, { syncTimeline: payload, onMulticamSync: () => {} }));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("素材目录不存在");
  expect(host.textContent).toContain("重新执行同步");
  expect(host.querySelector<HTMLButtonElement>(".sync-task-actions button")?.disabled).toBe(false);
});


it("exposes a playable source only for a verified indexed clip identifier", () => {
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1", project_id: "project", phase: "completed",
    ready: true, message: "ready", task: null, cameras: ["A"], clip_count: 1, duration_seconds: 50,
    tracks: [{
      track_id: "video:A", kind: "video", camera: "A", label: "A 机位", clip_count: 1,
      clips: [{
        clip_id: "vendor_tmp_identifier", camera: "A", day: "day1", name: "A001.MOV",
        timeline_start: 0, duration: 20, timecode: "", clip_number: "",
        media_clip_id: "C_INDEXED_MEDIA",
      }],
    }],
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MulticamSyncTimeline, {
    syncTimeline: payload, baseUrl: "http://127.0.0.1:8765",
  }));
  expect(host.querySelectorAll(".multicam-sync-track")).toHaveLength(1);
  expect(host.querySelector("#multicam-sync-cursor")).not.toBeNull();
  expect(host.querySelector("#multicam-sync-zoom")).not.toBeNull();
  const video = host.querySelector<HTMLVideoElement>("video.multicam-sync-video");
  expect(video?.getAttribute("src")).toBe("http://127.0.0.1:8765/api/v1/projects/project/media/C_INDEXED_MEDIA");
  expect(video?.getAttribute("src")).not.toContain("vendor_tmp_identifier");
  expect(host.textContent).toContain("同步工程 · 已生成文件");

  payload.tracks[0].clips[0].media_clip_id = "";
  host.innerHTML = renderToStaticMarkup(createElement(MulticamSyncTimeline, {
    syncTimeline: payload, baseUrl: "http://127.0.0.1:8765",
  }));
  expect(host.querySelector("video.multicam-sync-video")).toBeNull();
  expect(host.textContent).toContain("尚未建立无歧义的素材身份");
});

it("opens on the first source frame when the synchronized track starts after zero", () => {
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1", project_id: "project", phase: "completed",
    ready: true, message: "ready", task: null, cameras: ["A"], clip_count: 1, duration_seconds: 38883,
    tracks: [{ track_id: "video:A", kind: "video", camera: "A", label: "A 机位", clip_count: 1,
      clips: [{ clip_id: "vendor-A", media_clip_id: "C_A", camera: "A", day: "day1", name: "A.MOV",
        timeline_start: 0.335, duration: 50, timecode: "", clip_number: "1" }] }],
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(MulticamSyncTimeline, {
    syncTimeline: payload, baseUrl: "http://127.0.0.1:8765",
  }));
  expect(host.querySelector("video")?.getAttribute("src")).toContain("/media/C_A");
  expect(host.querySelector<HTMLInputElement>("#multicam-sync-cursor")?.getAttribute("value")).toBe("0.335");
  expect(host.querySelector<HTMLSelectElement>("#multicam-sync-zoom option[selected]")?.textContent).toBe("64×");
});


it("switches active camera at the same master time without creating a new edit timeline", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const payload: SyncTimeline = {
    contract_version: "multicam_sync_timeline.v1", project_id: "project", phase: "completed",
    ready: true, message: "ready", task: null, cameras: ["A", "B"], clip_count: 2, duration_seconds: 12,
    tracks: ["A", "B"].map((camera) => ({
      track_id: `video:${camera}`, kind: "video" as const, camera, label: `${camera} 机位`, clip_count: 1,
      clips: [{ clip_id: `vendor-${camera}`, day: "day1", camera, name: `${camera}.MOV`,
        timeline_start: 0, duration: 10, timecode: "", clip_number: "" }],
    })),
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MulticamSyncTimeline, { syncTimeline: payload })); });
  expect(host.querySelector(".sync-camera-cell[data-listening] .sync-camera-caption strong")?.textContent).toContain("A 机位");
  const cells = [...host.querySelectorAll(".sync-camera-cell")];
  const b = [...host.querySelectorAll<HTMLButtonElement>(".multicam-sync-angle-grid button")]
    .find((button) => button.textContent?.includes("B 机"));
  expect(b).toBeDefined();
  await act(async () => { b?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(host.querySelector(".sync-camera-cell[data-listening] .sync-camera-caption strong")?.textContent).toContain("B 机位");
  expect([...host.querySelectorAll(".sync-camera-cell")]).toEqual(cells);
  const inspector = host.querySelector<HTMLButtonElement>(".sync-inspector-toggle");
  expect(inspector).not.toBeNull();
  await act(async () => { inspector!.click(); });
  expect(host.querySelector(".multicam-sync-details")?.textContent).toContain("B.MOV");
  await act(async () => { root.unmount(); });
  host.remove();
});
