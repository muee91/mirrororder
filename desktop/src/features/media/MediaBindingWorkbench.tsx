import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, useRef } from "react";
import { DesktopClient, type MediaBindingSummary, type MediaRelinkPreviewPayload } from "../../api/desktop";
import { HostConnectionError, errorMessage } from "../../api/host";
import { PlatformClient } from "../../api/platform";
import { ProjectTaskClient, canCancelTask, type ProjectTaskRecord } from "../../api/tasks";

interface Props {
  baseUrl: string;
  projectId: string;
  entry?: "slate";
}

type ScanIntent = "reconnect" | "add" | "manual";
const RESULT_LIMIT = 300;

function splitRoots(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

function activeMediaScan(task: ProjectTaskRecord): boolean {
  return task.type === "media_inventory_scan" && (task.status === "queued" || task.status === "running");
}

function taskTime(task: ProjectTaskRecord): number {
  for (const value of [task.created_at, task.started_at, task.completed_at]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function newestActiveScan(tasks: ProjectTaskRecord[]): ProjectTaskRecord | null {
  return tasks.filter(activeMediaScan).sort((left, right) => taskTime(right) - taskTime(left))[0] ?? null;
}

function newestMediaScan(tasks: ProjectTaskRecord[]): ProjectTaskRecord | null {
  return tasks
    .filter((task) => task.type === "media_inventory_scan")
    .sort((left, right) => taskTime(right) - taskTime(left))[0] ?? null;
}

function scanStage(task: ProjectTaskRecord): string {
  if (task.cancel_requested) return "正在取消";
  const labels: Record<string, string> = {
    queued: "等待开始",
    starting: "正在启动",
    waiting_cpu: "等待扫描资源",
    media_inventory: "正在扫描本机素材",
    completed: "扫描完成",
    cancelled: "已取消",
    interrupted: "被中断",
    failed: "扫描失败",
  };
  return labels[task.stage || task.status] ?? (task.status === "queued" ? "等待开始" : "正在扫描本机素材");
}

function taskProgress(task: ProjectTaskRecord): { done: number; total: number } | null {
  const done = task.progress?.done;
  const total = task.progress?.total;
  return typeof done === "number" && typeof total === "number" && total > 0 ? { done, total } : null;
}

function isInventorySnapshotPublishFailure(task: Pick<ProjectTaskRecord, "error" | "message">): boolean {
  const text = `${task.error || ""} ${task.message || ""}`;
  return text.includes("快照发布失败") || text.includes("inventory 快照发布失败");
}

function scanFailureMessage(task: Pick<ProjectTaskRecord, "error" | "message" | "status">): string {
  if (task.status === "interrupted") {
    return "素材扫描因 Host 重启而中断；可以重新扫描已登记目录。";
  }
  if (task.status === "cancelled") {
    return "素材扫描已取消；可以重新扫描已登记目录。";
  }
  if (isInventorySnapshotPublishFailure(task)) {
    return "素材扫描失败：绑定已提交，但索引快照发布失败；连接结果暂不可用，请重新扫描。";
  }
  return `素材扫描失败：${task.error || task.message || "未知错误"}；请重新扫描或检查素材位置。`;
}

export function MediaBindingWorkbench({ baseUrl, projectId, entry }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const tasks = useMemo(() => new ProjectTaskClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [summary, setSummary] = useState<MediaBindingSummary | null>(null);
  const [rootsText, setRootsText] = useState("");
  const [scanTask, setScanTask] = useState<ProjectTaskRecord | null>(null);
  const [scanError, setScanError] = useState<ProjectTaskRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [relinkPreview, setRelinkPreview] = useState<MediaRelinkPreviewPayload | null>(null);
  const submission = useRef(false);
  const [message, setMessage] = useState("正在读取本机素材连接…");

  function describeSummary(next: MediaBindingSummary): string {
    if (next.pending_analysis) {
      return next.unavailable_roots?.length
        ? `${next.unavailable_roots.length} 个原始目录无法读取，请检查硬盘或更新位置。`
        : next.roots.length ? "原始目录可访问，可以开始同步。" : "请选择视频和同期录音所在的目录。";
    }
    if (entry==="slate"&&next.total>0&&next.resolved===0&&next.roots.length) {
      return "素材还未关联。可以直接扫描已经保存的目录；若读不到，再选择新的位置。";
    }
    if (next.missing > 0) {
      return `已连接 ${next.resolved}/${next.total} 个媒体身份；${next.missing} 个素材需要重新连接。`;
    }
    if (next.total > 0) {
      return `${next.resolved}/${next.total} 个媒体身份已在当前设备连接。`;
    }
    return "当前还没有可恢复的媒体身份。先设置本机素材位置，或等待项目完成首次分析。";
  }

  async function reload(): Promise<void> {
    try {
      const [payload, taskRows] = await Promise.all([
        client.mediaBinding(projectId),
        tasks.list(projectId).catch(() => [] as ProjectTaskRecord[]),
      ]);
      setSummary(payload.summary);
      setRootsText(payload.summary.roots.join("\n"));
      const active = newestActiveScan(taskRows);
      const latest = newestMediaScan(taskRows);
      const latestFailure = latest && (
        latest.status === "failed"
        || latest.status === "interrupted"
        || latest.status === "cancelled"
        || Boolean(latest.error)
      ) ? latest : null;
      setScanTask(active);
      setScanError(latestFailure);
      setMessage(active
        ? `${scanStage(active)}；完成后连接结果会自动刷新。`
        : latestFailure
          ? scanFailureMessage(latestFailure)
          : describeSummary(payload.summary));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload();
    // client/tasks are stable for baseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tasks, projectId]);

  useEffect(() => {
    const taskId = scanTask?.task_id;
    if (!taskId || !scanTask || !activeMediaScan(scanTask)) return;
    let disposed = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    async function poll(): Promise<void> {
      try {
        const rows = await tasks.list(projectId);
        if (disposed) return;
        const current = rows.find((task) => task.task_id === taskId) ?? newestActiveScan(rows);
        if (!current) {
          setScanTask(null);
          await reload();
          return;
        }
        setScanTask(current);
        if (activeMediaScan(current)) {
          setMessage(`${scanStage(current)}；完成后连接结果会自动刷新。`);
          timer = globalThis.setTimeout(() => { void poll(); }, 1000);
          return;
        }
        await reload();
        if (disposed) return;
        if (current.status === "completed") {
          setMessage("素材扫描完成；连接结果已自动刷新。");
        } else if (current.status === "cancelled") {
          setMessage("素材扫描已取消；原有本机素材连接保持不变。");
        } else if (current.status === "failed" || current.error) {
          setScanError(current);
          setMessage(scanFailureMessage(current));
        }
      } catch (error) {
        if (disposed) return;
        setMessage(`读取素材扫描状态失败：${errorMessage(error)}；将继续重试。`);
        timer = globalThis.setTimeout(() => { void poll(); }, 2000);
      }
    }

    timer = globalThis.setTimeout(() => { void poll(); }, 800);
    return () => {
      disposed = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
    // reload is intentionally reached through the current project/task clients.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, scanTask?.task_id, tasks]);

  async function chooseDirectories(title: string): Promise<string[]> {
    if (!isTauri()) {
      setMessage("浏览器预览无法打开系统目录选择器；可在“高级”中手动填写目录。");
      return [];
    }
    try {
      const selected = await openDialog({ directory: true, multiple: true, title });
      return Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
      return [];
    }
  }

  async function discoverActiveScan(): Promise<ProjectTaskRecord | null> {
    try {
      const active = newestActiveScan(await tasks.list(projectId));
      setScanTask(active);
      return active;
    } catch {
      return null;
    }
  }

  async function submitScan(roots: string[], replace: boolean, intent: ScanIntent): Promise<void> {
    const normalized = [...new Set(roots.map((value) => value.trim()).filter(Boolean))];
    if (!normalized.length) {
      setMessage("至少需要一个本机素材目录。");
      return;
    }
    if (!summary || submission.current) return;
    submission.current = true;
    if (summary.pending_analysis) {
      setBusy(true);
      try {
        const result = await client.saveSourceRoots(projectId, normalized, replace);
        setSummary(result.summary);
        setRootsText(result.summary.roots.join("\n"));
        setMessage(describeSummary(result.summary));
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        submission.current = false;
        setBusy(false);
      }
      return;
    }
    if (scanTask && activeMediaScan(scanTask)) {
      submission.current = false;
      setMessage("当前已有素材扫描正在进行。先等待完成或取消当前扫描，再提交新的素材位置。");
      return;
    }
    setBusy(true);
    setScanError(null);
    setRootsText(normalized.join("\n"));
    setMessage(intent === "reconnect"
      ? "正在提交素材重新连接任务…"
      : intent === "add"
        ? "正在添加搜索位置并扫描…"
        : "正在按当前搜索位置扫描…");
    try {
      const payload = await client.scanMediaBinding(projectId, normalized, replace);
      if (payload.task.type && payload.task.type !== "media_inventory_scan") {
        setMessage(`素材扫描提交返回了未知任务类型：${payload.task.type}`);
        return;
      }
      const taskId = String(payload.task.task_id || "");
      const listed = await tasks.list(projectId).catch(() => [] as ProjectTaskRecord[]);
      const submitted = listed.find((task) => task.task_id === taskId)
        ?? newestActiveScan(listed)
        ?? (taskId ? {
          task_id: taskId,
          project_id: projectId,
          type: "media_inventory_scan",
          status: String(payload.task.status || "queued"),
          stage: String(payload.task.stage || payload.task.status || "queued"),
        } : null);
      setScanTask(submitted);
      if (intent === "reconnect") {
        setMessage("正在重新连接已移动素材；新位置扫描成功后会替换旧位置。取消通常保留原有连接；若索引快照发布失败，绑定已提交，需要重新扫描恢复连接结果。");
      } else if (intent === "add") {
        setMessage("正在扫描新增搜索位置；原有搜索位置和连接会继续保留。");
      } else {
        setMessage("正在扫描当前搜索位置；完成后连接结果会自动刷新。");
      }
      if (submitted && !activeMediaScan(submitted)) await reload();
    } catch (error) {
      if (error instanceof HostConnectionError && error.status === 409) {
        const active = await discoverActiveScan();
        setMessage(active
          ? "当前已有素材扫描正在进行；已接管显示该任务，可在这里直接取消。"
          : error.message);
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      submission.current = false;
      setBusy(false);
    }
  }

  async function cancelScan(): Promise<void> {
    if (!scanTask || !canCancelTask(scanTask) || busy) return;
    setBusy(true);
    setMessage("正在请求取消素材扫描…");
    try {
      const next = await tasks.cancel(projectId, scanTask.task_id);
      setScanTask(next);
      setMessage(next.status === "cancelled"
        ? "素材扫描已取消；原有本机素材连接保持不变。"
        : "已请求取消素材扫描；扫描器会在安全中断点停止，成功取消时通常保留原有连接。若扫描已提交绑定但索引快照发布失败，请重新扫描。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reconnectMovedMedia(): Promise<void> {
    const values = await chooseDirectories(summary?.missing ? "选择素材移动后的新位置" : "设置本机素材位置");
    if (!values.length) return;
    const explanation = summary?.pending_analysis
      ? "替换这台设备用于同步的原始素材目录？"
      : summary?.roots.length
      ? `将当前设备的素材搜索位置替换为所选 ${values.length} 个目录并立即扫描。\n\n旧位置和绑定通常会保留到新扫描成功后才替换。取消通常不会破坏当前连接；如果出现“索引快照发布失败”，绑定已提交但连接结果需要重新扫描恢复，应用不会自动回滚设备绑定。\n\n这不会新建或更改项目中的媒体身份，也不会修改共享项目；已校验素材会按内容身份重新连接。旧项目只有文件名线索的素材仍会要求你逐项确认。`
      : `将所选 ${values.length} 个目录设为当前设备的素材搜索位置并立即扫描。\n\n如果出现“索引快照发布失败”，绑定已提交但连接结果需要重新扫描恢复，应用不会自动回滚设备绑定。\n\n这不会新建或更改项目中的媒体身份，也不会修改共享项目。`;
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(explanation)) return;
    await submitScan(values, true, "reconnect");
  }

  async function addSearchLocations(): Promise<void> {
    const values = await chooseDirectories("添加素材搜索位置");
    if (!values.length) return;
    const merged = [...new Set([...splitRoots(rootsText), ...values])];
    await submitScan(merged, false, "add");
  }

  async function scanManualRoots(): Promise<void> {
    await submitScan(splitRoots(rootsText), false, "manual");
  }

  async function previewBatchRelink(explicitRoot?: string): Promise<void> {
    if (previewing || busy) return;
    let targetRoot = (explicitRoot || "").trim();
    if (!targetRoot) {
      if (isTauri()) {
        const picked = await chooseDirectories("选择新硬盘或文件夹以预览重连命中率");
        targetRoot = picked[0] ?? "";
      } else {
        targetRoot = splitRoots(rootsText)[0] ?? "";
      }
    }
    if (!targetRoot) {
      setMessage("请先选择一个本机目录，或在下方“高级”列表填写至少一个目录路径后再预览重连命中率。");
      return;
    }
    setPreviewing(true);
    setMessage(`正在只读预检目录命中率：${targetRoot}…`);
    try {
      const preview = await client.previewDirectoryRelink(projectId, targetRoot);
      setRelinkPreview(preview);
      setMessage(
        `预检完成（只读，未修改绑定）：指纹精确命中 ${preview.summary.exact_count}/${preview.summary.total_media}` +
        (preview.summary.filename_only_count ? `，仅文件名候选 ${preview.summary.filename_only_count}（需确认）` : "") +
        (preview.summary.missing_count ? `，仍缺失 ${preview.summary.missing_count}` : "") +
        "。",
      );
    } catch (error) {
      setRelinkPreview(null);
      setMessage(errorMessage(error));
    } finally {
      setPreviewing(false);
    }
  }

  async function confirm(mediaId: string, candidatePath: string): Promise<void> {
    setBusy(true);
    setMessage("正在确认旧项目素材候选…");
    try {
      const payload = await client.confirmProvisionalMediaBinding(projectId, mediaId, candidatePath);
      setSummary(payload.summary);
      setMessage(`已确认 ${candidatePath}；该确认只保存在当前设备。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string): Promise<void> {
    if (!isTauri()) return;
    try {
      await platform.reveal(path);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const items = useMemo(
    () => [...(summary?.items ?? [])].sort((left, right) => Number(left.local_exists) - Number(right.local_exists) || left.name.localeCompare(right.name)),
    [summary],
  );
  const visibleItems = items.slice(0, RESULT_LIMIT);
  const roots = splitRoots(rootsText);
  const total = summary?.total ?? 0;
  const resolved = summary?.resolved ?? 0;
  const missing = summary?.missing ?? 0;
  const pendingAnalysis = Boolean(summary?.pending_analysis);
  const scanActive = Boolean(scanTask && activeMediaScan(scanTask));
  const scanProgress = scanTask ? taskProgress(scanTask) : null;
  const recoveryState = pendingAnalysis ? "is-pending" : missing > 0 ? "is-missing" : total > 0 ? "is-ready" : "is-empty";

  if (!summary) {
    return <section className="phase3-workbench media-binding-workbench" aria-label="本机素材">
      <header className="production-heading"><h2>本机素材</h2></header>
      <p role={message.startsWith("正在读取") ? "status" : "alert"}>{message}</p>
      <button type="button" className="secondary" onClick={() => void reload()}>重新读取</button>
    </section>;
  }

  return (
    <section className="phase3-workbench media-binding-workbench">
      <header className="production-heading media-binding-heading">
        <div>
          <p className="eyebrow">当前设备</p>
          <h2>本机素材</h2>
          <span>项目记住媒体身份；这里仅告诉当前设备 去哪里找到对应文件。</span>
        </div>
        <div className="media-binding-heading-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button>
        </div>
      </header>

      <div className="media-binding-status" aria-live="polite">{message}</div>

      {scanTask && scanActive ? (
        <section className="media-binding-scan-state" aria-label="当前素材扫描">
          <div>
            <p className="eyebrow">当前扫描</p>
            <strong>{scanStage(scanTask)}</strong>
            <span>{scanTask.cancel_requested ? "正在等待安全中断点；旧绑定不会提前清除。" : "扫描完成后本页会自动刷新，不需要重复提交或手动刷新结果。"}</span>
            {scanProgress ? <progress value={scanProgress.done} max={scanProgress.total} /> : null}
          </div>
          <button type="button" className="secondary" disabled={busy || !canCancelTask(scanTask) || Boolean(scanTask.cancel_requested)} onClick={() => void cancelScan()}>{scanTask.cancel_requested ? "正在取消" : "取消扫描"}</button>
        </section>
      ) : null}

      {scanError ? (
        <section className="media-binding-scan-error" role="alert" aria-label="素材扫描错误">
          <strong>最近一次素材扫描未完成</strong>
          <span>{scanFailureMessage(scanError)}</span>
          <span>当前页面仍可继续查看和处理已有媒体身份；修复素材位置后可重新扫描。</span>
        </section>
      ) : null}

      <div className="media-binding-content">
        <section className="media-binding-section media-binding-setup">
          <div className={`media-binding-recovery-state ${recoveryState}`}>
            <div className="media-binding-recovery-copy">
              <p className="eyebrow">{missing > 0 ? "需要重新连接" : pendingAnalysis ? "原始素材" : total > 0 ? "连接正常" : "设置素材位置"}</p>
              <strong>{missing > 0
                ? `${missing} 个素材在当前设备未找到`
                : pendingAnalysis
                  ? "同步前检查原始素材目录"
                  : total > 0
                    ? `${resolved}/${total} 个媒体身份已连接`
                    : "选择当前设备上的素材目录"}</strong>
              <span>{missing > 0
                ? "如果素材只是换盘、移动文件夹或更换硬盘，不需要重新导入项目。选择素材的新位置后，镜序会用已有媒体身份重新连接。"
                : pendingAnalysis
                  ? "目录登记仅保存在这台设备。同步任务会检查视频和录音并建立媒体身份。"
                  : total > 0
                    ? "当前连接只保存在这台设备。移动素材后使用“重新连接已移动素材”，不会改动共享项目。"
                    : "设置位置只建立当前设备的搜索范围，不会把本机绝对路径写进共享项目。"}</span>
            </div>
            <div className="media-binding-recovery-actions">
              {entry==="slate"&&roots.length>0&&<button type="button" disabled={busy||scanActive||pendingAnalysis}
                onClick={()=>void submitScan(roots,false,"manual")}>扫描已保存的目录</button>}
              <button type="button" disabled={!summary || busy || scanActive || !isTauri()} onClick={() => void reconnectMovedMedia()}>{pendingAnalysis ? "替换原始目录…" : roots.length || total ? "重新连接已移动素材…" : "设置素材位置…"}</button>
              {!pendingAnalysis && total > 0 ? <button type="button" className="secondary" disabled={!summary || busy || scanActive || previewing} onClick={() => void previewBatchRelink()}>{previewing ? "正在预检…" : "智能目录重连预览"}</button> : null}
              {roots.length || total ? <button type="button" className="secondary" disabled={!summary || busy || scanActive || !isTauri()} onClick={() => void addSearchLocations()}>{pendingAnalysis ? "添加原始目录…" : "添加搜索位置…"}</button> : null}
            </div>
          </div>

          {relinkPreview ? (
            <section className="media-binding-relink-preview" aria-label="目录重连预检结果">
              <div className="media-binding-relink-preview-head">
                <div>
                  <p className="eyebrow">只读重连预检 · 未修改设备绑定</p>
                  <strong>{relinkPreview.scan_root}</strong>
                  <span>
                    扫描 {relinkPreview.files_scanned} 个文件{relinkPreview.truncated ? "（已达上限截断）" : ""}
                    {relinkPreview.symlinks_skipped ? ` · 已拦截越界符号链接 ${relinkPreview.symlinks_skipped}` : ""}
                  </span>
                </div>
                <div className="media-binding-relink-preview-actions">
                  <button
                    type="button"
                    disabled={busy || scanActive || relinkPreview.summary.exact_count + relinkPreview.summary.filename_only_count === 0}
                    onClick={() => void submitScan([relinkPreview.scan_root], true, "reconnect")}
                  >
                    用此目录执行正式重连
                  </button>
                  <button type="button" className="secondary" onClick={() => setRelinkPreview(null)}>收起预检</button>
                </div>
              </div>
              <div className="media-binding-relink-metrics">
                <span className="is-exact"><strong>{relinkPreview.summary.exact_count}</strong> 指纹精确命中</span>
                <span className="is-candidate"><strong>{relinkPreview.summary.filename_only_count}</strong> 仅文件名候选（需确认）</span>
                <span className="is-missing"><strong>{relinkPreview.summary.missing_count}</strong> 仍缺失</span>
              </div>
              {relinkPreview.matched_filename_only.length > 0 ? (
                <p className="media-binding-relink-note">
                  仅文件名候选（如 {relinkPreview.matched_filename_only.slice(0, 3).map((item) => item.name).join("、")}）不会静默覆盖正式指纹，正式扫描后仍需逐项人工确认。
                </p>
              ) : null}
            </section>
          ) : null}

          <header className="media-binding-section-heading media-binding-location-heading">
            <div><strong>当前搜索位置</strong><span>{roots.length ? `${roots.length} 个目录 · 仅当前设备` : "尚未设置"}</span></div>
            <div className="media-binding-summary" aria-label="本机素材连接统计">
              <span><strong>{resolved}</strong> 已连接</span>
              <span><strong>{missing}</strong> 未找到</span>
              <span><strong>{total}</strong> 媒体身份</span>
            </div>
          </header>

          <div className="media-binding-current-roots">
            {roots.length ? roots.map((root) => <code key={root}>{root}{summary?.unavailable_roots?.includes(root) ? " · 不可读取" : ""}</code>) : <span>还没有本机搜索位置。</span>}
          </div>

          {!!summary?.ambiguous_content_count&&<details className="media-binding-advanced" aria-label="重复原片集中复核">
            <summary>{summary.ambiguous_content_count} 个素材有多份文件，未自动关联</summary>
            <p>选择只包含正确原片的位置后重扫。镜序不会从几份候选里随便取一份。</p>
            <ul>{summary.items.filter(item=>item.identity_conflict).slice(0,30).map(item=><li key={item.media_id}>{item.name}</li>)}</ul>
          </details>}
          <details className="media-binding-advanced">
            <summary>高级：手动编辑搜索位置</summary>
            <p>每行一个目录。“按当前列表扫描”只会添加/扫描这些位置，不会删除已经登记的旧位置；如果是整盘移动或希望替换旧搜索位置，请使用上面的“重新连接已移动素材”。</p>
            <label className="production-field media-binding-roots-field">
              <span>本机素材目录 · 每行一个</span>
              <textarea
                className="media-roots-input"
                rows={4}
                value={rootsText}
                onChange={(event) => setRootsText(event.target.value)}
                spellCheck={false}
                placeholder="/Volumes/PROJECT/Media"
              />
            </label>
            {pendingAnalysis && <button type="button" className="secondary"
              disabled={busy || !splitRoots(rootsText).length}
              onClick={() => void submitScan(splitRoots(rootsText), true, "manual")}>用此列表替换原始目录</button>}
            <button type="button" className="secondary" disabled={!summary || busy || scanActive || !splitRoots(rootsText).length} onClick={() => void scanManualRoots()}>{pendingAnalysis ? "添加列表中的目录" : "按当前列表扫描"}</button>
          </details>

          <details className="media-binding-help">
            <summary>重连规则</summary>
            <p>正式媒体身份会通过内容校验自动恢复，因此换盘或移动目录不会产生一份新的项目素材。重新连接采用“扫描成功再替换”策略，取消通常不会先清空旧绑定；如果索引快照发布失败，绑定已提交但连接结果需要重新扫描恢复，应用不会自动回滚设备绑定。旧项目只有文件名线索时只会生成候选，不会静默绑定；需要逐项确认。所有本机路径和确认只保存在当前设备，不修改共享项目或人工审核结果。</p>
            {summary?.state_path ? (
              <button type="button" className="secondary media-state-path" disabled={!isTauri()} onClick={() => void reveal(summary.state_path)}>定位设备绑定文件</button>
            ) : null}
          </details>
        </section>

        <section className="media-binding-section media-binding-results">
          <header className="media-binding-section-heading">
            <div><strong>连接结果</strong><span>{summary?.device_name || "当前设备"}</span></div>
            <span className="media-binding-result-state">{pendingAnalysis ? "等待首次分析建立媒体身份" : `${resolved}/${total} 已连接${items.length > RESULT_LIMIT ? ` · 显示前 ${RESULT_LIMIT}/${items.length}` : ""}`}</span>
          </header>

          <div className="media-binding-list">
            {visibleItems.length ? visibleItems.map((item) => (
              <article className={`media-binding-row ${item.local_exists ? "is-resolved" : "is-missing"}`} key={item.media_id}>
                <div>
                  <strong>{item.name || item.media_id}</strong>
                  <span>{item.verified ? "内容身份已校验" : "旧项目临时身份"} · {item.clip_ids.length} clips</span>
                </div>
                <em>{item.local_exists ? "已连接" : item.needs_confirmation ? "需确认" : "未找到"}</em>
                <code>{item.resolved_path || item.candidate_path || item.source_media_path || item.media_id}</code>
                {item.local_exists && item.resolved_path ? (
                  <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void reveal(item.resolved_path)}>在 Finder 中显示</button>
                ) : null}
                {item.needs_confirmation && item.candidate_path ? (
                  <div className="production-actions">
                    <button type="button" className="secondary" disabled={busy || !isTauri()} onClick={() => void reveal(item.candidate_path!)}>查看候选</button>
                    <button type="button" disabled={busy} onClick={() => void confirm(item.media_id, item.candidate_path!)}>确认这是该素材</button>
                  </div>
                ) : null}
              </article>
            )) : (
              <div className="media-binding-empty">
                <strong>{pendingAnalysis ? "等待首次整理" : "还没有媒体身份"}</strong>
                <span>{pendingAnalysis ? "先在时间线完成多机位同步；同步完成后，这里会列出可重新连接的媒体身份。" : "选择“设置素材位置”或“添加搜索位置”，连接结果会显示在这里。"}</span>
              </div>
            )}
            {items.length > RESULT_LIMIT ? <p className="media-binding-result-limit">当前显示前 {RESULT_LIMIT} 个媒体身份，共 {items.length} 个。统计数字仍按全部素材计算。</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
