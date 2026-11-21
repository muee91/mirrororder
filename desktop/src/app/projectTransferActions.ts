import { isTauri } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ProjectSummary } from "../api/host";
import { ProjectActionClient } from "../api/projectActions";

function projectTitle(project: ProjectSummary): string {
  return project.name || project.project_id;
}

function safeFileStem(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "MirrorOrder Project";
}

export function projectTransferAvailable(): boolean {
  return isTauri();
}

export async function saveProjectCopy(baseUrl: string, project: ProjectSummary): Promise<string | null> {
  if (!isTauri()) throw new Error("另存项目只能从桌面 App 执行。");
  const title = projectTitle(project);
  const destination = await saveDialog({
    title: "另存镜序项目",
    defaultPath: `${safeFileStem(title)} 副本.mirrorproj`,
    filters: [{ name: "镜序项目", extensions: ["mirrorproj"] }],
  });
  if (typeof destination !== "string" || !destination.trim()) return null;
  const submission = await new ProjectActionClient(baseUrl).saveProjectAs(project.project_id, destination, {
    name: `${title} 副本`,
    includeCache: false,
  });
  return `已提交“${title}”另存任务${submission.task.task_id ? ` · ${submission.task.task_id}` : ""}；进度在状态中心查看。`;
}
