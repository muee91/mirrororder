import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "../../api/tasks";
import { summarizeProjectActivity } from "./projectActivity";

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

describe("project activity health semantics", () => {
  it("does not mark a project broken when identity indexing fails", () => {
    const result = summarizeProjectActivity([
      task("identity", "identity_index", "failed", "2026-08-31T10:00:00Z", { error: "identity unavailable" }),
    ]);
    expect(result.state).toBe("idle");
  });

  it("does not mark a project broken when an optional local intelligence task fails after a good prepare", () => {
    const result = summarizeProjectActivity([
      task("prepare", "prepare_project", "completed", "2026-08-31T09:00:00Z"),
      task("identity", "identity_index", "failed", "2026-08-31T10:00:00Z", { error: "identity unavailable" }),
    ]);
    expect(result.state).toBe("idle");
  });

  it("keeps even an old prepare failure in Status Center instead of poisoning the project card forever", () => {
    const result = summarizeProjectActivity([
      task("prepare", "prepare_project", "failed", "2026-08-24T10:00:00Z", { error: "source unavailable" }),
    ]);
    expect(result.state).toBe("idle");
  });

  it("lets a newer successful prepare supersede an older failed prepare", () => {
    const result = summarizeProjectActivity([
      task("old", "prepare_project", "failed", "2026-08-31T09:00:00Z", { idempotency_key: "prepare:old", error: "failed" }),
      task("new", "prepare_project", "completed", "2026-08-31T10:00:00Z", { idempotency_key: "prepare:new" }),
    ]);
    expect(result.state).toBe("idle");
  });

  it("still shows background work while it is actively running", () => {
    const result = summarizeProjectActivity([
      task("identity", "identity_index", "running", "2026-08-31T10:00:00Z", { stage: "face_identity" }),
    ]);
    expect(result.state).toBe("active");
    expect(result.label).toBe("人物识别");
  });

  it("never hides an older live attempt behind a newer settled task from the same family", () => {
    const result = summarizeProjectActivity([
      task("running", "identity_index", "running", "2026-08-31T10:00:00Z", {
        idempotency_key: "identity:running",
        stage: "waiting_cpu",
        targets: { kind: "both", group_ids: ["G1"] },
      }),
      task("newer-failed", "identity_index", "failed", "2026-08-31T10:01:00Z", {
        idempotency_key: "identity:failed",
        targets: { kind: "both", group_ids: ["G2"] },
        error: "worker failed",
      }),
    ]);
    expect(result.state).toBe("active");
    expect(result.label).toBe("人物 / 声纹索引 · 等待处理资源");
  });

  it("keeps the task identity in generic queued and waiting labels", () => {
    expect(summarizeProjectActivity([
      task("scan", "media_inventory_scan", "queued", "2026-08-31T10:00:00Z"),
    ]).label).toBe("素材扫描 · 等待开始");

    expect(summarizeProjectActivity([
      task("sync", "multicam_sync", "running", "2026-08-31T10:01:00Z", { stage: "waiting_sync" }),
    ]).label).toBe("多机位同步 · 等待多机位同步资源");
  });
});
