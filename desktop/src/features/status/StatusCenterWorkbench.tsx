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

function progress(task: ProjectTaskRecord): { done: number; total: number } | null {
  const value = task.progress ?? {};
  const done = value.done ?? value.audit_done ?? value.perception_done ?? value.face_done ?? value.speaker_done;
  const total = value.total ?? value.audit_total ?? value.perception_total ?? value.face_total ?? value.speaker_total;
  if (typeof done !== "number" || typeof total !== "number" || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

function taskLabel(task: ProjectTaskRecord): string {
  const labels: Record<string, string> = {
    audit: "素材审计",
    perception: "内容识别",
    face: "人物识别",
    speaker: "声纹识别",
    analysis: "素材分析",
    organize: "整理素材",
    transcription: "转写",
    transcribe: "转写",
    multicam: "多机位同步",
    semantic_index: "语义索引",
  };
  return labels[task.type] || task.type || "后台任务";
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
      if (!quiet) setMessage(activeCount ? `${activeCount} 个任务正在处理 · ${failedCount} 个需要注意` : failedCount ? `${failedCount} 个任务需要注意` : "当前没有运行中或失败的后台任务。");
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
      completed: tasks.filter((task) => task.status === "completed").length,
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

  const visibleRows = rows.filter((row) => row.error || row.tasks.some((task) => active(task) || attention(task) || canRetryTask(task)));

  return (
    <section className="status-center-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">Production Status</p><h2>状态中心</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload(false)}>刷新</button></div>
      </header>

      <div className="status-center-summary">
        <span><strong>{totals.active}</strong>正在处理</span>
        <span className={totals.attention ? "needs-attention" : ""}><strong>{totals.attention}</strong>需要注意</span>
        <span><strong>{totals.retryable}</strong>可重试</span>
        <span><strong>{totals.completed}</strong>近期完成</span>
      </div>

      <p className="status-center-note">同步、转写、剧本匹配、内容识别、人物、声纹、语义索引与 Audit 的后台执行统一在这里查看。项目工作区只保留制作对象和必要的轻量进度。</p>

      <div className="status-center-projects">
        {visibleRows.map((row) => {
          const visibleTasks = row.tasks.filter((task) => active(task) || attention(task) || canRetryTask(task)).slice(0, 12);
          return (
            <section className="status-center-project" key={row.project.project_id}>
              <div className="status-center-project-head">
                <div><strong>{row.project.name || row.project.project_id}</strong><span>{row.error || `${visibleTasks.length} 个当前事项`}</span></div>
                <button type="button" className="secondary" onClick={() => onOpenProject(row.project.project_id)}>打开项目</button>
              </div>
              {row.error ? <p className="status-center-error">{row.error}</p> : null}
              <div className="status-center-task-list">
                {visibleTasks.map((task) => {
                  const taskProgress = progress(task);
                  return (
                    <article className={`status-center-task status-${task.status}`} key={task.task_id}>
                      <div className="status-center-task-name"><strong>{taskLabel(task)}</strong><span>{statusLabel(task)}{task.stage ? ` · ${task.stage}` : ""}</span></div>
                      {taskProgress ? <div className="status-center-progress"><progress value={taskProgress.done} max={taskProgress.total} /><span>{taskProgress.done} / {taskProgress.total}</span></div> : <div />}
                      <p>{task.error || task.message || ""}</p>
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
        {!visibleRows.length ? <div className="status-center-empty"><strong>后台工作正常</strong><span>当前没有运行中、失败或可重试任务。</span></div> : null}
      </div>
    </section>
  );
}
