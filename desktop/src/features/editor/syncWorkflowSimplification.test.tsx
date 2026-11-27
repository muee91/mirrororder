// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SyncTimelineClient, type MulticamSyncTimeline } from "../../api/syncTimeline";
import { SyncDeliveryWorkspace } from "./SyncDeliveryWorkspace";
import { SyncInspectionWorkbench } from "./SyncInspectionWorkbench";

const timeline: MulticamSyncTimeline = {
  contract_version: "multicam_sync_timeline.v1",
  project_id: "workflow-test",
  phase: "completed",
  ready: true,
  message: "同步已完成",
  task: null,
  cameras: ["A", "B"],
  clip_count: 2,
  duration_seconds: 12,
  timebase: { status: "confirmed", source: "test", numerator: 25, denominator: 1 },
  tracks: ["A", "B"].map((camera) => ({
    track_id: `video:${camera}`,
    kind: "video" as const,
    camera,
    label: `${camera} 机位`,
    clip_count: 1,
    clips: [{
      clip_id: `clip-${camera}`,
      media_clip_id: `media-${camera}`,
      day: "day1",
      camera,
      name: `${camera}.MOV`,
      timeline_start: 0,
      duration: 12,
      timecode: "00:00:00:00",
      clip_number: "1",
    }],
  })),
};

it("keeps advanced delivery collapsed and exposes the linear sync actions", () => {
  const delivery = renderToStaticMarkup(createElement(SyncDeliveryWorkspace, {
    baseUrl: "http://127.0.0.1:8765",
    syncTimeline: timeline,
    onSyncTask: () => {},
  }));
  const deliveryHost = document.createElement("div");
  deliveryHost.innerHTML = delivery;
  const enriched = deliveryHost.querySelector<HTMLDetailsElement>(".sync-enriched-pack-details");
  expect(enriched).not.toBeNull();
  expect(enriched?.hasAttribute("open")).toBe(false);
  expect(enriched?.querySelector("summary")?.textContent).toContain("进阶：增强交付包");

  const inspection = renderToStaticMarkup(createElement(SyncInspectionWorkbench, {
    baseUrl: "http://127.0.0.1:8765",
    syncTimeline: timeline,
    showDelivery: true,
    onOpenDelivery: () => {},
    onOpenSyncTask: () => {},
  }));
  const inspectionHost = document.createElement("div");
  inspectionHost.innerHTML = inspection;
  expect(inspectionHost.textContent).toContain("导出到剪辑软件…");
  expect(inspectionHost.textContent).toContain("⋯");
  expect(inspectionHost.querySelector(".multicam-sync-inspection-meta > .sync-inspector-toggle")?.textContent).toBe("微调同步偏移…");
  expect(inspectionHost.textContent).not.toContain("双机对照");
  expect(inspectionHost.textContent).not.toContain("竖屏 9:16");
  expect(inspectionHost.textContent).not.toContain("安全区");
  expect(inspectionHost.querySelector(".sync-debug-telemetry")?.hasAttribute("open") ?? false).toBe(false);
});

it("keeps the saved revision and undo available when moving a clip past the playhead", async () => {
  const source = {
    ...timeline,
    tracks: timeline.tracks.map(track => ({
      ...track, clips: track.clips.map(clip => ({ ...clip, media_clip_id: undefined })),
    })),
  };
  const revised = {
    ...source, offset_revision: 1,
    tracks: source.tracks.map((track, i) => i === 0
      ? { ...track, clips: track.clips.map(clip => ({ ...clip, timeline_start: 1 / 25 })) } : track),
  };
  const save = vi.spyOn(SyncTimelineClient.prototype, "applyOffset").mockResolvedValue(revised);
  const undo = vi.spyOn(SyncTimelineClient.prototype, "undoOffset").mockResolvedValue(source);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (data: MulticamSyncTimeline) => act(async () => root.render(
    <SyncInspectionWorkbench syncTimeline={data} baseUrl="http://localhost" showDelivery={false} />,
  ));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === label);
    expect(button?.disabled, label).toBe(false);
    await act(async () => button!.click());
  };
  try {
    await render(source);
    await click("微调同步偏移…");
    await click("+1f");
    await click("保存为 r1");
    expect(save).toHaveBeenCalledWith(source.project_id, expect.objectContaining({ clip_id: "clip-A", delta_frames: 1 }));
    await render(revised);
    expect(host.querySelector(".sync-clip-summary")).toBeNull();
    expect(host.querySelector(".sync-offset-status")?.textContent).toContain("已保存修正版 r1");
    await click("撤销上一版");
    expect(undo).toHaveBeenCalledWith(source.project_id, 1);
    await render(source);
    expect(host.querySelector(".sync-clip-summary")?.textContent).toContain("A.MOV");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
