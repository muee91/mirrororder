import { useMemo, type DragEvent } from "react";
import type { ReviewAngle, ReviewTakeGroup } from "../../api/host";
import { cameraPresentation, STABLE_CAMERA_SLOTS, type CameraTone } from "../media/cameraPresentation";
import { AngleEvidenceCard } from "./AngleEvidenceCard";
import { takeStatus } from "./model";

export const DRAG_TAKE_MIME = "application/x-mirrororder-take";

export function episodeLabel(episode: number): string {
  return episode > 0 ? `EP${episode}` : "未分集";
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

  return (
    <article
      className={`take-card take-status-${status} ${selected ? "is-selected" : ""}`}
      draggable
      tabIndex={selected ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      aria-label={`${take.group_id} · ${bucketLabel(take)} · ${mappingLabel(take)}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
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
          <strong className="take-card-id" title={take.group_id}>{take.group_id}</strong>
          <span className="take-card-index">#{take.take_index}</span>
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

      <div className="take-camera-strip" aria-label={`${take.group_id} 机位槽位`}>
        {slots.map((slot) => {
          const primary = slot.angles[0] ?? null;
          return (
            <section className={`take-camera-slot ${primary ? "has-media" : "is-empty"}`} data-camera-tone={slot.tone} key={slot.key} aria-label={`${slot.label} 槽位`}>
              <header>
                <strong>{slot.label}</strong>
                <span>{slot.angles.length > 1 ? `+${slot.angles.length - 1}` : primary ? "已绑定" : "空"}</span>
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
