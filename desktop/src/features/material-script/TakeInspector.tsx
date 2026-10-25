import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostConnection, ReviewTakeGroup } from "../../api/host";
import { cameraPresentation } from "../media/cameraPresentation";
import { classifyPlaybackFailure, type PlaybackFailure } from "../media/playbackFailure";
import { AngleEvidenceCard } from "./AngleEvidenceCard";
import { AuditEvidencePanel } from "./AuditEvidencePanel";
import { CandidateEvidence } from "./CandidateEvidence";
import { mappingLabel, mappingSourceLabel, takeDisplayLabel } from "./TakeCard";
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
  onPlaybackResult,
  writeSaving,
  afterPlayback = null,
}: {
  connection: HostConnection;
  projectId: string;
  take: ReviewTakeGroup | null;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  onShowScript?: () => void;
  onClearPlacement?: () => void;
  onPlaybackResult?: (clipId: string, failed: boolean) => void;
  writeSaving: boolean;
  afterPlayback?: ReactNode;
}) {
  const angle = take?.angles.find((item) => item.clip_id === selectedClipId) ?? take?.angles[0] ?? null;
  const playbackUrl = useMemo(
    () => angle ? connection.mediaUrl(projectId, angle.clip_id) : "",
    [angle, connection, projectId],
  );
  // 播放失败（404 = 素材盘未挂载/文件移动）要有行内提示与重试，不能只留黑屏。
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [playbackRetry, setPlaybackRetry] = useState(0);
  const [failureDetail, setFailureDetail] = useState<PlaybackFailure | null>(null);
  useEffect(() => {
    setPlaybackFailed(false);
    setFailureDetail(null);
  }, [playbackUrl, playbackRetry]);
  // 运行时加载结果上抛给所属工作区聚合；服务端"可用"与本机"能播"是两层口径。
  useEffect(() => {
    if (!angle) return;
    onPlaybackResult?.(angle.clip_id, playbackFailed);
  }, [angle?.clip_id, onPlaybackResult, playbackFailed]);
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

      {/* 继承自父组的人工 placement 清除是空操作（authority 在父组），
          因此对 inherited 只提供"定位剧本"，不渲染清除按钮。 */}
      {onShowScript || (onClearPlacement && take.effective_mapping.source === "human" && !take.effective_mapping.inherited) ? (
        <div className="inspector-actions">
          {onShowScript ? <button type="button" className="secondary" onClick={onShowScript}>定位剧本</button> : null}
          {onClearPlacement && take.effective_mapping.source === "human" && !take.effective_mapping.inherited ? (
            <button type="button" className="secondary danger-quiet" disabled={writeSaving} onClick={onClearPlacement}>
              清除人工归集
            </button>
          ) : null}
        </div>
      ) : null}

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
      ) : angle && playbackUrl && !playbackFailed ? (
          <video
          className="take-player"
          controls
          preload="metadata"
          src={playbackUrl}
          key={`${angle.clip_id}-${playbackRetry}`}
          onError={() => {
            setPlaybackFailed(true);
            // video.error 分不清缺失和解码；报错后探测一次给出可行动的原因。
            void classifyPlaybackFailure(playbackUrl).then(setFailureDetail);
          }}
          onLoadedMetadata={(event) => {
            if (angle.source_start > 0) event.currentTarget.currentTime = angle.source_start;
          }}
          onTimeUpdate={(event) => {
            if (event.currentTarget.currentTime < angle.source_start) event.currentTarget.currentTime = angle.source_start;
            if (angle.source_end !== null && event.currentTarget.currentTime >= angle.source_end) event.currentTarget.pause();
          }}
        />
      ) : angle && playbackUrl ? (
        <div className="player-empty take-player-error">
          <strong>素材无法读取</strong>
          <span>{failureDetail?.detail ?? "正在确认失败原因；可先检查素材盘挂载后重试。"}</span>
          <button type="button" className="secondary" onClick={() => setPlaybackRetry((value) => value + 1)}>重试</button>
        </div>
      ) : (
        <div className="player-empty">当前 Take 没有可播放机位。</div>
      )}

      {angle ? (
        <div className="selected-angle-meta">
          <strong>{angle.name}</strong>
          <span>{angle.camera || "—"} · {angle.duration.toFixed(1)}s · {angle.shot_type && angle.shot_type !== "unknown" ? angle.shot_type : "景别尚无 clip-level 投影"}</span>
        </div>
      ) : null}

      {afterPlayback}

      {take.issues.length ? (
        <div className="take-inspector-statusline" aria-label={`${displayLabel} 当前问题`}>
          {take.issues.slice(0, 2).map((issue) => (
            <span className={`take-inspector-issue issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>{issue.label}</span>
          ))}
          {take.issues.length > 2 ? <span className="take-inspector-issue-overflow">+{take.issues.length - 2}</span> : null}
        </div>
      ) : null}

      <div className="dialogue-panel">
        <p className="eyebrow">对白</p>
        <p>{take.transcript.text || "当前没有可靠对白投影。"}</p>
      </div>

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
            {onShowScript ? (
              <div className="inspector-actions">
                <button type="button" className="secondary" onClick={onShowScript}>
                  到剧本审阅首选候选
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </details>
    </aside>
  );
}
