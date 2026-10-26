import { useMemo, type DragEvent } from "react";
import type { ReviewAngle, ReviewTakeGroup } from "../../api/host";
import { cameraPresentation, STABLE_CAMERA_SLOTS, type CameraTone } from "../media/cameraPresentation";
import { AngleEvidenceCard } from "./AngleEvidenceCard";
import { takeStatus } from "./model";
import "./take-card.css";

export const DRAG_TAKE_MIME = "application/x-mirrororder-take";

export function episodeLabel(episode: number): string {
  return episode > 0 ? `EP${episode}` : "未分集";
}

export function takeDisplayLabel(take: ReviewTakeGroup): string {
  const base = take.take_index > 0 ? `Take #${take.take_index}` : "Take";
  // 真实项目里不同场常各自从 #1 计数，单看 "Take #1" 无法区分；
  // 拼上主机位 clip 名（剪辑师辨认 Take 的主要线索）。
  const clipStem = take.angles[0]?.name?.replace(/\.[^.]+$/, "").trim();
  return clipStem ? `${base} · ${clipStem}` : base;
}

export function mappingLabel(take: ReviewTakeGroup): string {
  const mapping = take.effective_mapping;
  if (mapping.mapping_status === "episode_only") {
    return mapping.episode_ids.length > 0
      ? `仅归集到 ${mapping.episode_ids.map(episodeLabel).join(" / ")}`
      : "仅完成集数归集";
  }
  if (mapping.script_segment_ids.length > 0) {
    const episodes = mapping.episode_ids.map(episodeLabel).join(" / ");
    return `${episodes ? `${episodes} · ` : ""}${mapping.script_segment_ids.length} 个剧本段`;
  }
  return "未归集";
}

export function mappingSourceLabel(source: string): string {
  if (source === "human") return "人工";
  if (source === "automatic") return "自动";
  return "待处理";
}

function bucketLabel(take: ReviewTakeGroup): string {
  const labels = {
    candidate: "AI/算法候选",
    pending: "待归集",
    placed: "已归集",
    rejected: "已排除",
  } as const;
  return labels[takeStatus(take)];
}

export interface TakeCameraSlotModel {
  key: string;
  tone: CameraTone;
  label: string;
  angles: ReviewAngle[];
}

export type TakeSlotAvailability = "none" | "available" | "offline" | "mixed";

// 机位槽位三态：空槽 = 该机位未拍摄；offline = 有素材但服务端判定不可用（素材盘/绑定问题）。
// 空槽和离线在走查截图里都呈现为“空白占位”，用户无从区分是没拍还是出问题。
export function takeSlotAvailability(angles: ReviewAngle[]): TakeSlotAvailability {
  if (!angles.length) return "none";
  const offline = angles.filter((angle) => angle.playback.state === "missing" || angle.playback.available === false).length;
  if (offline === 0) return "available";
  if (offline === angles.length) return "offline";
  return "mixed";
}

export function takeCameraSlots(angles: ReviewAngle[]): TakeCameraSlotModel[] {
  const grouped = new Map<CameraTone, ReviewAngle[]>();
  for (const angle of angles) {
    const tone = cameraPresentation(angle.camera || "").tone;
    const rows = grouped.get(tone) ?? [];
    rows.push(angle);
    grouped.set(tone, rows);
  }

  const stable = STABLE_CAMERA_SLOTS.map((slot) => ({
    key: slot.tone,
    tone: slot.tone,
    label: slot.label,
    angles: grouped.get(slot.tone) ?? [],
  }));

  const trailing = angles
    .filter((angle) => {
      const tone = cameraPresentation(angle.camera || "").tone;
      return tone === "custom" || tone === "unknown";
    })
    .map((angle) => {
      const presentation = cameraPresentation(angle.camera || "");
      return {
        key: `${presentation.tone}-${angle.clip_id}`,
        tone: presentation.tone,
        label: presentation.label,
        angles: [angle],
      } satisfies TakeCameraSlotModel;
    });

  return [...stable, ...trailing];
}

export interface TakeCardProps {
  take: ReviewTakeGroup;
  selected: boolean;
  onSelect: () => void;
  onDragBegin: (groupId: string) => void;
  onDragFinish: () => void;
}

export function TakeCard({ take, selected, onSelect, onDragBegin, onDragFinish }: TakeCardProps) {
  const slots = useMemo(() => takeCameraSlots(take.angles), [take.angles]);
  const status = takeStatus(take);
  const displayLabel = takeDisplayLabel(take);

  return (
    <article
      className={`take-card take-status-${status} ${selected ? "is-selected" : ""}`}
      data-ui-authority="take-card"
      draggable
      tabIndex={selected ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      aria-label={`${displayLabel} · ${bucketLabel(take)} · ${mappingLabel(take)}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      onDragStart={(event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(DRAG_TAKE_MIME, take.group_id);
        event.dataTransfer.setData("text/plain", take.group_id);
        onDragBegin(take.group_id);
      }}
      onDragEnd={onDragFinish}
    >
      <header className="take-card-heading">
        <div className="take-card-identity">
          <span className="take-card-kicker">TAKE</span>
          <strong className="take-card-id">{take.take_index > 0 ? `#${take.take_index}` : "—"}</strong>
        </div>
        <div className="take-card-state">
          <span className={`mapping-source source-${take.effective_mapping.source}`}>{mappingSourceLabel(take.effective_mapping.source)}</span>
          <span className={`take-bucket bucket-${status}`}>{bucketLabel(take)}</span>
        </div>
        <div className="take-heading-actions">
          <span className="duration-label">{take.duration.toFixed(1)}s</span>
          <button type="button" className="take-select" onClick={onSelect} aria-pressed={selected}>{selected ? "当前" : "查看"}</button>
        </div>
      </header>

      <div className="take-card-mapping" title={mappingLabel(take)}>{mappingLabel(take)}</div>

      <p className={`take-transcript ${take.transcript.text ? "" : "is-empty"}`}>
        {take.transcript.text || "无可靠对白"}
      </p>

      <div className="take-camera-strip" aria-label={`${displayLabel} 机位槽位`}>
        {slots.map((slot) => {
          const primary = slot.angles[0] ?? null;
          const availability = takeSlotAvailability(slot.angles);
          return (
            <section
              className={`take-camera-slot ${availability === "none" ? "is-empty" : availability === "offline" ? "is-offline" : "has-media"}`}
              data-camera-tone={slot.tone}
              key={slot.key}
              aria-label={`${slot.label} 槽位${availability === "offline" ? "（素材离线）" : availability === "mixed" ? "（部分素材离线）" : ""}`}
            >
              <header>
                <strong>{slot.label}</strong>
                <span>{availability === "offline" ? "离线" : slot.angles.length > 1 ? `+${slot.angles.length - 1}` : primary ? "已绑定" : "空"}</span>
              </header>
              {primary ? <AngleEvidenceCard angle={primary} compact /> : <div className="take-camera-empty"><span>{slot.label}</span><small>无素材</small></div>}
            </section>
          );
        })}
      </div>

      <div className="take-issue-slot" aria-label="Take 问题">
        {take.issues.slice(0, 3).map((issue) => (
          <span className={`issue-chip issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>{issue.label}</span>
        ))}
        {take.issues.length > 3 ? <span className="issue-overflow">+{take.issues.length - 3}</span> : null}
      </div>
    </article>
  );
}

export type TakeListRowState = "default" | "used" | "current";

export interface TakeListRowProps {
  take: ReviewTakeGroup;
  detail?: string;
  state?: TakeListRowState;
  action?: () => void;
  actionLabel?: string;
  onSelect?: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>, take: ReviewTakeGroup) => void;
}

export function TakeListRow({ take, detail, state = "default", action, actionLabel, onSelect, onDragStart }: TakeListRowProps) {
  const displayLabel = takeDisplayLabel(take);
  const status = takeStatus(take);
  const slots = useMemo(() => takeCameraSlots(take.angles), [take.angles]);
  const stableSlots = slots.slice(0, STABLE_CAMERA_SLOTS.length);
  const trailingCount = slots.slice(STABLE_CAMERA_SLOTS.length).reduce((total, slot) => total + slot.angles.length, 0);
  const secondary = detail || take.transcript.text || mappingLabel(take);

  return (
    <article
      className={`mo-take-list-row state-${state} take-status-${status}`}
      data-ui-authority="take-compact"
      data-take-state={state}
      draggable={Boolean(onDragStart)}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${displayLabel} · ${secondary}`}
      onDragStart={onDragStart ? (event) => onDragStart(event, take) : undefined}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onSelect?.();
      }}
      onKeyDown={onSelect ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      } : undefined}
    >
      <div className="mo-take-list-core">
        <header className="mo-take-list-heading">
          <strong>{displayLabel}</strong>
          <span>{take.duration.toFixed(1)}s</span>
        </header>
        <div className="mo-take-list-cameras" aria-label={`${displayLabel} 机位槽位`}>
          {stableSlots.map((slot) => {
            const availability = takeSlotAvailability(slot.angles);
            const slotTitle = slot.angles.length
              ? `${slot.angles.map((angle) => angle.name).filter(Boolean).join(" / ") || slot.label}${availability === "offline" ? "（素材离线）" : availability === "mixed" ? "（部分素材离线）" : ""}`
              : `${slot.label} 无素材`;
            return (
              <span
                className={`mo-take-list-camera ${availability === "none" ? "is-empty" : availability === "offline" ? "is-offline" : "has-media"}`}
                data-camera-tone={slot.tone}
                key={slot.key}
                title={slotTitle}
              >
                <strong>{slot.label.replace("机", "")}</strong>
                <em>{availability === "offline" ? "离" : slot.angles.length > 1 ? `×${slot.angles.length}` : slot.angles.length ? "•" : "—"}</em>
              </span>
            );
          })}
          {trailingCount ? <span className="mo-take-list-camera-overflow" title="自定义或未知机位">+{trailingCount}</span> : null}
        </div>
        <div className="mo-take-list-detail">
          <span title={secondary}>{secondary}</span>
          <small>{bucketLabel(take)}</small>
        </div>
      </div>
      {action && actionLabel ? (
        <button
          type="button"
          className="mo-take-list-action"
          onClick={(event) => {
            event.stopPropagation();
            action();
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}
