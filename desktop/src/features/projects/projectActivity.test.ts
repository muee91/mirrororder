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

  it("does surface a current project preparation failure", () => {
    const result = summarizeProjectActivity([
      task("prepare", "prepare_project", "failed", "2026-08-31T10:00:00Z", { error: "source unavailable" }),
    ]);
    expect(result.state).toBe("failed");
    expect(result.label).toBe("整理异常");
  });

  it("lets a newer successful prepare supersede an older failed prepare", () => {
    const result = summarizeProjectActivity([
      task("old", "prepare_project", "failed", "2026-08-31T09:00:00Z", { idempotency_key: "prepare:old", error: "failed" }),
      task("new", "prepare_project", "completed", "2026-08-31T10:00:00Z", { idempotency_key: "prepare:new" }),
    ]);
    expect(result.state).toBe("idle");
  });

  it("still shows auxiliary work while it is actively running", () => {
    const result = summarizeProjectActivity([
      task("identity", "identity_index", "running", "2026-08-31T10:00:00Z", { stage: "face_identity" }),
    ]);
    expect(result.state).toBe("active");
    expect(result.label).toBe("人物识别");
  });
});
