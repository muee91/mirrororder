import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "../../api/tasks";
import { latestTaskAttempts, statusPollDelay, taskNeedsAttention } from "./StatusCenterWorkbench";

function task(taskId: string, status: string, key?: string, createdAt?: string, completedAt?: string): ProjectTaskRecord {
  return {
    task_id: taskId,
    type: "semantic_index",
    status,
    stage: status,
    idempotency_key: key,
    created_at: createdAt,
    completed_at: completedAt,
  };
}

describe("status center recovery semantics", () => {
  it("chooses the newest retry attempt by creation timestamp instead of trusting API array order", () => {
    const rows = latestTaskAttempts([
      task("first-failure", "failed", "semantic:G1", "2026-08-31T10:00:00Z"),
      task("retry-success", "completed", "semantic:G1", "2026-08-31T10:05:00Z"),
    ]);

    expect(rows.map((row) => row.task_id)).toEqual(["retry-success"]);
    expect(rows[0]?.status).toBe("completed");
  });

  it("does not mistake an older attempt that completed later for the newest retry", () => {
    const rows = latestTaskAttempts([
      task("older-long-run", "completed", "semantic:G3", "2026-08-31T10:00:00Z", "2026-08-31T12:00:00Z"),
      task("newer-retry", "running", "semantic:G3", "2026-08-31T11:00:00Z"),
    ]);
    expect(rows.map((row) => row.task_id)).toEqual(["newer-retry"]);
  });

  it("keeps the newest failure retryable without counting older attempts", () => {
    const rows = latestTaskAttempts([
      task("first-failure", "failed", "sync:G2", "2026-08-31T10:00:00Z"),
      task("second-failure", "failed", "sync:G2", "2026-08-31T10:02:00Z"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_id).toBe("second-failure");
  });

  it("keeps unrelated logical tasks and task-id-only legacy records", () => {
    const rows = latestTaskAttempts([
      task("old-a", "failed", "A", "2026-08-31T09:00:00Z"),
      task("legacy-1", "interrupted", undefined, "2026-08-31T09:30:00Z"),
      task("new-b", "completed", "B", "2026-08-31T10:00:00Z"),
      task("new-a", "running", "A", "2026-08-31T11:00:00Z"),
    ]);

    expect(rows.map((row) => row.task_id)).toEqual(["new-a", "new-b", "legacy-1"]);
  });

  it("does not treat a user-cancelled task as an unresolved problem", () => {
    expect(taskNeedsAttention(task("failed", "failed"))).toBe(true);
    expect(taskNeedsAttention(task("interrupted", "interrupted"))).toBe(true);
    expect(taskNeedsAttention(task("cancelled", "cancelled"))).toBe(false);
    expect(taskNeedsAttention(task("completed", "completed"))).toBe(false);
  });

  it("continues monitoring while idle at a lower frequency", () => {
    expect(statusPollDelay(true)).toBe(1000);
    expect(statusPollDelay(false)).toBe(8000);
  });

  it("keeps the UI recovery-first instead of exposing a bounded project task table", () => {
    const source = readFileSync(fileURLToPath(new URL("./StatusCenterWorkbench.tsx", import.meta.url)), "utf8");
    expect(source).toContain("需要处理");
    expect(source).toContain("正在处理");
    expect(source).toContain("最近记录");
    expect(source).toContain("不等同于完整 attempt 历史");
    expect(source).toContain("技术详情");
    expect(source).toContain("onOpenProjectPage");
    expect(source).toContain("onOpenSettings");
    expect(source).not.toContain("可重试</");
    expect(source).not.toContain(".slice(0, 12)");
    expect(source).not.toContain("查看历史");
  });
});
