import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { TimelineBridgeError, TimelineClient, type TimelineProject } from "./timeline";

const mockedInvoke = vi.mocked(invoke);
const mockedIsTauri = vi.mocked(isTauri);

function project(): TimelineProject {
  return {
    version: 1,
    project_id: "p1",
    sources: [],
    multicam_groups: [],
    sequences: [{ sequence_id: "main", name: "Main", frame_rate: { numerator: 24, denominator: 1 }, tracks: [{ track_id: "V1", kind: "video", clips: [] }], markers: [], transitions: [] }],
    active_sequence_id: "main",
  };
}

describe("TimelineClient", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedIsTauri.mockReturnValue(true);
  });

  it("seeds a confirmed proposal through the transactional Rust command", async () => {
    const snapshot = { project: project(), undo_depth: 1, redo_depth: 0, validation: [] };
    mockedInvoke.mockResolvedValueOnce(snapshot as never);
    const commands = [{ type: "set_marker" as const, sequence_id: "main", marker: { marker_id: "m1", position: 0, label: "start" } }];
    await expect(new TimelineClient().loadWithCommands(project(), commands)).resolves.toEqual(snapshot);
    expect(mockedInvoke).toHaveBeenCalledWith("timeline_load_with_commands", { project: project(), commands });
  });

  it("opens crash-recovered project state by project id", async () => {
    const snapshot = { project: project(), undo_depth: 4, redo_depth: 0, validation: [] };
    mockedInvoke.mockResolvedValueOnce(snapshot as never);
    await expect(new TimelineClient().openPersisted("p1")).resolves.toEqual(snapshot);
    expect(mockedInvoke).toHaveBeenCalledWith("timeline_open_persisted", { projectId: "p1" });
  });

  it("exposes checkpoint and journal status without moving persistence into React", async () => {
    const snapshot = { project: project(), undo_depth: 0, redo_depth: 0, validation: [] };
    const status = {
      project_id: "p1",
      persistence: {
        project_id: "p1",
        checkpoint_path: "/tmp/p1/checkpoint.json",
        journal_path: "/tmp/p1/journal.jsonl",
        backup_path: "/tmp/p1/checkpoint.json.bak",
        journal_operations: 7,
        ignored_partial_tail: false,
      },
      recovered_operations: 3,
      used_backup: false,
      ignored_partial_tail: false,
    };
    mockedInvoke.mockResolvedValueOnce(snapshot as never).mockResolvedValueOnce(status as never);
    const client = new TimelineClient();
    await expect(client.checkpoint()).resolves.toEqual(snapshot);
    await expect(client.persistenceStatus()).resolves.toEqual(status);
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "timeline_checkpoint", undefined);
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "timeline_persistence_status", undefined);
  });

  it("keeps browser preview read-only", async () => {
    mockedIsTauri.mockReturnValue(false);
    await expect(new TimelineClient().snapshot()).rejects.toThrow("Timeline Core 只在 Tauri Desktop 运行");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("preserves structured validator issues from the Rust bridge", async () => {
    mockedInvoke.mockRejectedValueOnce({ message: "Timeline Command 被拒绝", issues: [{ code: "track_overlap", path: "V1", message: "overlap" }] } as never);
    await expect(new TimelineClient().undo()).rejects.toMatchObject({
      name: "TimelineBridgeError",
      message: "Timeline Command 被拒绝",
      issues: [{ code: "track_overlap" }],
    } satisfies Partial<TimelineBridgeError>);
  });
});
