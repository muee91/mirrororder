import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { TimelineBridgeError, TimelineClient, type TimelineAuthority, type TimelineProject, type TimelineSnapshot } from "./timeline";

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

function authority(revision = 0, generation = "g1"): TimelineAuthority {
  return { generation, revision };
}

function snapshot(revision = 0, generation = "g1"): TimelineSnapshot {
  return { project: project(), undo_depth: revision, redo_depth: 0, validation: [], authority: authority(revision, generation) };
}

describe("TimelineClient", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedIsTauri.mockReturnValue(true);
  });

  it("seeds a confirmed proposal through the transactional Rust command", async () => {
    const seeded = snapshot(0, "proposal-generation");
    mockedInvoke.mockResolvedValueOnce(seeded as never);
    const commands = [{ type: "set_marker" as const, sequence_id: "main", marker: { marker_id: "m1", position: 0, label: "start" } }];
    await expect(new TimelineClient().loadWithCommands(project(), commands)).resolves.toEqual(seeded);
    expect(mockedInvoke).toHaveBeenCalledWith("timeline_load_with_commands", { project: project(), commands });
  });

  it("opens crash-recovered project state by project id", async () => {
    const recovered = snapshot(4, "persisted-generation");
    mockedInvoke.mockResolvedValueOnce(recovered as never);
    await expect(new TimelineClient().openPersisted("p1")).resolves.toEqual(recovered);
    expect(mockedInvoke).toHaveBeenCalledWith("timeline_open_persisted", { projectId: "p1" });
  });

  it("sends the last Rust snapshot authority with every mutation and advances it from the response", async () => {
    const loaded = snapshot(3, "g1");
    const applied = snapshot(4, "g1");
    const undone = { ...snapshot(5, "g1"), redo_depth: 1 };
    mockedInvoke
      .mockResolvedValueOnce(loaded as never)
      .mockResolvedValueOnce(applied as never)
      .mockResolvedValueOnce(undone as never);

    const client = new TimelineClient();
    await client.openPersisted("p1");
    const command = { type: "set_marker" as const, sequence_id: "main", marker: { marker_id: "m1", position: 12, label: "beat" } };
    await client.apply(command);
    await client.undo();

    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "timeline_apply", {
      command,
      expectedAuthority: authority(3, "g1"),
    });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "timeline_undo", {
      expectedAuthority: authority(4, "g1"),
    });
  });

  it("refuses mutations before a full Rust snapshot establishes authority", async () => {
    const client = new TimelineClient();
    await expect(client.apply({ type: "set_marker", sequence_id: "main", marker: { marker_id: "m1", position: 0, label: "x" } })).rejects.toThrow("Timeline authority 尚未加载");
    await expect(client.undo()).rejects.toThrow("Timeline authority 尚未加载");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("checkpoint uses the current authority and accepts the fresh generation returned by Rust", async () => {
    const loaded = snapshot(7, "before-checkpoint");
    const checkpointed = { ...snapshot(0, "after-checkpoint"), undo_depth: 0, redo_depth: 0 };
    mockedInvoke.mockResolvedValueOnce(loaded as never).mockResolvedValueOnce(checkpointed as never);
    const client = new TimelineClient();
    await client.openPersisted("p1");
    await expect(client.checkpoint()).resolves.toEqual(checkpointed);
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "timeline_checkpoint", {
      expectedAuthority: authority(7, "before-checkpoint"),
    });
  });

  it("exposes checkpoint and journal status without using status as a mutation token", async () => {
    const loaded = snapshot(2, "snapshot-generation");
    const status = {
      project_id: "p1",
      authority: authority(9, "newer-status-generation"),
      persistence: {
        project_id: "p1",
        checkpoint_path: "/tmp/p1/checkpoint.json",
        journal_path: "/tmp/p1/journal.jsonl",
        backup_path: "/tmp/p1/checkpoint.json.bak",
        generation: "newer-status-generation",
        checkpoint_sequence: 8,
        journal_operations: 1,
        ignored_partial_tail: false,
      },
      recovered_operations: 3,
      used_backup: false,
      ignored_partial_tail: false,
    };
    const after = snapshot(3, "snapshot-generation");
    mockedInvoke
      .mockResolvedValueOnce(loaded as never)
      .mockResolvedValueOnce(status as never)
      .mockResolvedValueOnce(after as never);
    const client = new TimelineClient();
    await client.openPersisted("p1");
    await expect(client.persistenceStatus()).resolves.toEqual(status);
    await client.apply({ type: "set_marker", sequence_id: "main", marker: { marker_id: "m1", position: 1, label: "one" } });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "timeline_apply", {
      command: { type: "set_marker", sequence_id: "main", marker: { marker_id: "m1", position: 1, label: "one" } },
      expectedAuthority: authority(2, "snapshot-generation"),
    });
  });

  it("keeps browser preview read-only", async () => {
    mockedIsTauri.mockReturnValue(false);
    await expect(new TimelineClient().snapshot()).rejects.toThrow("Timeline Core 只在 Tauri Desktop 运行");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("preserves structured stale-authority issues from the Rust bridge", async () => {
    mockedInvoke
      .mockResolvedValueOnce(snapshot(4, "g1") as never)
      .mockRejectedValueOnce({
        message: "Timeline authority 已变化；拒绝应用过期编辑，请刷新后重试",
        issues: [{ code: "stale_timeline_authority", path: "authority", message: "expected g1@4, current g1@5" }],
      } as never);
    const client = new TimelineClient();
    await client.openPersisted("p1");
    await expect(client.undo()).rejects.toMatchObject({
      name: "TimelineBridgeError",
      issues: [{ code: "stale_timeline_authority", path: "authority" }],
    } satisfies Partial<TimelineBridgeError>);
  });
});
