import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "../../api/tasks";
import { latestTaskAttempts } from "./StatusCenterWorkbench";

function task(taskId: string, status: string, key?: string): ProjectTaskRecord {
  return {
    task_id: taskId,
    type: "semantic_index",
    status,
    stage: status,
    idempotency_key: key,
  };
}

describe("status center logical task attempts", () => {
  it("uses the newest retry attempt for one durable idempotency key", () => {
    const rows = latestTaskAttempts([
      task("retry-success", "completed", "semantic:G1"),
      task("first-failure", "failed", "semantic:G1"),
    ]);

    expect(rows.map((row) => row.task_id)).toEqual(["retry-success"]);
    expect(rows[0]?.status).toBe("completed");
  });

  it("keeps the newest failure retryable without counting older attempts", () => {
    const rows = latestTaskAttempts([
      task("second-failure", "failed", "sync:G2"),
      task("first-failure", "failed", "sync:G2"),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.task_id).toBe("second-failure");
  });

  it("keeps unrelated logical tasks and task-id-only legacy records", () => {
    const rows = latestTaskAttempts([
      task("new-a", "running", "A"),
      task("new-b", "completed", "B"),
      task("legacy-1", "interrupted"),
      task("old-a", "failed", "A"),
    ]);

    expect(rows.map((row) => row.task_id)).toEqual(["new-a", "new-b", "legacy-1"]);
  });
});
