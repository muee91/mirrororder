// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  expect(host.querySelector(".multicam-sync-inspection-meta")?.textContent).toContain("A / B / C / D / E / F 机位");
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
  expect(html).toContain("同步算法检查点，不代表全部文件已处理");
  expect(html).toContain('value="2" max="8"');
  expect(html).toContain("最近任务记录");
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(host.querySelector<HTMLButtonElement>(".multicam-sync-action button")?.disabled).toBe(true);
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
  expect(host.textContent).toContain("失败原因：素材目录不存在");
  expect(host.textContent).toContain("重新执行同步");
  expect(host.querySelector<HTMLButtonElement>(".multicam-sync-action button")?.disabled).toBe(false);
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
