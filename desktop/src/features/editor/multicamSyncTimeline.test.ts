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
