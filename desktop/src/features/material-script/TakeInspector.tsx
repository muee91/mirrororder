import { useEffect, useMemo, useRef } from "react";
import type { HostConnection, ReviewTakeGroup } from "../../api/host";
import { cameraPresentation } from "../media/cameraPresentation";
import { reviewTakeAttention } from "../review/reviewAttention";
import { AngleEvidenceCard } from "./AngleEvidenceCard";
import { CandidateEvidence } from "./CandidateEvidence";
import { mappingLabel, mappingSourceLabel, takeDisplayLabel } from "./TakeCard";
import { AuditEvidencePanel, EditorialDecisionPanel } from "./TakeEvidencePanels";
import "./take-review.css";

function cameraContinuityKey(value: string | undefined): string {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return "";
  const presentation = cameraPresentation(value || "");
  return presentation.tone === "custom" || presentation.tone === "unknown"
    ? raw
    : presentation.tone;
}

export function TakeInspector({
  connection,
  projectId,
  take,
  selectedClipId,
  onSelectClip,
  onShowScript,
  onClearPlacement,
  writeSaving,
  showEditorial = false,
}: {
  connection: HostConnection;
  projectId: string;
  take: ReviewTakeGroup | null;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  onShowScript: () => void;
  onClearPlacement: () => void;
  writeSaving: boolean;
  showEditorial?: boolean;
}) {
  const angle = take?.angles.find((item) => item.clip_id === selectedClipId) ?? take?.angles[0] ?? null;
  const playbackUrl = useMemo(
    () => angle ? connection.mediaUrl(projectId, angle.clip_id) : "",
    [angle, connection, projectId],
  );
  const previousGroupId = useRef(take?.group_id ?? "");
  const preferredCamera = useRef(cameraContinuityKey(angle?.camera));

  useEffect(() => {
    if (!take) return;
    const groupChanged = Boolean(previousGroupId.current) && previousGroupId.current !== take.group_id;
    if (groupChanged) {
      previousGroupId.current = take.group_id;
      const key = preferredCamera.current;
      const matching = key
        ? take.angles.find((item) => cameraContinuityKey(item.camera) === key) ?? null
        : null;
      if (matching && matching.clip_id !== selectedClipId) {
        onSelectClip(matching.clip_id);
        return;
      }
    }
    previousGroupId.current = take.group_id;
    const current = take.angles.find((item) => item.clip_id === selectedClipId) ?? take.angles[0] ?? null;
    const key = cameraContinuityKey(current?.camera);
    if (key) preferredCamera.current = key;
  }, [onSelectClip, selectedClipId, take]);

  if (!take) return <aside className="take-inspector"><div className="player-empty">当前项目没有 Take。</div></aside>;

  const displayLabel = takeDisplayLabel(take);
  const attention = showEditorial ? reviewTakeAttention(take) : null;

  return (
    <aside className="take-inspector">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">当前 Take</p>
          <h3>{displayLabel}</h3>
        </div>
        <span className={`mapping-source source-${take.effective_mapping.source}`}>
          {mappingSourceLabel(take.effective_mapping.source)}
        </span>
      </div>
      <p className="inspector-mapping">{mappingLabel(take)}</p>

      {take.issues.length ? (
        <div className="take-inspector-statusline" aria-label={`${displayLabel} 当前问题`}>
          {take.issues.slice(0, 2).map((issue) => (
            <span className={`take-inspector-issue issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>{issue.label}</span>
          ))}
          {take.issues.length > 2 ? <span className="take-inspector-issue-overflow">+{take.issues.length - 2}</span> : null}
        </div>
      ) : null}

      {attention?.hasAttention ? (
        <section className="take-attention-summary" aria-label={`${displayLabel} 需关注`}>
          <div className="take-attention-heading"><strong>需关注</strong><span>{attention.labels.length} 项</span></div>
          <div className="take-attention-labels">
            {attention.labels.slice(0, 4).map((label) => <span key={label}>{label}</span>)}
          </div>
          {attention.context ? <p>{attention.context}</p> : null}
        </section>
      ) : null}

      <div className="inspector-actions">
        <button type="button" className="secondary" onClick={onShowScript}>定位剧本</button>
        {take.effective_mapping.source === "human" ? (
          <button type="button" className="secondary danger-quiet" disabled={writeSaving} onClick={onClearPlacement}>
            清除人工归集
          </button>
        ) : null}
      </div>

      <div className="inspector-angle-cards" aria-label={`${displayLabel} 机位选择`}>
        {take.angles.map((item) => (
          <AngleEvidenceCard
            angle={item}
            selected={item.clip_id === angle?.clip_id}
            onSelect={onSelectClip}
            compact
            key={item.clip_id}
          />
        ))}
      </div>

      {angle?.playback.available === false ? (
        <div className="player-empty">当前设备未解析到这条媒体。</div>
      ) : angle && playbackUrl ? (
        <video
          className="take-player"
          controls
          preload="metadata"
          src={playbackUrl}
          key={angle.clip_id}
          onLoadedMetadata={(event) => {
            if (angle.source_start > 0) event.currentTarget.currentTime = angle.source_start;
          }}
          onTimeUpdate={(event) => {
            if (event.currentTarget.currentTime < angle.source_start) event.currentTarget.currentTime = angle.source_start;
            if (angle.source_end !== null && event.currentTarget.currentTime >= angle.source_end) event.currentTarget.pause();
          }}
        />
      ) : (
        <div className="player-empty">当前 Take 没有可播放机位。</div>
      )}

      {angle ? (
        <div className="selected-angle-meta">
          <strong>{angle.name}</strong>
          <span>{angle.camera || "—"} · {angle.duration.toFixed(1)}s · {angle.shot_type && angle.shot_type !== "unknown" ? angle.shot_type : "景别尚无 clip-level 投影"}</span>
        </div>
      ) : null}

      <div className="dialogue-panel">
        <p className="eyebrow">对白</p>
        <p>{take.transcript.text || "当前没有可靠对白投影。"}</p>
      </div>

      {showEditorial ? <EditorialDecisionPanel baseUrl={connection.baseUrl} projectId={projectId} groupId={take.group_id} /> : null}

      <details className="take-inspector-evidence">
        <summary>
          <span>制作证据与候选</span>
          <small>{take.candidates.length ? `${take.candidates.length} 个候选` : "按需展开"}</small>
        </summary>
        <AuditEvidencePanel take={take} selectedAngle={angle} />

        {take.candidates.length > 0 ? (
          <div className="candidate-panel">
            <p className="eyebrow">候选关系 · 需人工审阅后确认</p>
            {take.candidates.slice(0, 3).map((candidate) => (
              <CandidateEvidence candidate={candidate} key={candidate.candidate_id} />
            ))}
            <div className="inspector-actions">
              <button type="button" className="secondary" onClick={onShowScript}>
                到剧本审阅首选候选
              </button>
            </div>
          </div>
        ) : null}
      </details>
    </aside>
  );
}
