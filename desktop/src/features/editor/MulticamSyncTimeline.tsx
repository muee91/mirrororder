import { useEffect, useState } from "react";
import { DesktopClient, type MediaBindingSummary } from "../../api/desktop";
import type { MulticamSyncTimeline as SyncTimeline } from "../../api/syncTimeline";
import { SyncInspectionWorkbench } from "./SyncInspectionWorkbench";
import "./multicam-sync-timeline.css";

interface Props {
  syncTimeline: SyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  onInspect?: () => void;
  onCancel?: () => void;
  onRepair?: () => void;
  onOpenStatus?: () => void;
  command?: "start" | "cancel" | "";
  submissionError?: string;
}

const SYNC_STEPS = [
  ["确认原始目录", "确认摄影机原片和同期录音可读"],
  ["计算多机位同步", "建立各机位与同期录音的摆位"],
  ["建立媒体索引", "关联原片，供核对与重连使用"],
  ["核对与交付", "对照音画，再打开目标工程"],
] as const;

function stageLabel(phase: SyncTimeline["phase"], stage: string): string {
  if (phase === "loading") return "正在读取任务状态";
  if (phase === "unavailable") return "无法读取任务状态";
  if (phase === "failed") return "同步任务失败";
  if (phase === "cancelled") return "任务已取消";
  if (phase === "interrupted") return "任务被中断";
  if (phase === "invalid") return "上次同步结果不可用";
  if (phase === "required") return "准备开始同步";
  if (stage === "analysis") return "正在建立媒体身份索引";
  if (stage === "queued") return "任务已排队";
  if (stage === "starting") return "正在启动同步引擎";
  if (stage === "sync") return "正在计算多机位同步";
  return phase === "running" ? "同步任务正在执行" : "等待开始";
}

function activityLabel(value: string | undefined): string {
  if (!value) return "尚未记录";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN");
}

export function SyncTaskWorkspace({ syncTimeline, baseUrl, onMulticamSync, onInspect, onCancel, onRepair, onOpenStatus, command, submissionError }: Props) {
  const [sources, setSources] = useState<MediaBindingSummary | null>(null);
  const [sourcesUnreadable, setSourcesUnreadable] = useState(false);
  useEffect(() => {
    if (!baseUrl || !syncTimeline.project_id) return;
    let active = true;
    void new DesktopClient(baseUrl).mediaBinding(syncTimeline.project_id).then(({ summary }) => {
      if (active) { setSources(summary); setSourcesUnreadable(false); }
    }).catch(() => { if (active) setSourcesUnreadable(true); });
    return () => { active = false; };
  }, [baseUrl, syncTimeline.project_id, syncTimeline.phase]);
  const task = syncTimeline.task;
  const phase = syncTimeline.phase;
  const complete = syncTimeline.ready && phase === "completed";
  const running = phase === "running";
  const loading = phase === "loading";
  const unreadable = phase === "unavailable";
  const problem = ["failed", "cancelled", "interrupted", "invalid"].includes(phase);
  // The worker reports algorithm checkpoints, not the number of media files
  // processed. Do not turn these counts into an invented overall percentage.
  const rawDone = task?.progress?.done;
  const rawTotal = task?.progress?.total;
  const done = typeof rawDone === "number" && Number.isFinite(rawDone) && rawDone >= 0 ? rawDone : null;
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 5 ? rawTotal : null;
  const hasCheckpoints = running && task?.stage === "sync" && done !== null && total !== null && done <= total;
  const stepIndex = complete ? 3 : task?.stage === "analysis" ? 2 : task?.stage && task.stage !== "queued" ? 1 : 0;
  const sourceRoots = sourcesUnreadable ? "暂不可读" : sources ? `${sources.roots.length} 个` : "读取中";
  const inaccessible = !sourcesUnreadable ? sources?.unavailable_roots?.length ?? 0 : 0;
  const lastActivity = task?.updated_at || task?.completed_at;
  const latestMessage = unreadable ? "等待状态恢复" : task?.message || syncTimeline.message;
  const primaryLabel = complete ? "进入同步核对"
    : command === "start" ? "正在提交…"
      : running ? "同步正在运行" : loading ? "检查状态中" : unreadable ? "状态暂不可读"
        : problem || submissionError ? "重新执行同步" : "开始多机位同步";
  const phaseLabel = complete ? "同步任务完成"
    : submissionError && !running ? "同步提交失败" : stageLabel(phase, task?.stage ?? "");
  const footage = syncTimeline.ready ? `${syncTimeline.clip_count.toLocaleString()} 个片段` : "同步后统计";
  const cameras = syncTimeline.cameras.length ? syncTimeline.cameras.join(" / ") : "待识别";
  const recordings = syncTimeline.recordings ? `${syncTimeline.recordings.placements.length} 段已上轨` : "同步后统计";

  return (
    <section className="multicam-sync-gate" aria-label="多机位同步任务">
      <div className="sync-task-content">
        <header className="sync-task-heading">
          <div>
            <span className="sync-task-state" data-phase={submissionError && !running && !complete ? "failed" : phase} role="status">{phaseLabel}</span>
            <h1>{complete ? "同步母版已就绪" : "同步原始素材"}</h1>
            <p>{complete ? "核对机位与同期录音，确认后生成目标剪辑软件工程。" : "将摄影机原片和同期录音整理到同一条同步母版。"}</p>
          </div>
          <div className="sync-task-actions">
            <button type="button"
              disabled={complete ? !onInspect : Boolean(command) || running || loading || unreadable || !onMulticamSync}
              onClick={complete ? onInspect : onMulticamSync}>
              {primaryLabel}
            </button>
            {running && task && onCancel && <button type="button" className="secondary" disabled={Boolean(command) || task.cancel_requested}
              onClick={onCancel}>{task.cancel_requested || command === "cancel" ? "正在取消…" : "取消同步"}</button>}
            {task && onOpenStatus && <button type="button" className="secondary" onClick={onOpenStatus}>任务详情</button>}
            {!complete && onInspect && <button type="button" className="secondary" onClick={onInspect}>查看上次有效母版</button>}
          </div>
        </header>

        <div className="sync-task-body">
          <section className="sync-task-sources" aria-labelledby="sync-task-sources-title">
            <h2 id="sync-task-sources-title">素材来源</h2>
            <dl>
              <div><dt>原始目录</dt><dd>{sourceRoots}</dd></div>
              <div><dt>视频</dt><dd>{footage}</dd></div>
              <div><dt>机位</dt><dd>{cameras}</dd></div>
              <div><dt>同期录音</dt><dd>{recordings}</dd></div>
            </dl>
            {inaccessible > 0 && <p className="sync-task-warning" role="status">{inaccessible} 个原始目录不可访问</p>}
            {onRepair && <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button>}
          </section>

          <section className="sync-task-stages" aria-labelledby="sync-task-stages-title">
            <h2 id="sync-task-stages-title">制作进度</h2>
            <ol>
              {SYNC_STEPS.map(([label, hint], index) => {
                const current = index === stepIndex;
                const done = index < stepIndex && !unreadable;
                const stageStatus = done ? "已完成" : current ? complete ? "下一步" : phaseLabel : "待执行";
                return <li key={label} data-state={done ? "done" : current ? "current" : "upcoming"} aria-current={current ? "step" : undefined}>
                  <div className="sync-task-step"><strong>{label}</strong><small>{hint}</small></div>
                  <span className="sync-task-step-status">{stageStatus}</span>
                </li>;
              })}
            </ol>
          </section>
        </div>

        <section className="multicam-sync-live" aria-label="最近活动" aria-live="polite">
          <header><h2>最近活动</h2>{lastActivity && <time>{activityLabel(lastActivity)}</time>}</header>
          <p>{latestMessage}</p>
          {submissionError && <p className="multicam-sync-error" role="alert">{submissionError}</p>}
          {task?.cancel_requested && <p role="status">已请求取消，正在等待安全中断点。</p>}
          {hasCheckpoints && <div className="multicam-sync-progress">
            <div><span>同步算法检查点</span><strong>{done} / {total}</strong></div>
            <progress value={done ?? 0} max={total ?? 1} aria-label="同步算法检查点进度" />
          </div>}
          {problem && task?.error && <p className="multicam-sync-error" role="alert">{task.error}</p>}
          {unreadable && <p className="multicam-sync-error" role="alert">{syncTimeline.message}</p>}
          {task?.started_at && <small>开始时间 {activityLabel(task.started_at)}</small>}
        </section>
      </div>
    </section>
  );
}


export function MulticamSyncTimeline(props: Props) {
  const { syncTimeline } = props;
  if (syncTimeline.phase === "not-required") return null;
  if (!syncTimeline.ready) return <SyncTaskWorkspace {...props} />;
  return <SyncInspectionWorkbench {...props} />;
}
