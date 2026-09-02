import "./status-indicators.css";

export type ConnectionIndicatorState = "ready" | "connecting" | "offline" | "error";
export type TaskIndicatorState = "queued" | "running" | "complete" | "warning" | "failed" | "cancelled";
export type SlateIndicatorState = "unmarked" | "usable" | "partial" | "ng";
export type MediaHealthState = "ready" | "offline" | "unsupported" | "identity_missing" | "index_pending";
export type ReviewDecision = "unset" | "best" | "keep" | "reject";
export type ReviewAuthority = "individual" | "editorial";

const CONNECTION_LABELS: Record<ConnectionIndicatorState, string> = {
  ready: "已连接",
  connecting: "连接中",
  offline: "离线",
  error: "连接失败",
};

const TASK_LABELS: Record<TaskIndicatorState, string> = {
  queued: "等待中",
  running: "处理中",
  complete: "已完成",
  warning: "需注意",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_ICONS: Record<TaskIndicatorState, string> = {
  queued: "·",
  running: "↻",
  complete: "✓",
  warning: "!",
  failed: "×",
  cancelled: "–",
};

const SLATE_LABELS: Record<SlateIndicatorState, string> = {
  unmarked: "待定",
  usable: "可用",
  partial: "部分可用",
  ng: "NG",
};

const MEDIA_HEALTH: Record<MediaHealthState, { label: string; icon: string }> = {
  ready: { label: "可播放", icon: "▶" },
  offline: { label: "素材离线", icon: "×" },
  unsupported: { label: "编码不支持", icon: "!" },
  identity_missing: { label: "播放身份缺失", icon: "?" },
  index_pending: { label: "等待索引", icon: "…" },
};

const REVIEW_LABELS: Record<ReviewDecision, string> = {
  unset: "未判断",
  best: "Best",
  keep: "Keep",
  reject: "Reject",
};

export function ConnectionIndicator({ state, label }: { state: ConnectionIndicatorState; label?: string }) {
  const text = label || CONNECTION_LABELS[state];
  return (
    <span className="mo-connection-indicator" data-state={state} role="status" aria-label={text}>
      <span className="mo-connection-indicator-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function TaskStatusIndicator({
  state,
  label,
  progress,
}: {
  state: TaskIndicatorState;
  label?: string;
  progress?: number | null;
}) {
  const text = label || TASK_LABELS[state];
  const bounded = typeof progress === "number" && Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : null;
  return (
    <span
      className="mo-task-status-indicator"
      data-state={state}
      data-progress={bounded === null ? "none" : "value"}
      role="status"
      aria-label={bounded === null ? text : `${text} ${Math.round(bounded)}%`}
      style={{ "--mo-task-progress": bounded === null ? "0%" : `${bounded}%` } as React.CSSProperties}
    >
      <span className="mo-task-status-icon" aria-hidden="true">{TASK_ICONS[state]}</span>
      <span className="mo-task-status-label">{text}</span>
      <span className="mo-task-status-progress" aria-hidden="true"><span /></span>
    </span>
  );
}

export function SlateStatusIndicator({ state }: { state: SlateIndicatorState }) {
  const text = SLATE_LABELS[state];
  return (
    <span className="mo-slate-status-indicator" data-state={state} role="status" aria-label={`场记状态：${text}`}>
      <span className="mo-slate-status-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function MediaHealthIndicator({ state }: { state: MediaHealthState }) {
  const item = MEDIA_HEALTH[state];
  return (
    <span className="mo-media-health-indicator" data-state={state} role="status" aria-label={`素材状态：${item.label}`}>
      <span className="mo-media-health-icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
    </span>
  );
}

export function ReviewDecisionIndicator({
  decision,
  authority = "individual",
}: {
  decision: ReviewDecision;
  authority?: ReviewAuthority;
}) {
  const text = REVIEW_LABELS[decision];
  const authorityLabel = authority === "editorial" ? "最终剪辑决定" : "个人审阅意见";
  return (
    <span
      className="mo-review-decision-indicator"
      data-decision={decision}
      data-authority={authority}
      role="status"
      aria-label={`${authorityLabel}：${text}`}
    >
      <span className="mo-review-decision-rail" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}
