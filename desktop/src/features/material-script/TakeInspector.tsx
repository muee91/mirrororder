import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { HostConnection, ReviewAngle, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { cameraPresentation } from "../media/cameraPresentation";
import { classifyPlaybackFailure, type PlaybackFailure } from "../media/playbackFailure";
import { canPreviewReviewPlayback } from "../media/mediaPlaybackProjection";
import type { ProductionSelectionContext } from "../production/productionNavigation";
import { reviewAspectStyle, useReviewAspect } from "../media/useReviewAspect";
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

export function takePlaybackBounds(
  angle: ReviewAngle | null,
  projectId: string,
  groupId?: string,
  focus?: ProductionSelectionContext,
) {
  const sourceIn = angle?.playback.source_start ?? angle?.source_start ?? 0;
  const sourceOut = angle?.playback.source_end ?? angle?.source_end;
  const range = focus?.projectId === projectId && focus.groupId === groupId
    && (!focus.clipId || focus.clipId === angle?.clip_id)
    && (!focus.mediaId || focus.mediaId === angle?.media_id) ? focus.sourceRange : undefined;
  const offset = range?.basis === "take" ? sourceIn : 0;
  const requested = range ? range.start + offset : sourceIn;
  const start = requested >= sourceIn && (sourceOut == null || requested < sourceOut) ? requested : sourceIn;
  const end = requested === start && range?.end !== undefined && range.end + offset > start
    ? Math.min(sourceOut ?? Infinity, range.end + offset) : undefined;
  return { sourceIn, sourceOut, start, end };
}

export function TakeInspector({
  connection,
  projectId,
  take,
  selectedClipId,
  playbackFocus,
  onSelectClip,
  onShowScript,
  onClearPlacement,
  onPlaybackResult,
  writeSaving,
  afterPlayback = null,
  hideHeader = false,
  retainCameraOnTakeChange = true,
  monitor,
}: {
  connection: HostConnection;
  projectId: string;
  take: ReviewTakeGroup | null;
  selectedClipId: string | null;
  playbackFocus?: ProductionSelectionContext;
  onSelectClip: (clipId: string) => void;
  onShowScript?: () => void;
  onClearPlacement?: () => void;
  onPlaybackResult?: (clipId: string, failed: boolean) => void;
  writeSaving: boolean;
  afterPlayback?: ReactNode;
  hideHeader?: boolean;
  retainCameraOnTakeChange?: boolean;
  monitor?: {
    relatedActions?: ReactNode;
    slateContext?: ReactNode;
    footageNotes?: ReactNode;
    videoRef: Ref<HTMLVideoElement>;
    scriptBlock?: ReviewScriptBlock;
    request?: { nonce: number; autoplay: boolean; bounded?: boolean; resume?: ProductionSelectionContext };
    onOpenRepair?: () => void;
  };
}) {
  const angle = take?.angles.find((item) => item.clip_id === selectedClipId) ?? take?.angles[0] ?? null;
  const { ratio, measure } = useReviewAspect(angle);
  const { sourceIn, sourceOut, start, end } = takePlaybackBounds(angle, projectId, take?.group_id, playbackFocus);
  const stop = monitor?.request?.bounded ? end ?? sourceOut : sourceOut;
  const autoplayRequest = useRef<number | undefined>(undefined);
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
    if (!take || !retainCameraOnTakeChange) return;
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
  }, [onSelectClip, retainCameraOnTakeChange, selectedClipId, take]);

  if (!take) return <aside className="take-inspector"><div className="player-empty">当前项目没有 Take。</div></aside>;

  const displayLabel = takeDisplayLabel(take);

  const playback = angle?.playback.state === "missing" || angle?.playback.available === false ? (
    <div className="player-empty">{monitor ? "本机素材未连接" : "当前设备未解析到这条媒体。"}
      {monitor?.onOpenRepair && <button type="button" className="secondary" onClick={monitor.onOpenRepair}>检查本机素材</button>}
    </div>
  ) : angle?.playback.state === "unknown" || (!angle?.playback.state && angle?.playback.available === undefined) ? (
    <div className="player-empty">{monitor ? "本机素材待确认" : "当前设备尚未确认这条媒体，请先完成素材扫描或绑定。"}
      {monitor?.onOpenRepair && <button type="button" className="secondary" onClick={monitor.onOpenRepair}>检查本机素材</button>}
    </div>
  ) : angle && playbackUrl && canPreviewReviewPlayback(angle.playback) && !playbackFailed ? (
    <video
      className="take-player"
      controls
      preload="metadata"
      src={playbackUrl}
      ref={monitor?.videoRef}
      data-clip-id={angle.clip_id}
      key={`${take.group_id}-${angle.clip_id}-${playbackRetry}-${start}-${monitor?.request?.nonce ?? ""}`}
      onError={() => {
        setPlaybackFailed(true);
        // video.error 分不清缺失和解码；报错后探测一次给出可行动的原因。
        void classifyPlaybackFailure(playbackUrl).then(setFailureDetail);
      }}
      onResize={monitor ? event => { const video = event.currentTarget; measure(video.videoWidth / video.videoHeight); } : undefined}
      onLoadedMetadata={(event) => {
        const player = event.currentTarget;
        if (monitor) measure(player.videoWidth / player.videoHeight);
        const request = monitor?.request;
        const resume = request?.resume;
        const resumedAt = resume?.projectId === projectId && resume.groupId === take.group_id
          && resume.clipId === angle.clip_id && resume.mediaId === angle.media_id
          && resume.sourceRange?.basis === "source" ? resume.sourceRange.start : undefined;
        const target = resumedAt !== undefined && resumedAt >= sourceIn && resumedAt <= (stop ?? Infinity)
          && resumedAt <= player.duration ? resumedAt : start < player.duration ? start : sourceIn;
        if (target > 0 && target <= player.duration) player.currentTime = target;
        if (request?.autoplay && autoplayRequest.current !== request.nonce) {
          autoplayRequest.current = request.nonce;
          void player.play()?.catch(() => undefined);
        }
      }}
      onTimeUpdate={(event) => {
        const video = event.currentTarget;
        if (video.currentTime < sourceIn) video.currentTime = sourceIn;
        if (stop != null && video.currentTime >= stop) {
          video.pause();
          if (monitor?.request?.bounded && video.currentTime > stop) video.currentTime = stop;
        }
      }}
      onPlay={(event) => {
        const video = event.currentTarget;
        if (monitor && stop != null && video.currentTime >= stop) video.currentTime = start;
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
  );

  const evidence = (
    <details className="take-inspector-evidence">
      <summary>
        <span>{monitor?.slateContext ? "场记与制作证据" : monitor ? "制作证据" : "制作证据与候选"}</span>
        {take.candidates.length ? <small>{take.candidates.length} 个候选</small> : !monitor && <small>按需展开</small>}
      </summary>
      {monitor?.slateContext}
      {monitor && take.transcript.text && <p className="review-transcript">{take.transcript.text}</p>}
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
  );

  return (
    <aside className="take-inspector">
      {!hideHeader ? (
        <>
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
        </>
      ) : null}

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

      {!monitor && <div className="inspector-angle-cards" aria-label={`${displayLabel} 机位选择`}>
        {take.angles.map((item) => (
          <AngleEvidenceCard
            angle={item}
            selected={item.clip_id === angle?.clip_id}
            onSelect={onSelectClip}
            compact
            key={item.clip_id}
          />
        ))}
      </div>}

      {monitor ? <div className="review-monitor-stage" style={reviewAspectStyle(ratio)}>
        <div className="review-monitor-picture">{playback}</div>
        {ratio !== undefined && ratio < 1 && (monitor.footageNotes || monitor.scriptBlock || take.transcript.text) && <aside className="review-monitor-reference" aria-label="本条看片对照">
          {monitor.footageNotes}
          {monitor.scriptBlock && <section><h4>剧本原句</h4><p>{monitor.scriptBlock.raw_text || monitor.scriptBlock.text}</p></section>}
          {take.transcript.text && <section><h4>现场对白摘录</h4><p>{take.transcript.text}</p></section>}
        </aside>}
      </div> : playback}
      {monitor?.footageNotes && (ratio === undefined || ratio >= 1) && <div className="review-monitor-slate-notes" aria-label="本条看片场记">{monitor.footageNotes}</div>}

      {angle && !monitor ? (
        <div className="selected-angle-meta">
          <strong>{angle.name}</strong>
          <span>{angle.camera || "—"} · {angle.duration.toFixed(1)}s{angle.shot_type && angle.shot_type !== "unknown" ? ` · ${angle.shot_type}` : ""}</span>
        </div>
      ) : null}

      {afterPlayback}

      {!monitor && take.issues.length ? (
        <div className="take-inspector-statusline" aria-label={`${displayLabel} 当前问题`}>
          {take.issues.slice(0, 2).map((issue) => (
            <span className={`take-inspector-issue issue-${issue.severity}`} key={`${take.group_id}-${issue.code}`}>{issue.label}</span>
          ))}
          {take.issues.length > 2 ? <span className="take-inspector-issue-overflow">+{take.issues.length - 2}</span> : null}
        </div>
      ) : null}

      {!monitor && <div className="dialogue-panel">
        <p className="eyebrow">对白</p>
        <p>{take.transcript.text || "暂无识别对白"}</p>
      </div>}

      {monitor ? <div className="review-monitor-tools">{monitor.relatedActions}{evidence}</div> : evidence}
    </aside>
  );
}
