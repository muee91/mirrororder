import { describe, expect, it } from "vitest";
import { canCancelTask, canRetryTask, retryTaskBody, type ProjectTaskRecord } from "./tasks";

function task(status: string, overrides: Partial<ProjectTaskRecord> = {}): ProjectTaskRecord {
  return {
    task_id: "task_1",
    type: "multicam_sync",
    status,
    stage: status,
    targets: { group_ids: ["G_1"] },
    idempotency_key: "stable-key",
    ...overrides,
  };
}

describe("desktop task controls", () => {
  it("allows cancellation only while queued or running", () => {
    expect(canCancelTask(task("queued"))).toBe(true);
    expect(canCancelTask(task("running"))).toBe(true);
    expect(canCancelTask(task("completed"))).toBe(false);
    expect(canCancelTask(task("failed"))).toBe(false);
  });

  it("allows retry only for terminal recoverable states", () => {
    expect(canRetryTask(task("failed"))).toBe(true);
    expect(canRetryTask(task("cancelled"))).toBe(true);
    expect(canRetryTask(task("interrupted"))).toBe(true);
    expect(canRetryTask(task("queued"))).toBe(false);
    expect(canRetryTask(task("completed"))).toBe(false);
  });

  it("preserves task type, targets and durable idempotency key when retrying", () => {
    expect(retryTaskBody(task("failed"))).toEqual({
      type: "multicam_sync",
      targets: { group_ids: ["G_1"] },
      actor: "desktop",
      idempotency_key: "stable-key",
    });
  });

  it("creates a retry key when older task records do not have one", () => {
    expect(retryTaskBody(task("interrupted", { idempotency_key: undefined }))).toMatchObject({
      idempotency_key: "desktop:retry:task_1",
    });
  });
});
