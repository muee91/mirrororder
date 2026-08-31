import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import {
  isTaskActive,
  latestTaskFamilies,
  taskAttemptTimestamp,
} from "../../api/taskSemantics";
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

const EMPTY_ACTIVITY: ProjectActivitySummary = { state: "idle", label: "", stage: "", message: "", done: null, total: null };
const ACTIVE_POLL_MS = 2000;
const IDLE_FULL_POLL_MS = 15000;
const ACTIVE_TICKS_BEFORE_FULL_REFRESH = 5;

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
  const current = latestTaskFamilies(tasks).sort((left, right) => taskAttemptTimestamp(right) - taskAttemptTimestamp(left));
  const activeTask = current.find(isTaskActive);
  if (activeTask) {
    return {
      state: "active",
      label: taskLabel(activeTask),
      stage: activeTask.stage,
      message: activeTask.message || "",
      ...taskProgress(activeTask),
    };
  }

  // Project cards describe the project's current data state, not the lifetime
  // history of background jobs. Durable task failures belong in Status Center;
  // ProjectSummary.error and project statistics remain the project-health authority.
  const latest = current[0];
  return { state: "idle", label: "", stage: latest?.stage || "", message: "", done: null, total: null };
}

export function useProjectActivities(baseUrl: string, projects: ProjectSummary[]) {
  const client = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const [activities, setActivities] = useState<Record<string, ProjectActivitySummary>>({});

  const readProjects = useCallback(async (targets: ProjectSummary[]): Promise<Record<string, ProjectActivitySummary>> => {
    const rows = await Promise.all(targets.map(async (project) => {
      try {
        return [project.project_id, summarizeProjectActivity(await client.list(project.project_id))] as const;
      } catch {
        return [project.project_id, EMPTY_ACTIVITY] as const;
      }
    }));
    return Object.fromEntries(rows) as Record<string, ProjectActivitySummary>;
  }, [client]);

  const refresh = useCallback(async (): Promise<Record<string, ProjectActivitySummary>> => {
    if (!projects.length) {
      setActivities({});
      return {};
    }
    const next = await readProjects(projects);
    setActivities(next);
    return next;
  }, [projects, readProjects]);

  const refreshActive = useCallback(async (projectIds: string[]): Promise<Record<string, ProjectActivitySummary>> => {
    const wanted = new Set(projectIds);
    const targets = projects.filter((project) => wanted.has(project.project_id));
    if (!targets.length) return {};
    const next = await readProjects(targets);
    setActivities((current) => ({ ...current, ...next }));
    return next;
  }, [projects, readProjects]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    function activeIds(snapshot: Record<string, ProjectActivitySummary>): string[] {
      return Object.entries(snapshot).filter(([, item]) => item.state === "active").map(([projectId]) => projectId);
    }

    async function fullMonitor(): Promise<void> {
      const next = await refresh();
      if (cancelled) return;
      const active = activeIds(next);
      if (!active.length) {
        timer = globalThis.setTimeout(() => { void fullMonitor(); }, IDLE_FULL_POLL_MS);
        return;
      }
      timer = globalThis.setTimeout(() => { void activeMonitor(active, 0); }, ACTIVE_POLL_MS);
    }

    async function activeMonitor(projectIds: string[], tick: number): Promise<void> {
      const next = await refreshActive(projectIds);
      if (cancelled) return;
      const active = activeIds(next);
      if (!active.length || tick + 1 >= ACTIVE_TICKS_BEFORE_FULL_REFRESH) {
        timer = globalThis.setTimeout(() => { void fullMonitor(); }, active.length ? ACTIVE_POLL_MS : IDLE_FULL_POLL_MS);
        return;
      }
      timer = globalThis.setTimeout(() => { void activeMonitor(active, tick + 1); }, ACTIVE_POLL_MS);
    }

    void fullMonitor();
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [refresh, refreshActive]);

  return { activities, refreshActivities: refresh };
}
