import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { HostConnectionError } from "../../api/host";
import {
  isTaskActive,
  latestTaskAttempts,
  latestTaskFamilies,
} from "../../api/taskSemantics";
import type { ProductionPage } from "../../app/resumeState";
import {
  DeviceTaskClient,
  ProjectTaskClient,
  canCancelTask,
  canRetryTask,
  type ProjectTaskRecord,
} from "../../api/tasks";
import "./status-center.css";

export { latestTaskAttempts };

interface Props {
  baseUrl: string;
  projects: ProjectSummary[];
  onOpenProject: (projectId: string) => void;
  onOpenProjectPage?: (projectId: string, page: ProductionPage) => void;
  onOpenSettings?: () => void;
}

interface ProjectTasks {
  project: ProjectSummary;
  tasks: ProjectTaskRecord[];
  error: string;
}

interface ReloadSnapshot {
  rows: ProjectTasks[];
  deviceTasks: ProjectTaskRecord[];
}

interface TaskContext {
  task: ProjectTaskRecord;
  project: ProjectSummary | null;
}

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 8000;

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function active(task: ProjectTaskRecord): boolean {
  return isTaskActive(task);
}

export function taskNeedsAttention(task: ProjectTaskRecord): boolean {
  if (task.status === "cancelled" || task.status === "completed") return false;
  return task.status === "failed" || task.status === "interrupted" || Boolean(task.error);
}

function completed(task: ProjectTaskRecord): boolean {
  return task.status === "completed";
}

function completedOrCancelled(task: ProjectTaskRecord): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

function firstTimestamp(values: Array<string | null | undefined>): number {
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function activityTimestamp(task: ProjectTaskRecord): number {
  return firstTimestamp([task.completed_at, task.started_at, task.created_at]);
}

export function statusPollDelay(hasActiveTasks: boolean): number {
  return hasActiveTasks ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}

function progress(task: ProjectTaskRecord): { done: number; total: number } | null {
  const value = task.progress ?? {};
  const done = value.done ?? value.audit_done ?? value.perception_done ?? value.face_done ?? value.speaker_done;
  const total = value.total ?? value.audit_total ?? value.perception_total ?? value.face_total ?? value.speaker_total;
  if (typeof done !== "number" || typeof total !== "number" || !Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

function taskLabel(task: ProjectTaskRecord): string {
  if (task.type === "identity_runtime_prepare") {
    const kind = typeof task.targets?.kind === "string" ? task.targets.kind : "";
    if (kind === "face") return "人脸识别运行时准备";
    if (kind === "speaker") return "声纹识别运行时准备";
    return "身份识别运行时准备";
  }
  const labels: Record<string, string> = {
    local_vision_prepare: "本地视觉模型准备",
    prepare_project: "准备项目",
    media_inventory_scan: "素材扫描",
    waveform_build: "波形生成",
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
    vision_prepare: "准备视觉模型",
    identity_prepare: "准备身份运行时",
    media_inventory: "素材扫描",
    waveform: "波形生成",
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
    waiting_embedding: "等待语义索引资源",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return labels[stage] || stage;
}

function statusLabel(task: ProjectTaskRecord): string {
  if (task.cancel_requested && active(task)) return "正在取消";
  return {
    queued: "排队中",
    running: "进行中",
    completed: "已完成",
    failed: "需要处理",
    cancelled: "已取消",
    interrupted: "已中断",
  }[task.status] ?? task.status;
}

function sortTasks(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const rank = (task: ProjectTaskRecord) => active(task) ? 0 : taskNeedsAttention(task) ? 1 : completedOrCancelled(task) ? 2 : 3;
  return [...tasks].sort((left, right) => rank(left) - rank(right) || activityTimestamp(right) - activityTimestamp(left));
}

function currentTasks(snapshot: ReloadSnapshot): ProjectTaskRecord[] {
  return [
    ...latestTaskFamilies(snapshot.deviceTasks),
    ...snapshot.rows.flatMap((row) => latestTaskFamilies(row.tasks)),
  ];
}

function hasActive(snapshot: ReloadSnapshot): boolean {
  return currentTasks(snapshot).some(active);
}

function summaryMessage(snapshot: ReloadSnapshot, deviceError = ""): string {
  const tasks = currentTasks(snapshot);
  const activeCount = tasks.filter(active).length;
  const attentionCount = tasks.filter(taskNeedsAttention).length
    + snapshot.rows.filter((row) => row.error).length
    + (deviceError ? 1 : 0);
  if (attentionCount) return `${attentionCount} 个当前事项需要处理${activeCount ? ` · ${activeCount} 个任务进行中` : ""}`;
  if (activeCount) return `${activeCount} 个任务正在处理`;
  return "后台工作当前正常。";
}

function relativeTime(task: ProjectTaskRecord): string {
  const timestamp = activityTimestamp(task);
  if (!timestamp) return "时间未知";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function duration(task: ProjectTaskRecord): string {
  if (!task.started_at) return "";
  const start = Date.parse(task.started_at);
  const end = task.completed_at ? Date.parse(task.completed_at) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `运行 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `运行 ${minutes}:${String(remaining).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `运行 ${hours} 小时 ${minutes % 60} 分钟`;
}

function taskTarget(task: ProjectTaskRecord): { label: string; page?: ProductionPage; settings?: boolean } {
  if (task.scope === "device" || task.type === "local_vision_prepare" || task.type === "identity_runtime_prepare") {
    return { label: "本机智能设置", settings: true };
  }
  if (task.type === "media_inventory_scan") return { label: "本机素材", page: "media-binding" };
  if (["identity_index", "face", "speaker"].includes(task.type)) return { label: "人物", page: "identity" };
  if (["auto_resolve", "semantic_index", "incremental_analyze", "transcribe", "transcription", "evidence_extract", "perception", "analysis", "audit"].includes(task.type)) {
    return { label: "素材 / 剧本", page: "takes" };
  }
  return { label: "打开项目" };
}

function taskPrimaryMessage(task: ProjectTaskRecord, historical = false): string {
  if (historical && taskNeedsAttention(task)) return "该失败已被后续尝试取代；这里只保留用于追溯。";
  if (taskNeedsAttention(task)) return task.message || "任务没有完成。可重新尝试，或打开相关位置检查输入与本机能力。";
  if (task.status === "cancelled") return task.message || "任务已按请求停止。";
  if (completed(task)) return task.message || "任务已完成。";
  return task.message || "后台处理中。";
}

function contextId(context: TaskContext): string {
  return `${context.project?.project_id || "device"}:${context.task.task_id}`;
}

export function StatusCenterWorkbench({ baseUrl, projects, onOpenProject, onOpenProjectPage, onOpenSettings }: Props) {
  const projectClient = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const deviceClient = useMemo(() => new DeviceTaskClient(baseUrl), [baseUrl]);
  const [rows, setRows] = useState<ProjectTasks[]>([]);
  const [deviceTasks, setDeviceTasks] = useState<ProjectTaskRecord[]>([]);
  const [deviceError, setDeviceError] = useState("");
  const [message, setMessage] = useState("正在读取所有后台工作…");
  const [busy, setBusy] = useState(false);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const reload = useCallback(async (quiet = false): Promise<ReloadSnapshot> => {
    if (!quiet) setBusy(true);
    try {
      const [nextRows, nextDevice] = await Promise.all([
        Promise.all(projects.map(async (project): Promise<ProjectTasks> => {
          try {
            const attempts = latestTaskAttempts(await projectClient.list(project.project_id));
            return { project, tasks: sortTasks(attempts), error: "" };
          } catch (error) {
            return { project, tasks: [], error: errorMessage(error) };
          }
        })),
        deviceClient.list()
          .then((tasks) => ({ tasks: sortTasks(latestTaskAttempts(tasks)), error: "" }))
          .catch((error) => ({ tasks: [] as ProjectTaskRecord[], error: errorMessage(error) })),
      ]);
      const snapshot = { rows: nextRows, deviceTasks: nextDevice.tasks };
      setRows(nextRows);
      setDeviceTasks(nextDevice.tasks);
      setDeviceError(nextDevice.error);
      setMessage(summaryMessage(snapshot, nextDevice.error));
      return snapshot;
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [deviceClient, projectClient, projects]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    async function monitor(initial = false): Promise<void> {
      const next = await reload(!initial);
      if (cancelled) return;
      timer = globalThis.setTimeout(() => { void monitor(); }, statusPollDelay(hasActive(next)));
    }

    void monitor(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [reload]);

  const allContexts = useMemo<TaskContext[]>(() => [
    ...deviceTasks.map((task) => ({ task, project: null })),
    ...rows.flatMap((row) => row.tasks.map((task) => ({ task, project: row.project }))),
  ], [deviceTasks, rows]);

  const currentContexts = useMemo<TaskContext[]>(() => [
    ...latestTaskFamilies(deviceTasks).map((task) => ({ task, project: null })),
    ...rows.flatMap((row) => latestTaskFamilies(row.tasks).map((task) => ({ task, project: row.project }))),
  ], [deviceTasks, rows]);

  const currentIds = useMemo(() => new Set(currentContexts.map(contextId)), [currentContexts]);
  const activeTasks = useMemo(() => currentContexts.filter(({ task }) => active(task)).sort((left, right) => activityTimestamp(right.task) - activityTimestamp(left.task)), [currentContexts]);
  const attentionTasks = useMemo(() => currentContexts.filter(({ task }) => taskNeedsAttention(task)).sort((left, right) => activityTimestamp(right.task) - activityTimestamp(left.task)), [currentContexts]);
  const historyTasks = useMemo(() => allContexts.filter((context) => {
    if (active(context.task)) return false;
    if (currentIds.has(contextId(context))) return completedOrCancelled(context.task);
    return true;
  }).sort((left, right) => activityTimestamp(right.task) - activityTimestamp(left.task)), [allContexts, currentIds]);
  const projectErrors = rows.filter((row) => row.error);

  const totals = useMemo(() => ({
    active: activeTasks.length,
    attention: attentionTasks.length + projectErrors.length + (deviceError ? 1 : 0),
    history: historyTasks.length,
  }), [activeTasks.length, attentionTasks.length, deviceError, historyTasks.length, projectErrors.length]);

  async function cancelProject(projectId: string, task: ProjectTaskRecord): Promise<void> {
    if (!canCancelTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage("正在请求安全取消后台任务…");
    try {
      await projectClient.cancel(projectId, task.task_id);
      await reload(true);
      setMessage("取消请求已提交；任务会在当前可中断阶段停止。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  async function retryProject(projectId: string, task: ProjectTaskRecord): Promise<void> {
    if (!canRetryTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(`正在重新排队 ${taskLabel(task)}…`);
    try {
      await projectClient.retry(projectId, task);
      await reload(true);
      setMessage(`${taskLabel(task)} 已重新排队。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  async function cancelDevice(task: ProjectTaskRecord): Promise<void> {
    if (!canCancelTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(`正在取消 ${taskLabel(task)}…`);
    try {
      await deviceClient.cancel(task.task_id);
      await reload(true);
      setMessage(`${taskLabel(task)} 已提交取消请求。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  async function retryDevice(task: ProjectTaskRecord): Promise<void> {
    if (!canRetryTask(task) || actionTaskId) return;
    setActionTaskId(task.task_id);
    setMessage(`正在重新排队 ${taskLabel(task)}…`);
    try {
      await deviceClient.retry(task);
      await reload(true);
      setMessage(`${taskLabel(task)} 已重新排队。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setActionTaskId(null);
    }
  }

  function openTarget(context: TaskContext): void {
    const target = taskTarget(context.task);
    if (target.settings) {
      onOpenSettings?.();
      return;
    }
    if (!context.project) return;
    if (target.page && onOpenProjectPage) {
      onOpenProjectPage(context.project.project_id, target.page);
      return;
    }
    onOpenProject(context.project.project_id);
  }

  function renderTask(context: TaskContext, historical = false) {
    const { task, project } = context;
    const taskProgress = progress(task);
    const stage = task.stage ? stageLabel(task.stage) : "";
    const target = taskTarget(task);
    const elapsed = duration(task);
    const source = project ? (project.name || project.project_id) : "本机运行时";
    const displayedStatus = historical && taskNeedsAttention(task)
      ? (task.status === "interrupted" ? "历史中断" : "历史失败")
      : statusLabel(task);
    return (
      <article className={`status-center-task status-${task.status}${historical ? " is-history" : ""}`} key={`${project?.project_id || "device"}:${task.task_id}`}>
        <div className="status-center-task-main">
          <span className="status-center-task-indicator" aria-hidden="true" />
          <div className="status-center-task-name">
            <strong>{taskLabel(task)}</strong>
            <span>{source} · {displayedStatus}{stage && stage !== displayedStatus ? ` · ${stage}` : ""}</span>
          </div>
        </div>
        <div className="status-center-task-body">
          <p>{taskPrimaryMessage(task, historical)}</p>
          <div className="status-center-task-meta"><span>{relativeTime(task)}</span>{elapsed ? <span>{elapsed}</span> : null}</div>
          {taskProgress ? <div className="status-center-progress"><progress value={taskProgress.done} max={taskProgress.total} /><span>{taskProgress.done} / {taskProgress.total}</span></div> : null}
          {task.error ? <details className="status-center-technical"><summary>技术详情</summary><code>{task.error}</code></details> : null}
        </div>
        <div className="status-center-actions">
          {!historical && canCancelTask(task) ? <button type="button" className="secondary" disabled={Boolean(actionTaskId) || Boolean(task.cancel_requested)} onClick={() => project ? void cancelProject(project.project_id, task) : void cancelDevice(task)}>{task.cancel_requested ? "正在取消" : "取消"}</button> : null}
          {!historical && canRetryTask(task) ? <button type="button" disabled={Boolean(actionTaskId)} onClick={() => project ? void retryProject(project.project_id, task) : void retryDevice(task)}>{task.status === "cancelled" ? "重新开始" : "重试"}</button> : null}
          {(project || target.settings) ? <button type="button" className="secondary" onClick={() => openTarget(context)}>{target.label}</button> : null}
        </div>
      </article>
    );
  }

  const noCurrentWork = !deviceError && !projectErrors.length && !attentionTasks.length && !activeTasks.length;

  return (
    <section className="status-center-workbench">
      <header className="production-heading status-center-heading">
        <div><p className="eyebrow">后台工作</p><h2>状态中心</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload(false)}>刷新</button></div>
      </header>

      <div className="status-center-summary">
        <span><strong>{totals.active}</strong>正在处理</span>
        <span className={totals.attention ? "needs-attention" : ""}><strong>{totals.attention}</strong>需要处理</span>
        <button type="button" className={showHistory ? "is-active" : ""} aria-pressed={showHistory} onClick={() => setShowHistory((value) => !value)}><strong>{totals.history}</strong>{showHistory ? "隐藏历史记录" : "显示历史记录"}</button>
      </div>

      <p className="status-center-note">这里只把每类工作的最新状态算作当前事项。后续尝试已经取代的旧失败会进入历史，不再重复占据“需要处理”。</p>

      <div className="status-center-sections">
        {activeTasks.length ? (
          <section className="status-center-section is-active">
            <header><div><span className="status-center-section-dot" /><strong>正在处理</strong></div><small>{activeTasks.length}</small></header>
            <div className="status-center-task-list">{activeTasks.map((context) => renderTask(context))}</div>
          </section>
        ) : null}

        {deviceError || projectErrors.length || attentionTasks.length ? (
          <section className="status-center-section is-attention">
            <header><div><span className="status-center-section-dot" /><strong>当前需要处理</strong></div><small>{totals.attention}</small></header>
            {deviceError ? <article className="status-center-read-error"><div><strong>本机运行时状态读取失败</strong><span>{deviceError}</span></div>{onOpenSettings ? <button type="button" className="secondary" onClick={onOpenSettings}>本机智能设置</button> : null}</article> : null}
            {projectErrors.map((row) => <article className="status-center-read-error" key={`error:${row.project.project_id}`}><div><strong>{row.project.name || row.project.project_id}</strong><span>无法读取后台任务：{row.error}</span></div><button type="button" className="secondary" onClick={() => onOpenProject(row.project.project_id)}>打开项目</button></article>)}
            <div className="status-center-task-list">{attentionTasks.map((context) => renderTask(context))}</div>
          </section>
        ) : null}

        {showHistory ? (
          <section className="status-center-section is-recent">
            <header><div><span className="status-center-section-dot" /><strong>历史记录</strong></div><small>{historyTasks.length}</small></header>
            <p className="status-center-section-note">包含已完成、已取消，以及被后续尝试取代的旧失败。历史失败只用于追溯，不提供重试入口。</p>
            {historyTasks.length ? <div className="status-center-task-list">{historyTasks.map((context) => renderTask(context, true))}</div> : <div className="status-center-section-empty">当前没有历史任务记录。</div>}
          </section>
        ) : null}

        {noCurrentWork && !showHistory ? <div className="status-center-empty"><strong>后台工作正常</strong><span>当前没有运行中或需要处理的任务。可通过“显示历史记录”查看已经结束或被后续尝试取代的任务。</span></div> : null}
      </div>
    </section>
  );
}
