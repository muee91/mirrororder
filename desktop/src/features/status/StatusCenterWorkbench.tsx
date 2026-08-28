import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { HostConnectionError } from "../../api/host";
import {
  ProjectTaskClient,
  canCancelTask,
  canRetryTask,
  type ProjectTaskRecord,
} from "../../api/tasks";
import "./status-center.css";

interface Props {
  baseUrl: string;
  projects: ProjectSummary[];
  onOpenProject: (projectId: string) => void;
}

interface ProjectTasks {
  project: ProjectSummary;
  tasks: ProjectTaskRecord[];
  error: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function active(task: ProjectTaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function attention(task: ProjectTaskRecord): boolean {
  return task.status === "failed" || task.status === "interrupted" || Boolean(task.error);
}

function completed(task: ProjectTaskRecord): boolean {
  return task.status === "completed";
}

function progress(task: ProjectTaskRecord): { done: number; total: number } | null {
  const value = task.progress ?? {};
  const done = value.done ?? value.audit_done ?? value.perception_done ?? value.face_done ?? value.speaker_done;
  const total = value.total ?? value.audit_total ?? value.perception_total ?? value.face_total ?? value.speaker_total;
  if (typeof done !== "number" || typeof total !== "number" || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

function taskLabel(task: ProjectTaskRecord): string {
  const labels: Record<string, string> = {
    prepare_project: "准备项目",
    multicam_sync: "多机位同步",
    incremental_analyze: "增量素材分析",
    auto_resolve: "剧本归集整理",
    transcribe: "转写",
    evidence_extract: "证据提取",
    identity_index: "人物 / 声纹索引",
    semantic_index: "语义索引",
    audit: "素材审计",
    perception: "内容识别",
    face: "人物识别",
    speaker: "声纹识别",
    analysis: "素材分析",
    organize: "整理素材",
    transcription: "转写",
    multicam: "多机位同步",
  };
  return labels[task.type] || task.type || "后台任务";
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: "等待开始",
    starting: "正在启动",
    sync: "同步",
    analysis: "素材分析",
    resolve: "剧本归集",
    asr: "转写",
    evidence: "证据提取",
    perception_index: "感知索引",
    semantic_index: "语义索引",
    face_identity: "人脸索引",
    speaker_identity: "声纹索引",
    waiting_cpu: "等待处理资源",
    waiting_mlx: "等待本地模型资源",
    waiting_vision: "等待视觉资源",
    waiting_embedding: "等待语义模型资源",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[stage] || stage;
}

function statusLabel(task: ProjectTaskRecord): string {
  if (task.cancel_requested && active(task)) return "正在取消";
  return {
    queued: "排队中",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  }[task.status] ?? task.status;
}

function sortTasks(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const rank = (task: ProjectTaskRecord) => active(task) ? 0 : attention(task) ? 1 : canRetryTask(task) ? 2 : 3;
  return [...tasks].sort((left, right) => rank(left) - rank(right) || String(right.created_at || "").localeCompare(String(left.created_at || "")));
}

export function StatusCenterWorkbench({ baseUrl, projects, onOpenProject }: Props) {
  const client = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const [rows, setRows] = useState<ProjectTasks[]>([]);
  const [message, setMessage] = useState("正在读取所有项目的后台工作…");
  const [busy, setBusy] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const reload = useCallback(async (quiet = false): Promise<ProjectTasks[]> => {
    if (!quiet) setBusy(true);
    try {
      const next = await Promise.all(projects.map(async (project): Promise<ProjectTasks> => {
        try {
          return { project, tasks: sortTasks(await client.list(project.project_id)), error: "" };
        } catch (error) {
          return { project, tasks: [], error: errorMessage(error) };
        }
      }));
      setRows(next);
      const all = next.flatMap((row) => row.tasks);
      const activeCount = all.filter(active).length;
      const failedCount = all.filter(attention).length;
      if (!quiet) setMessage(activeCount ? `${activeCount} 个任务正在处理 · ${failedCount} 个需要注意` : failedCount ? `${failedCount} 个任务需要注意` : "后台任务当前正常。");
      return next;
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [client, projects]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    async function monitor(): Promise<void> {
      const next = await reload(true);
      if (cancelled) return;
      if (next.some((row) => row.tasks.some(active))) {
        timer = globalThis.setTimeout(() => { void monitor(); }, 1000);
      }
    }

    void reload(false).then((next) => {
      if (!cancelled && next.some((row) => row.tasks.some(active))) {
        timer = globalThis.setTimeout(() => { void monitor(); }, 1000);
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [reload]);

  const totals = useMemo(() => {
    const tasks = rows.flatMap((row) => row.tasks);
    return {
      active: tasks.filter(active).length,
      attention: tasks.filter(attention).length,
      retryable: tasks.filter(canRetryTask).length,
      completed: tasks.filter(completed).length,
    };
  }, [rows]);

  async function cancel(projectId: string, task: ProjectTaskRecord): Promise<void> {
    if (!canCancelTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage("正在请求安全取消后台任务…");
    try {
      await client.cancel(projectId, task.task_id);
      await reload(true);
      setMessage("取消请求已提交；任务会在当前可中断阶段停止。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  async function retry(projectId: string, task: ProjectTaskRecord): Promise<void> {
    if (!canRetryTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(`正在重新排队 ${taskLabel(task)}…`);
    try {
      await client.retry(projectId, task);
      await reload(true);
      setMessage(`${taskLabel(task)} 已重新排队。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  const relevant = (task: ProjectTaskRecord): boolean => active(task) || attention(task) || canRetryTask(task) || (showCompleted && completed(task));
  const visibleRows = rows.filter((row) => row.error || row.tasks.some(relevant));

  return (
    <section className="status-center-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">后台工作</p><h2>状态中心</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload(false)}>刷新</button></div>
      </header>

      <div className="status-center-summary">
        <span><strong>{totals.active}</strong>正在处理</span>
        <span className={totals.attention ? "needs-attention" : ""}><strong>{totals.attention}</strong>需要注意</span>
        <span><strong>{totals.retryable}</strong>可重试</span>
        <button type="button" className={showCompleted ? "is-active" : ""} aria-pressed={showCompleted} onClick={() => setShowCompleted((value) => !value)}><strong>{totals.completed}</strong>{showCompleted ? "隐藏已完成" : "查看已完成"}</button>
      </div>

      <p className="status-center-note">同步、转写、素材分析、内容识别、人物 / 声纹与剧本归集等后台工作统一在这里查看。项目画布只显示制作对象和必要的轻量进度。</p>

      <div className="status-center-projects">
        {visibleRows.map((row) => {
          const visibleTasks = row.tasks.filter(relevant).slice(0, 12);
          return (
            <section className="status-center-project" key={row.project.project_id}>
              <div className="status-center-project-head">
                <div><strong>{row.project.name || row.project.project_id}</strong><span>{row.error || `${visibleTasks.length} 个${showCompleted ? "显示事项" : "当前事项"}`}</span></div>
                <button type="button" className="secondary" onClick={() => onOpenProject(row.project.project_id)}>打开项目</button>
              </div>
              {row.error ? <p className="status-center-error">{row.error}</p> : null}
              <div className="status-center-task-list">
                {visibleTasks.map((task) => {
                  const taskProgress = progress(task);
                  const stage = task.stage ? stageLabel(task.stage) : "";
                  return (
                    <article className={`status-center-task status-${task.status}`} key={task.task_id}>
                      <div className="status-center-task-name"><strong>{taskLabel(task)}</strong><span>{statusLabel(task)}{stage ? ` · ${stage}` : ""}</span></div>
                      {taskProgress ? <div className="status-center-progress"><progress value={taskProgress.done} max={taskProgress.total} /><span>{taskProgress.done} / {taskProgress.total}</span></div> : <div />}
                      <p>{task.error || task.message || (completed(task) ? "已完成" : "")}</p>
                      <div className="status-center-actions">
                        {canCancelTask(task) ? <button type="button" className="secondary" disabled={Boolean(actionTaskId) || Boolean(task.cancel_requested)} onClick={() => void cancel(row.project.project_id, task)}>{task.cancel_requested ? "正在取消" : "取消"}</button> : null}
                        {canRetryTask(task) ? <button type="button" disabled={Boolean(actionTaskId)} onClick={() => void retry(row.project.project_id, task)}>重试</button> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
        {!visibleRows.length ? <div className="status-center-empty"><strong>后台工作正常</strong><span>{showCompleted ? "当前没有可显示的后台任务记录。" : "当前没有运行中、失败或可重试任务；可展开“已完成”查看历史。"}</span></div> : null}
      </div>
    </section>
  );
}
