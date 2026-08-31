import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../api/host";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";

function project(stats: Record<string, unknown> = {}, patch: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project_id: "project-1",
    name: "示例项目",
    input_kind: "fcpxml",
    stats,
    ...patch,
  };
}

function activity(state: ProjectActivitySummary["state"], label = ""): ProjectActivitySummary {
  return { state, label, stage: "", message: "", done: null, total: null };
}

describe("project presentation model", () => {
  it("does not call an empty project ready", () => {
    const result = projectPresentation(project({ groups: 0, clips: 0 }));
    expect(result.statusTone).toBe("idle");
    expect(result.statusLabel).toBe("待整理");
    expect(result.sidebarSubtitle).toBe("待整理");
  });

  it("uses one ready state for both home and sidebar after material exists", () => {
    const result = projectPresentation(project({ groups: 12, clips: 36 }));
    expect(result.statusTone).toBe("ready");
    expect(result.statusLabel).toBe("就绪");
    expect(result.sidebarSubtitle).toBe("12 Take");
  });

  it("surfaces attention consistently", () => {
    const result = projectPresentation(project({ groups: 8, clips: 24, missing_media: 2, script_gap_blocks: 1 }));
    expect(result.statusTone).toBe("attention");
    expect(result.statusLabel).toBe("3 待处理");
    expect(result.sidebarSubtitle).toBe("8 Take · 3 待处理");
  });

  it("lets active task state override static stats", () => {
    const result = projectPresentation(project({ groups: 0, clips: 0 }), activity("active", "素材扫描"));
    expect(result.statusTone).toBe("active");
    expect(result.statusLabel).toBe("素材扫描");
    expect(result.sidebarSubtitle).toBe("素材扫描");
  });

  it("lets failure state override static stats", () => {
    const result = projectPresentation(project({ groups: 10, clips: 30 }), activity("failed"));
    expect(result.statusTone).toBe("error");
    expect(result.statusLabel).toBe("需要处理");
    expect(result.sidebarSubtitle).toBe("整理异常");
  });
});
