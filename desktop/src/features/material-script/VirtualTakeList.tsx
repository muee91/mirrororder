import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ReviewTakeGroup } from "../../api/host";
import { AngleEvidenceCard } from "./AngleEvidenceCard";
import { TAKE_ROW_HEIGHT, takeStatus, virtualRange } from "./model";

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

function TakeCard({
  take,
  selected,
  onSelect,
  onDragBegin,
  onDragFinish,
}: {
  take: ReviewTakeGroup;
  selected: boolean;
  onSelect: () => void;
  onDragBegin: (groupId: string) => void;
  onDragFinish: () => void;
}) {
  return (
    <article
      className={`take-card take-status-${takeStatus(take)} ${selected ? "is-selected" : ""}`}
      draggable
      onDragStart={(event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(DRAG_TAKE_MIME, take.group_id);
        event.dataTransfer.setData("text/plain", take.group_id);
        onDragBegin(take.group_id);
      }}
      onDragEnd={onDragFinish}
    >
      <header className="take-card-heading">
        <div>
          <div className="take-title-row">
            <strong>{take.group_id}</strong>
            {take.take_index > 1 ? <span className="tiny-pill">#{take.take_index}</span> : null}
            <span className={`mapping-source source-${take.effective_mapping.source}`}>
              {mappingSourceLabel(take.effective_mapping.source)}
            </span>
            <span className={`tiny-pill bucket-${takeStatus(take)}`}>{bucketLabel(take)}</span>
          </div>
          <p>{mappingLabel(take)}</p>
        </div>
        <div className="take-heading-actions">
          <span className="duration-label">{take.duration.toFixed(1)}s</span>
          <button type="button" className="take-select" onClick={onSelect}>{selected ? "当前" : "查看"}</button>
        </div>
      </header>

      <p className={`take-transcript ${take.transcript.text ? "" : "is-empty"}`}>
        {take.transcript.text || "无可靠对白"}
      </p>

      <div className="angle-strip" aria-label={`${take.group_id} 机位`}>
        {take.angles.map((angle) => <AngleEvidenceCard angle={angle} compact key={angle.clip_id} />)}
      </div>

      {take.issues.length > 0 ? (
        <div className="issue-row take-issues">
          {take.issues.slice(0, 3).map((issue) => (
            <span className={`issue-chip issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>
              {issue.label}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function VirtualTakeList({
  takes,
  selectedGroupId,
  onSelect,
  onDragBegin,
  onDragFinish,
}: {
  takes: ReviewTakeGroup[];
  selectedGroupId: string | null;
  onSelect: (take: ReviewTakeGroup) => void;
  onDragBegin: (groupId: string) => void;
  onDragFinish: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewportHeight(Math.max(TAKE_ROW_HEIGHT, node.clientHeight || 720));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !selectedGroupId) return;
    const index = takes.findIndex((take) => take.group_id === selectedGroupId);
    if (index < 0) return;
    const top = index * TAKE_ROW_HEIGHT;
    if (top < node.scrollTop || top + TAKE_ROW_HEIGHT > node.scrollTop + node.clientHeight) {
      node.scrollTop = Math.max(0, top - TAKE_ROW_HEIGHT);
      setScrollTop(node.scrollTop);
    }
  }, [selectedGroupId, takes]);

  const range = virtualRange(takes.length, scrollTop, viewportHeight);
  const visible = takes.slice(range.start, range.end);

  return (
    <div
      className="take-virtual-scroll"
      ref={viewportRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label={`素材 Take，共 ${takes.length} 条`}
    >
      <div className="take-virtual-canvas" style={{ height: takes.length * TAKE_ROW_HEIGHT }}>
        {visible.map((take, offset) => (
          <div
            className="virtual-take-row"
            key={take.group_id}
            style={{ transform: `translateY(${(range.start + offset) * TAKE_ROW_HEIGHT}px)` }}
          >
            <TakeCard
              take={take}
              selected={take.group_id === selectedGroupId}
              onSelect={() => onSelect(take)}
              onDragBegin={onDragBegin}
              onDragFinish={onDragFinish}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
