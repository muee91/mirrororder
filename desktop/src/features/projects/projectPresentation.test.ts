import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("does not call a media-only project ready before Takes exist", () => {
    const result = projectPresentation(project({ groups: 0, clips: 18 }));
    expect(result.statusTone).toBe("idle");
    expect(result.statusLabel).toBe("待整理");
    expect(result.sidebarSubtitle).toBe("18 素材 · 待整理");
  });

  it("uses one ready state for both home and sidebar after Takes exist", () => {
    const result = projectPresentation(project({ groups: 12, clips: 36 }));
    expect(result.statusTone).toBe("ready");
    expect(result.statusLabel).toBe("就绪");
    expect(result.sidebarSubtitle).toBe("12 Take");
  });

  it("surfaces attention consistently", () => {
    const result = projectPresentation(project({ groups: 8, clips: 24, missing_media: 2, script_gap_blocks: 1 }));
    expect(result.statusTone).toBe("attention");
    expect(result.statusLabel).toBe("3 需关注");
    expect(result.sidebarSubtitle).toBe("8 Take · 3 需关注");
  });

  it("lets active background work override static stats while it is actually running", () => {
    const result = projectPresentation(project({ groups: 0, clips: 0 }), activity("active", "素材扫描"));
    expect(result.statusTone).toBe("active");
    expect(result.statusLabel).toBe("素材扫描");
    expect(result.sidebarSubtitle).toBe("素材扫描");
  });

  it("uses project data error as the persistent error authority", () => {
    const result = projectPresentation(project({ groups: 10, clips: 30 }, { error: "项目源损坏" }));
    expect(result.statusTone).toBe("error");
    expect(result.statusLabel).toBe("需要处理");
    expect(result.sidebarSubtitle).toBe("项目异常");
  });

  it("does not expose a failed task activity state as a project-card authority", () => {
    const activitySource = readFileSync(fileURLToPath(new URL("./projectActivity.ts", import.meta.url)), "utf8");
    const presentationSource = readFileSync(fileURLToPath(new URL("./projectPresentation.ts", import.meta.url)), "utf8");
    expect(activitySource).toContain('export type ProjectActivityState = "idle" | "active";');
    expect(presentationSource).not.toContain('activity?.state === "failed"');
  });
});
