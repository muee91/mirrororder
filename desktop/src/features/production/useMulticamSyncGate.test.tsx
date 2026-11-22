// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncTimelineClient, type MulticamSyncTimeline } from "../../api/syncTimeline";
import { useMulticamSyncGate } from "./useMulticamSyncGate";

function master(projectId: string): MulticamSyncTimeline {
  return {
    contract_version: "multicam_sync_timeline.v1", project_id: projectId, ready: true,
    phase: "completed", message: "完成", task: null, tracks: [], cameras: [],
    clip_count: 0, duration_seconds: 0,
  };
}

describe("useMulticamSyncGate", () => {
  let root: Root;
  let gate: ReturnType<typeof useMulticamSyncGate>;
  let renders: number;

  function Probe({ projectId }: { projectId: string }) {
    gate = useMulticamSyncGate("http://localhost:8765", projectId, "media-directory");
    renders++;
    return null;
  }

  async function focus() {
    await act(async () => { window.dispatchEvent(new Event("focus")); });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    renders = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes on every focus and retains the exact state on unchanged reads", async () => {
    const read = vi.spyOn(SyncTimelineClient.prototype, "read").mockImplementation(async id => master(id));
    await act(async () => root.render(<Probe projectId="one" />));
    const initial = gate;
    const count = renders;
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    await focus();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await focus();
    await focus();
    expect(read).toHaveBeenCalledTimes(4);
    await act(async () => gate.refreshSyncTimeline());
    expect(read).toHaveBeenCalledTimes(5);
    expect(renders).toBe(count);
    expect(gate.snapshot).toBe(initial.snapshot);
    expect(gate.syncTimeline).toBe(initial.syncTimeline);
    await act(async () => gate.refreshSyncTimeline(true));
    expect(gate.syncTimeline).not.toBe(initial.syncTimeline);
    read.mockResolvedValue({ ...master("one"), offset_revision: 1 });
    await act(async () => gate.refreshSyncTimeline());
    expect(read).toHaveBeenCalledTimes(7);
    expect(gate.syncTimeline.offset_revision).toBe(1);
  });

  it("continues polling and focus reads while running or recovering from a read error", async () => {
    const running: MulticamSyncTimeline = {
      ...master("one"), ready: false, phase: "running",
      task: { task_id: "task", status: "running", stage: "analysis", message: "", progress: { done: 1 } },
    };
    const read = vi.spyOn(SyncTimelineClient.prototype, "read").mockResolvedValue(running);
    await act(async () => root.render(<Probe projectId="one" />));
    await focus();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValueOnce({ ...running, task: { ...running.task!, progress: { done: 2 } } });
    await act(async () => vi.advanceTimersByTimeAsync(1_800));
    expect(gate.syncTimeline.task?.progress).toEqual({ done: 2 });
    read.mockResolvedValue(master("one"));
    await focus();
    const snapshot = gate.snapshot;
    read.mockRejectedValueOnce(new Error("offline"));
    await act(async () => gate.refreshSyncTimeline());
    expect(gate.readError).toContain("offline");
    expect(gate.snapshot).toBe(snapshot);
    await focus();
    expect(gate.readError).toBe("");
    expect(gate.syncTimeline.ready).toBe(true);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("publishes a newly resolved clip route even when the completed task and counts are unchanged", async () => {
    const timeline = master("one");
    const clip = { clip_id: "A1", camera: "A", day: "1", name: "clip", timeline_start: 0, duration: 1, timecode: "", clip_number: "1" };
    timeline.tracks = [{ track_id: "A", kind: "video", camera: "A", label: "A", clip_count: 1, clips: [clip] }];
    timeline.clip_count = 1;
    timeline.duration_seconds = 1;
    const read = vi.spyOn(SyncTimelineClient.prototype, "read").mockResolvedValue(timeline);
    await act(async () => root.render(<Probe projectId="one" />));
    read.mockResolvedValue({ ...timeline, tracks: [{ ...timeline.tracks[0], clips: [{ ...clip, media_clip_id: "resolved" }] }] });
    await act(async () => gate.refreshSyncTimeline());
    expect(gate.syncTimeline.tracks[0].clips[0].media_clip_id).toBe("resolved");
  });

  it("ignores a late read from the previous scope and fetches the new project immediately", async () => {
    let finishOldRead!: (timeline: MulticamSyncTimeline) => void;
    const read = vi.spyOn(SyncTimelineClient.prototype, "read").mockImplementation(async id => master(id));
    await act(async () => root.render(<Probe projectId="one" />));
    read.mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve; }));
    const pending = gate.refreshSyncTimeline();
    await act(async () => root.render(<Probe projectId="two" />));
    await act(async () => { finishOldRead(master("one")); await pending; });
    expect(read).toHaveBeenCalledTimes(3);
    expect(gate.syncTimeline.project_id).toBe("two");
    expect(gate.snapshot?.timeline.project_id).toBe("two");
  });
});
