import { useCallback, useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import {
  ProjectTaskClient,
  canCancelTask,
  canRetryTask,
  type ProjectTaskRecord,
} from "../../api/tasks";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function isActive(task: ProjectTaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function progress(task: ProjectTaskRecord): { done: number; total: number } | null {
  const values = task.progress ?? {};
  const done = values.done ?? values.audit_done ?? values.perception_done ?? values.face_done ?? values.speaker_done;
  const total = values.total ?? values.audit_total ?? values.perception_total ?? values.face_total ?? values.speaker_total;
  if (typeof done !== "number" || typeof total !== "number" || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return { done, total };
}

function displayTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusLabel(task: ProjectTaskRecord): string {
  if (task.status === "running" && task.cancel_requested) return "正在取消";
  return task.status || "unknown";
}

export function TaskStatusPanel({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const [tasks, setTasks] = useState<ProjectTaskRecord[]>([]);
  const [message, setMessage] = useState("读取当前项目后台任务…");
  const [busy, setBusy] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false): Promise<ProjectTaskRecord[]> => {
    if (!quiet) setBusy(true);
    try {
      const next = await client.list(projectId);
      setTasks(next);
      if (!quiet) setMessage(next.some(isActive) ? "存在运行中任务；活动期间每秒刷新。" : "当前没有运行中任务。");
      return next;
    } catch (error) {
      setMessage(errorMessage(error));
      return [];
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function monitor(): Promise<void> {
      const next = await refresh(true);
      if (cancelled) return;
      if (next.some(isActive)) {
        timer = globalThis.setTimeout(() => { void monitor(); }, 1000);
      }
    }

    void refresh(false).then((next) => {
      if (!cancelled && next.some(isActive)) {
        timer = globalThis.setTimeout(() => { void monitor(); }, 1000);
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [refresh]);

  async function cancelTask(task: ProjectTaskRecord): Promise<void> {
    if (!canCancelTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(task.status === "queued" ? "正在取消排队任务…" : "已请求取消；当前安全阶段结束后停止。 ");
    try {
      await client.cancel(projectId, task.task_id);
      await refresh(true);
      setMessage(task.status === "queued" ? "排队任务已取消。" : "取消请求已提交；镜序会在当前可中断阶段停止任务。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  async function retryTask(task: ProjectTaskRecord): Promise<void> {
    if (!canRetryTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(`正在重新排队 ${task.type || "后台任务"}…`);
    try {
      const retried = await client.retry(projectId, task);
      await refresh(true);
      setMessage(`已重新排队 · ${retried.task_id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  const active = tasks.find(isActive) ?? null;
  const activeProgress = active ? progress(active) : null;
  const recent = tasks.slice(0, 8);

  return (
    <div className="production-panel status-card task-status-card">
      <div className="parse-heading">
        <div>
          <p className="eyebrow">Durable Project Tasks</p>
          <h3>后台任务</h3>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh(false)}>刷新</button>
      </div>

      {active ? (
        <div className="task-active-card">
          <div className="task-status-line">
            <strong>{active.type || "后台任务"}</strong>
            <span>{statusLabel(active)} · {active.stage || "-"}</span>
          </div>
          {activeProgress ? (
            <div className="task-progress-row">
              <progress value={activeProgress.done} max={activeProgress.total} />
              <span>{activeProgress.done} / {activeProgress.total}</span>
            </div>
          ) : null}
          {active.message ? <p className="production-note">{active.message}</p> : null}
          <div className="task-row-actions">
            <button
              type="button"
              className="secondary"
              disabled={!canCancelTask(active) || Boolean(actionTaskId) || Boolean(active.cancel_requested)}
              onClick={() => void cancelTask(active)}
            >{active.cancel_requested ? "正在取消" : "取消任务"}</button>
          </div>
        </div>
      ) : (
        <p className="empty-copy">当前没有 queued / running 任务。</p>
      )}

      {recent.length ? (
        <div className="task-status-list">
          {recent.map((task) => (
            <div className="task-status-row" key={task.task_id}>
              <div className="task-status-name">
                <strong>{task.type || "后台任务"}</strong>
                <span>{task.stage || "-"}</span>
              </div>
              <div className="task-status-meta">
                <span className={isActive(task) ? "is-active" : task.status === "completed" ? "is-complete" : ""}>{statusLabel(task)}</span>
                <small>{displayTime(task.completed_at || task.started_at || task.created_at)}</small>
              </div>
              {task.error ? <p className="task-error">{task.error}</p> : null}
              {canCancelTask(task) || canRetryTask(task) ? (
                <div className="task-row-actions">
                  {canCancelTask(task) ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={Boolean(actionTaskId) || Boolean(task.cancel_requested)}
                      onClick={() => void cancelTask(task)}
                    >{task.cancel_requested ? "正在取消" : "取消"}</button>
                  ) : null}
                  {canRetryTask(task) ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={Boolean(actionTaskId)}
                      onClick={() => void retryTask(task)}
                    >重试</button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="production-note">{message}</p>
      <p className="production-note">支持现有 TaskManager 语义：queued/running 可取消，failed/cancelled/interrupted 可重新排队；当前后端没有任务优先级或手动重排语义，因此界面不会伪造队列排序控制。</p>
    </div>
  );
}
