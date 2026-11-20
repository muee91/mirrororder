// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import { SyncRecordingMonitor } from "./SyncRecordingMonitor";

const timeline: MulticamSyncTimeline = {
  contract_version: "multicam_sync_timeline.v1",
  project_id: "synthetic",
  phase: "completed",
  ready: true,
  message: "ready",
  task: { task_id: "sync-v1", status: "completed", stage: "sync", message: "done" },
  cameras: ["A"],
  tracks: [],
  clip_count: 0,
  duration_seconds: 2,
  recordings: {
    candidate_count: 1,
    unplaced_count: 0,
    invalid_count: 0,
    placements: [{ media_id: "M_0123456789abcdef01234567", name: "boom.wav", at: 25, source: 50, frames: 100 }],
  },
};

it("starts WAV and video together from a direct user action, and disengages cleanly", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const onStartVideo = vi.fn();
  const onAudition = vi.fn();
  const onFollowChange = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<SyncRecordingMonitor baseUrl="http://127.0.0.1:8765" timeline={timeline}
        cursor={25} rate={{ numerator: 25, denominator: 1 }} playingVideo={false}
        onAudition={onAudition} onStartVideo={onStartVideo} onFollowChange={onFollowChange} />);
    });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".sync-recording-mode button")];
    const linked = buttons.find(button => button.textContent === "跟随画面");
    const solo = buttons.find(button => button.textContent === "独立试听");
    expect(host.querySelector("audio")).not.toBeNull();
    expect(linked?.disabled).toBe(false);

    await act(async () => { linked?.click(); });
    expect(onStartVideo).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(onFollowChange).toHaveBeenCalledWith(true);
    expect(onAudition).not.toHaveBeenCalled();
    expect(linked?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => { solo?.click(); });
    expect(pause).toHaveBeenCalled();
    expect(onFollowChange).toHaveBeenCalledWith(false);
    expect(solo?.getAttribute("aria-pressed")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
