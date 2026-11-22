// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
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
    syncTimeline: timeline,
    showDelivery: true,
    onOpenDelivery: () => {},
  }));
  const inspectionHost = document.createElement("div");
  inspectionHost.innerHTML = inspection;
  expect(inspectionHost.textContent).toContain("导出到剪辑软件…");
  expect(inspectionHost.textContent).toContain("⋯");
  expect(inspectionHost.textContent).toContain("手动微调偏移…");
  expect(inspectionHost.textContent).not.toContain("双机对照");
  expect(inspectionHost.textContent).not.toContain("竖屏 9:16");
  expect(inspectionHost.textContent).not.toContain("安全区");
  expect(inspectionHost.querySelector(".sync-debug-telemetry")?.hasAttribute("open") ?? false).toBe(false);
});
