import { useCallback, useEffect, useMemo, useState } from "react";
import { DesktopClient, type ProjectTaskStatus } from "../../api/desktop";
import { HostConnectionError } from "../../api/host";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function isActive(task: ProjectTaskStatus): boolean {
  return task.status === "queued" || task.status === "running";
}

function progress(task: ProjectTaskStatus): { done: number; total: number } | null {
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

export function TaskStatusPanel({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [tasks, setTasks] = useState<ProjectTaskStatus[]>([]);
  const [message, setMessage] = useState("读取当前项目后台任务…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (quiet = false): Promise<ProjectTaskStatus[]> => {
    if (!quiet) setBusy(true);
    try {
      const next = await client.projectTasks(projectId);
      setTasks(next);
      if (!quiet) setMessage(next.some(isActive) ? "存在运行中任务；活动期间每秒只读刷新。" : "当前没有运行中任务。");
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

  const active = tasks.find(isActive) ?? null;
  const activeProgress = active ? progress(active) : null;
  const recent = tasks.slice(0, 8);

  return (
    <div className="production-panel status-card task-status-card">
      <div className="parse-heading">
        <div>
          <p className="eyebrow">Existing Python TaskManager · Read Only</p>
          <h3>后台任务</h3>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh(false)}>刷新</button>
      </div>

      {active ? (
        <div className="task-active-card">
          <div className="task-status-line">
            <strong>{active.type || "后台任务"}</strong>
            <span>{active.status} · {active.stage || "-"}</span>
          </div>
          {activeProgress ? (
            <div className="task-progress-row">
              <progress value={activeProgress.done} max={activeProgress.total} />
              <span>{activeProgress.done} / {activeProgress.total}</span>
            </div>
          ) : null}
          {active.message ? <p className="production-note">{active.message}</p> : null}
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
                <span className={isActive(task) ? "is-active" : task.status === "completed" ? "is-complete" : ""}>{task.status || "unknown"}</span>
                <small>{displayTime(task.completed_at || task.started_at)}</small>
              </div>
              {task.error ? <p className="task-error">{task.error}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="production-note">{message}</p>
      <p className="production-note">这里只读取现有 `/api/v1/projects/{project_id}/tasks`；不新增任务调度、取消、重试或队列管理语义。</p>
    </div>
  );
}
