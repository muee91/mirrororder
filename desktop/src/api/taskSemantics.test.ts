import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "./tasks";
import {
  currentTaskStates,
  isProjectHealthTask,
  latestTaskAttempts,
  latestTaskFamilies,
  taskFamilyKey,
} from "./taskSemantics";

function task(
  taskId: string,
  type: string,
  status: string,
  createdAt: string,
  patch: Partial<ProjectTaskRecord> = {},
): ProjectTaskRecord {
  return {
    task_id: taskId,
    type,
    status,
    stage: status,
    created_at: createdAt,
    ...patch,
  };
}

describe("task presentation semantics", () => {
  it("keeps only the newest attempt for one idempotency key", () => {
    const rows = latestTaskAttempts([
      task("old", "prepare_project", "failed", "2026-08-31T10:00:00Z", { idempotency_key: "prepare" }),
      task("new", "prepare_project", "completed", "2026-08-31T10:05:00Z", { idempotency_key: "prepare" }),
    ]);
    expect(rows.map((row) => row.task_id)).toEqual(["new"]);
  });

  it("collapses repeated identity runs into the current user-facing workflow", () => {
    const rows = latestTaskFamilies([
      task("week-old", "identity_index", "failed", "2026-08-24T09:00:00Z", { idempotency_key: "identity:1", targets: { kind: "both", group_ids: ["G1"] } }),
      task("newer", "identity_index", "interrupted", "2026-08-31T10:00:00Z", { idempotency_key: "identity:2", targets: { kind: "both", group_ids: ["G2", "G3"] } }),
      task("current", "identity_index", "completed", "2026-08-31T10:10:00Z", { idempotency_key: "identity:3", targets: { kind: "both", group_ids: ["G4"] } }),
    ]);
    expect(rows.map((row) => row.task_id)).toEqual(["current"]);
  });

  it("never hides simultaneous active instances from cancellation", () => {
    const rows = currentTaskStates([
      task("old-failure", "identity_index", "failed", "2026-08-31T09:00:00Z", { idempotency_key: "identity:old", targets: { kind: "both", group_ids: ["G1"] } }),
      task("running-a", "identity_index", "running", "2026-08-31T10:00:00Z", { idempotency_key: "identity:a", targets: { kind: "both", group_ids: ["G2"] } }),
      task("queued-b", "identity_index", "queued", "2026-08-31T10:01:00Z", { idempotency_key: "identity:b", targets: { kind: "both", group_ids: ["G3"] } }),
    ]);
    expect(rows.map((row) => row.task_id)).toEqual(["queued-b", "running-a"]);
  });

  it("returns to one settled row per family after active instances end", () => {
    const rows = currentTaskStates([
      task("old-failure", "identity_index", "failed", "2026-08-31T09:00:00Z", { idempotency_key: "identity:old", targets: { kind: "both", group_ids: ["G1"] } }),
      task("new-failure", "identity_index", "failed", "2026-08-31T10:00:00Z", { idempotency_key: "identity:new", targets: { kind: "both", group_ids: ["G2"] } }),
    ]);
    expect(rows.map((row) => row.task_id)).toEqual(["new-failure"]);
  });

  it("keeps face and speaker identity requests distinct when explicitly requested", () => {
    const face = task("face", "identity_index", "failed", "2026-08-31T10:00:00Z", { targets: { kind: "face" } });
    const speaker = task("speaker", "identity_index", "failed", "2026-08-31T10:01:00Z", { targets: { kind: "speaker" } });
    expect(taskFamilyKey(face)).not.toBe(taskFamilyKey(speaker));
    expect(latestTaskFamilies([face, speaker])).toHaveLength(2);
  });

  it("does not collapse unrelated targeted transcript requests", () => {
    const rows = latestTaskFamilies([
      task("a", "transcribe", "failed", "2026-08-31T10:00:00Z", { targets: { clip_ids: ["C1"] } }),
      task("b", "transcribe", "failed", "2026-08-31T10:01:00Z", { targets: { clip_ids: ["C2"] } }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("keeps auxiliary intelligence failures out of project health", () => {
    expect(isProjectHealthTask(task("identity", "identity_index", "failed", "2026-08-31T10:00:00Z"))).toBe(false);
    expect(isProjectHealthTask(task("vision", "local_vision_prepare", "failed", "2026-08-31T10:00:00Z"))).toBe(false);
    expect(isProjectHealthTask(task("prepare", "prepare_project", "failed", "2026-08-31T10:00:00Z"))).toBe(true);
    expect(isProjectHealthTask(task("scan", "media_inventory_scan", "failed", "2026-08-31T10:00:00Z"))).toBe(true);
  });
});
