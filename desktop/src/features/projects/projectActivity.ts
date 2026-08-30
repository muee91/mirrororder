import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { ProjectTaskClient, type ProjectTaskRecord } from "../../api/tasks";

export type ProjectActivityState = "idle" | "active" | "failed";

export interface ProjectActivitySummary {
  state: ProjectActivityState;
  label: string;
  stage: string;
  message: string;
  done: number | null;
  total: number | null;
}

function isActive(task: ProjectTaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isFailed(task: ProjectTaskRecord): boolean {
  return task.status === "failed" || task.status === "interrupted" || Boolean(task.error);
}

function latestTaskAttempts(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const seen = new Set<string>();
  const rows: ProjectTaskRecord[] = [];
  for (const task of tasks) {
    const key = task.idempotency_key?.trim() || task.task_id;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(task);
  }
  return rows;
}

function taskTime(task: ProjectTaskRecord): string {
  return task.created_at || task.started_at || task.completed_at || "";
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: "等待开始",
    starting: "正在启动",
    media_inventory: "素材扫描",
    waveform: "波形生成",
    sync: "多机位同步",
    analysis: "素材分析",
    resolve: "剧本归集",
    asr: "转写",
    evidence: "提取证据",
    perception_index: "内容索引",
    semantic_index: "语义索引",
    face_identity: "人物识别",
    speaker_identity: "声纹识别",
    waiting_cpu: "等待处理资源",
    waiting_mlx: "等待本地模型",
    waiting_vision: "等待视觉资源",
    waiting_embedding: "等待语义索引",
  };
  return labels[stage] || stage;
}

function taskLabel(task: ProjectTaskRecord): string {
  const labels: Record<string, string> = {
    prepare_project: "正在整理",
    media_inventory_scan: "素材扫描",
    waveform_build: "波形生成",
    multicam_sync: "多机位同步",
    incremental_analyze: "素材分析",
    auto_resolve: "剧本归集",
    transcribe: "转写",
    evidence_extract: "提取证据",
    identity_index: "人物 / 声纹索引",
    semantic_index: "语义索引",
    audit: "素材审计",
    perception: "内容识别",
  };
  return stageLabel(task.stage) || labels[task.type] || task.type || "后台处理中";
}

function taskProgress(task: ProjectTaskRecord): { done: number | null; total: number | null } {
  const value = task.progress ?? {};
  const done = value.done ?? value.audit_done ?? value.perception_done ?? value.face_done ?? value.speaker_done;
  const total = value.total ?? value.audit_total ?? value.perception_total ?? value.face_total ?? value.speaker_total;
  return {
    done: typeof done === "number" && Number.isFinite(done) ? done : null,
    total: typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null,
  };
}

export function summarizeProjectActivity(tasks: ProjectTaskRecord[]): ProjectActivitySummary {
  const latest = latestTaskAttempts(tasks).sort((left, right) => taskTime(right).localeCompare(taskTime(left)));
  const task = latest.find(isActive) ?? latest[0];
  if (!task) return { state: "idle", label: "", stage: "", message: "", done: null, total: null };
  const progress = taskProgress(task);
  if (isActive(task)) {
    return {
      state: "active",
      label: taskLabel(task),
      stage: task.stage,
      message: task.message || "",
      ...progress,
    };
  }
  if (isFailed(task)) {
    return {
      state: "failed",
      label: "整理异常",
      stage: task.stage,
      message: task.error || task.message || "任务未完成",
      ...progress,
    };
  }
  return { state: "idle", label: "", stage: task.stage, message: "", done: null, total: null };
}

export function useProjectActivities(baseUrl: string, projects: ProjectSummary[]) {
  const client = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const [activities, setActivities] = useState<Record<string, ProjectActivitySummary>>({});

  const refresh = useCallback(async (): Promise<Record<string, ProjectActivitySummary>> => {
    if (!projects.length) {
      setActivities({});
      return {};
    }
    const rows = await Promise.all(projects.map(async (project) => {
      try {
        return [project.project_id, summarizeProjectActivity(await client.list(project.project_id))] as const;
      } catch {
        return [project.project_id, { state: "idle", label: "", stage: "", message: "", done: null, total: null } satisfies ProjectActivitySummary] as const;
      }
    }));
    const next = Object.fromEntries(rows) as Record<string, ProjectActivitySummary>;
    setActivities(next);
    return next;
  }, [client, projects]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    async function monitor(): Promise<void> {
      const next = await refresh();
      if (cancelled) return;
      const active = Object.values(next).some((item) => item.state === "active");
      timer = globalThis.setTimeout(() => { void monitor(); }, active ? 1000 : 8000);
    }

    void monitor();
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [refresh]);

  return { activities, refreshActivities: refresh };
}
