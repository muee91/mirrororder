import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "../../api/tasks";
import { taskIndicatorState } from "./StatusCenterWorkbench";

function task(status: string, patch: Partial<ProjectTaskRecord> = {}): ProjectTaskRecord {
  return {
    task_id: `task-${status}`,
    type: "semantic_index",
    status,
    stage: status,
    ...patch,
  };
}

describe("status center shared task indicator semantics", () => {
  it("keeps durable active state even when an error detail is present", () => {
    expect(taskIndicatorState(task("queued", { error: "diagnostic detail" }))).toBe("queued");
    expect(taskIndicatorState(task("running", { error: "diagnostic detail" }))).toBe("running");
  });

  it("maps settled durable states into the shared task status family", () => {
    expect(taskIndicatorState(task("completed"))).toBe("complete");
    expect(taskIndicatorState(task("failed"))).toBe("failed");
    expect(taskIndicatorState(task("interrupted"))).toBe("warning");
    expect(taskIndicatorState(task("cancelled"))).toBe("cancelled");
  });

  it("renders old failures as historical warnings instead of current failures", () => {
    expect(taskIndicatorState(task("failed"), true)).toBe("warning");
    expect(taskIndicatorState(task("interrupted"), true)).toBe("warning");
    expect(taskIndicatorState(task("failed", {
      superseded_at: "2026-09-03T00:00:00Z",
      superseded_reason: "current settings replaced this attempt",
    }), true)).toBe("warning");
  });

  it("falls back to failure only for unknown current states that actually need attention", () => {
    expect(taskIndicatorState(task("custom-state", { error: "needs operator attention" }))).toBe("failed");
    expect(taskIndicatorState(task("custom-state"))).toBe("warning");
  });
});
