import type { ProjectSummary } from "../../api/host";
import type { ProjectActivitySummary } from "./projectActivity";

export type ProjectPresentationTone = "idle" | "ready" | "attention" | "active" | "error";

export interface ProjectPresentation {
  kind: string;
  takes: number;
  clips: number;
  attention: number;
  statusLabel: string;
  statusTone: ProjectPresentationTone;
  sidebarSubtitle: string;
}

function numberStat(project: ProjectSummary, ...keys: string[]): number {
  for (const key of keys) {
    const value = project.stats?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function attentionCount(project: ProjectSummary): number {
  const explicit = numberStat(project, "attention", "issues", "pending_review");
  if (explicit > 0) return explicit;
  return numberStat(project, "missing_media")
    + numberStat(project, "unknown_groups")
    + numberStat(project, "script_gap_blocks");
}

export function projectPresentation(
  project: ProjectSummary,
  activity?: ProjectActivitySummary,
): ProjectPresentation {
  const takes = numberStat(project, "groups", "takes");
  const clips = numberStat(project, "clips", "media");
  const attention = attentionCount(project);
  const kind = project.input_kind === "fcpxml" ? "FCPXML" : "素材目录";

  if (project.error) {
    return {
      kind,
      takes,
      clips,
      attention,
      statusLabel: "需要处理",
      statusTone: "error",
      sidebarSubtitle: "项目异常",
    };
  }

  if (activity?.state === "active") {
    const label = activity.label || "后台整理中";
    return {
      kind,
      takes,
      clips,
      attention,
      statusLabel: label,
      statusTone: "active",
      sidebarSubtitle: label,
    };
  }

  if (attention > 0) {
    return {
      kind,
      takes,
      clips,
      attention,
      statusLabel: `${attention} 待处理`,
      statusTone: "attention",
      sidebarSubtitle: takes > 0 ? `${takes} Take · ${attention} 待处理` : `${attention} 待处理`,
    };
  }

  if (takes === 0) {
    return {
      kind,
      takes,
      clips,
      attention,
      statusLabel: "待整理",
      statusTone: "idle",
      sidebarSubtitle: clips > 0 ? `${clips} 素材 · 待整理` : "待整理",
    };
  }

  return {
    kind,
    takes,
    clips,
    attention,
    statusLabel: "就绪",
    statusTone: "ready",
    sidebarSubtitle: `${takes} Take`,
  };
}
