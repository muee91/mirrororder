import type { ReviewAngle } from "../../api/host";

export interface AngleEvidenceCardProps {
  angle: ReviewAngle;
  selected?: boolean;
  onSelect?: (clipId: string) => void;
  compact?: boolean;
}

function mediaState(angle: ReviewAngle): string {
  if (angle.playback.available === false) return "缺媒体";
  if (angle.playback.available === true) return "可播放";
  return "状态未知";
}

export function AngleEvidenceCard({ angle, selected = false, onSelect, compact = false }: AngleEvidenceCardProps) {
  const shot = angle.shot_type && angle.shot_type !== "unknown" ? angle.shot_type : "景别—";
  const role = angle.coverage_role && angle.coverage_role !== "unknown" ? angle.coverage_role : "";
  const className = `angle-card fixed-angle-card ${selected ? "is-selected" : ""} ${onSelect ? "is-interactive" : ""} ${compact ? "is-compact" : ""}`;
  const content = (
    <>
      <div className="angle-card-heading">
        <span className="camera-label">{angle.camera || "—"}</span>
        <span className="angle-duration">{angle.duration.toFixed(1)}s</span>
      </div>
      <strong className="angle-media-name" title={angle.name}>{angle.name}</strong>
      <div className="angle-meta">
        <span className={`angle-media-state media-${angle.playback.available === false ? "missing" : angle.playback.available === true ? "ready" : "unknown"}`}>{mediaState(angle)}</span>
        <span className="shot-type">{shot}</span>
      </div>
      <div className="angle-card-role" title={role || "未标注 coverage role"}>{role || "用途—"}</div>
    </>
  );

  if (onSelect) {
    return (
      <button type="button" className={className} aria-pressed={selected} onClick={() => onSelect(angle.clip_id)}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}
