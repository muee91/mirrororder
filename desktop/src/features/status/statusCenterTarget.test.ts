import { describe, expect, it } from "vitest";
import type { ProjectTaskRecord } from "../../api/tasks";
import { taskTarget } from "./StatusCenterWorkbench";

function task(patch: Partial<ProjectTaskRecord>): ProjectTaskRecord {
  return { task_id: "task", type: "unknown", status: "queued", stage: "queued", ...patch };
}

describe("status center task targets", () => {
  it("opens multicam sync work in the sync task page", () => {
    expect(taskTarget(task({ type: "multicam_sync", status: "failed" }))).toEqual({
      label: "打开同步任务",
      page: "sync-task",
    });
  });

  it("keeps device runtime work in settings", () => {
    expect(taskTarget(task({ type: "identity_runtime_prepare", scope: "device", status: "running" }))).toEqual({
      label: "本机智能设置",
      settings: true,
    });
  });
});
