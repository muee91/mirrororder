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

export async function collectProjectPackage(baseUrl: string, project: ProjectSummary): Promise<string | null> {
  if (!isTauri()) throw new Error("收集项目只能从桌面 App 执行。");
  const title = projectTitle(project);
  const destination = await saveDialog({
    title: "收集镜序项目",
    defaultPath: `${safeFileStem(title)}.mirrorpkg`,
    filters: [{ name: "镜序项目归档", extensions: ["mirrorpkg"] }],
  });
  if (typeof destination !== "string" || !destination.trim()) return null;
  const includeMedia = globalThis.confirm(
    "是否同时收集这台电脑已经定位的原始媒体？\n\n确定：项目 + 原始媒体\n取消：只收集项目状态和项目内文件",
  );
  const submission = await new ProjectActionClient(baseUrl).collectProject(project.project_id, destination, {
    includeCache: false,
    includeMedia,
  });
  return `已提交“${title}”收集任务${includeMedia ? "（含本机已定位媒体）" : ""}${submission.task.task_id ? ` · ${submission.task.task_id}` : ""}；进度在状态中心查看。`;
}
