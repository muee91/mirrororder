import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { errorMessage, type HostConnection, type ReviewAngle, type ReviewScriptBlock, type ReviewTakeGroup } from "../../api/host";
import { SpeechEvidenceClient, type SpeechEvidence } from "../../api/speechEvidence";
import { cameraPresentation } from "../media/cameraPresentation";
import { canPreviewReviewPlayback } from "../media/mediaPlaybackProjection";
import { classifyPlaybackFailure } from "../media/playbackFailure";
import { reviewSourceClock } from "./reviewLocation";
import { matchesScriptSpeech, scriptSpeechClauses } from "../material-script/scriptSpeech";
import { ReviewAngleStatus, ReviewFootageStatus, ReviewSlateReference } from "./ReviewFootageStatus";
import type { AngleSlateFact, ReviewSlateFacts, SlateReadState } from "./reviewFootageFacts";
import "./review-multicam-monitor.css";

interface Props {
  take: ReviewTakeGroup;
  projectId: string;
  connection: HostConnection;
  scriptBlock?: ReviewScriptBlock;
  adjacentDialogue?: readonly ReviewScriptBlock[];
  preferredClipId?: string | null;
  initialSourceTime?: number;
  onOpenRepair?: () => void;
  slate?: ReviewSlateFacts;
  slateReadState?: SlateReadState;
  onWatchAngle: (clipId: string, sourceTime: number) => void;
}

function sourceWindow(angle: ReviewAngle) {
  const start = Math.max(0, angle.playback.source_start ?? angle.source_start);
  const span = angle.timeline_end - angle.timeline_start;
  const end = angle.playback.source_end ?? angle.source_end ?? (span > 0 ? start + span : Infinity);
  return { start, end };
}


interface SpeechProps {
  client: SpeechEvidenceClient;
  projectId: string;
  angle: ReviewAngle;
  end: number;
  canSeek: boolean;
  clauses: readonly string[];
  matchLabel: string;
  openAtCue: (time: number) => void;
  seek: (time: number) => void;
}

function AngleSpeech({ client, projectId, angle, end, canSeek, seek, clauses, matchLabel, openAtCue }: SpeechProps) {
  const [evidence, setEvidence] = useState<SpeechEvidence | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { start } = sourceWindow(angle);
  useEffect(() => {
    let current = true;
    setEvidence(null);
    setError("");
    void client.evidence(projectId, angle.clip_id).then(result => {
      if (!current) return;
      if (angle.media_id && result.media_id !== angle.media_id) throw new Error("素材身份已变化，请重新打开这个 Take");
      setEvidence(result);
    }).catch(reason => { if (current) setError(errorMessage(reason)); });
    return () => { current = false; };
  }, [client, projectId, angle.clip_id, angle.media_id, attempt]);

  const segments = useMemo(() => evidence?.status === "available"
    ? evidence.segments.filter(segment => segment.text.trim() && segment.start < end && segment.end > start) : [],
  [evidence, start, end]);

  const firstMatch = useMemo(() => segments.find(row => matchesScriptSpeech(row.text, clauses)), [clauses, segments]);
  const firstLine = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!firstMatch || !canSeek) return;
    openAtCue(Math.max(start, firstMatch.start));
    const row = firstLine.current;
    if (row?.parentElement) row.parentElement.scrollTop += row.getBoundingClientRect().top - row.parentElement.getBoundingClientRect().top;
  }, [canSeek, firstMatch, openAtCue, start]);

  return <div className="review-mc-speech" aria-label={`${angle.name} 实拍对白`}>
    {segments.length ? <>
      <strong>实拍对白</strong>
      <ol>{segments.map((segment, index) => {
        const time = Math.max(start, segment.start);
        const match = matchesScriptSpeech(segment.text, clauses);
        return <li key={`${segment.start}:${index}`} ref={segment === firstMatch ? firstLine : undefined} data-script-match={match || undefined}><button type="button" disabled={!canSeek}
          aria-label={`定位到 ${reviewSourceClock(time)}，${segment.text}`} onClick={() => seek(time)}>
          <span>{reviewSourceClock(time)}</span><span>{match && <b>{matchLabel} </b>}{segment.text}</span>
        </button></li>;
      })}</ol>
    </> : error ? <>
      <span role="status" title={error}>本机位对白读取失败</span>
      <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>重读对白</button>
    </> : <span>{!evidence ? "正在读取对白…" : evidence.status !== "available" ? "本机位暂无转写"
      : evidence.outcome === "no-speech" ? "本机位未检测到语音" : "这段原片范围内没有转写对白"}</span>}
  </div>;
}

interface AngleProps extends Pick<Props, "projectId" | "connection" | "onOpenRepair" | "onWatchAngle"> {
  angle: ReviewAngle;
  slate?: AngleSlateFact;
  client: SpeechEvidenceClient;
  initialTime?: number;
  clauses: readonly string[];
  matchLabel: string;
  listening: boolean;
  onListen: (clipId: string) => void;
}

function AngleMonitor({ projectId, connection, angle, slate, client, initialTime, clauses, matchLabel, listening, onListen, onOpenRepair, onWatchAngle }: AngleProps) {
  const camera = cameraPresentation(angle.camera);
  const video = useRef<HTMLVideoElement>(null);
  const { start, end: declaredEnd } = sourceWindow(angle);
  const [duration, setDuration] = useState<number | null>(null);
  const [displayRatio, setDisplayRatio] = useState<number | null>(null);
  const [position, setPosition] = useState(initialTime !== undefined && initialTime >= start && initialTime < declaredEnd ? initialTime : start);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const mediaUrl = connection.mediaUrl(projectId, angle.clip_id);
  const failureRequest = useRef(0);
  const end = Math.min(declaredEnd, duration ?? Infinity);
  const available = canPreviewReviewPlayback(angle.playback);
  const noCoverage = end <= start;
  const ready = available && !noCoverage && duration !== null && !error;
  const showVideo = available && !noCoverage && !error;

  useLayoutEffect(() => {
    const element = video.current;
    return () => { if (element && !element.paused) element.pause(); };
  }, [showVideo, attempt, mediaUrl]);

  useLayoutEffect(() => () => { failureRequest.current += 1; }, [mediaUrl]);

  function readDisplaySize(element: HTMLVideoElement): void {
    if (element.videoWidth > 0 && element.videoHeight > 0) {
      setDisplayRatio(element.videoWidth / element.videoHeight);
    }
  }

  const positionChosen = useRef(initialTime !== undefined);
  const openAtCue = useCallback((time: number) => {
    const element = video.current;
    if (positionChosen.current || !element || !element.paused) return;
    positionChosen.current = true;
    element.currentTime = time;
    setPosition(time);
  }, []);
  function seek(time: number): void {
    positionChosen.current = true;
    const element = video.current;
    if (!element || !ready) return;
    const next = Math.max(start, Math.min(end, time));
    element.currentTime = next;
    setPosition(next);
  }

  function togglePlayback(): void {
    positionChosen.current = true;
    const element = video.current;
    if (!element || !ready) return;
    if (!element.paused) { element.pause(); return; }
    if (element.currentTime >= end || element.currentTime < start) seek(start);
    void element.play().catch(reason => {
      if (video.current === element && reason?.name !== "AbortError") setError("播放失败，请重试");
    });
  }

  function retry(): void {
    failureRequest.current += 1;
    setError("");
    setPlaying(false);
    setDuration(null);
    setAttempt(value => value + 1);
  }

  const status = !available ? (angle.playback.state === "missing" || angle.playback.available === false
    ? "本机素材未连接" : "本机素材待确认") : noCoverage ? "这条 Take 没有可看的原片区间" : error;

  return <article className="review-mc-angle" data-camera-tone={camera.tone} aria-label={`${camera.label} · ${angle.name}`}
    style={displayRatio ? { "--review-mc-ratio": displayRatio } as CSSProperties : undefined}>
    <header><strong>{camera.label}</strong><span title={angle.name}>{angle.name || "未命名素材"}</span></header>
    <div className="review-mc-camera-fact"><ReviewAngleStatus fact={slate} camera={camera.label} /></div>
    <div className="review-mc-picture">{status ? <div className="review-mc-placeholder">
      <span role="status">{status}</span>
      {error && <button type="button" className="secondary" onClick={retry}>重试播放</button>}
      {!available && onOpenRepair && <button type="button" className="secondary" onClick={onOpenRepair}>检查本机素材</button>}
    </div> : <video ref={video} key={attempt} src={mediaUrl} preload="metadata" playsInline muted={!listening}
      aria-label={`${camera.label}原片 ${angle.name}`} data-clip-id={angle.clip_id}
      onResize={event => readDisplaySize(event.currentTarget)}
      onLoadedMetadata={event => {
        const element = event.currentTarget;
        readDisplaySize(element);
        const actualEnd = Math.min(declaredEnd, element.duration);
        const target = position >= start && position < actualEnd ? position : start;
        setDuration(Number.isNaN(element.duration) ? null : element.duration);
        if (actualEnd > start) {
          // WebKit may keep a metadata-only, paused video black until a seek requests its first decoded frame.
          const frame = target === 0 && element.readyState < 2 ? Math.min(actualEnd / 2, 0.001) : target;
          if (frame !== element.currentTime) element.currentTime = frame;
        }
        setPosition(target);
      }}
      onTimeUpdate={event => {
        const element = event.currentTarget;
        if (element.currentTime < start) element.currentTime = start;
        if (element.currentTime >= end) {
          if (!element.paused) element.pause();
          if (element.currentTime > end) element.currentTime = end;
        }
        setPosition(element.currentTime);
      }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onVolumeChange={event => { if (!listening) event.currentTarget.muted = true; }}
      onError={event => {
        const request = ++failureRequest.current;
        event.currentTarget.pause();
        setPlaying(false);
        setError("原片播放失败");
        void classifyPlaybackFailure(mediaUrl).then(failure => { if (request === failureRequest.current) setError(failure.title); });
      }}
    />}</div>
    {available && !noCoverage && !error && <>
      <div className="review-mc-seek">
        <input type="range" aria-label={`${angle.name} 原片位置`} aria-valuetext={reviewSourceClock(position)}
          min={start} max={Number.isFinite(end) ? end : start} step="0.01" value={position}
          disabled={!ready || !Number.isFinite(end)} onChange={event => seek(Number(event.target.value))} />
        <span>{reviewSourceClock(position)}</span>
      </div>
      <div className="review-mc-controls">
        <button type="button" className="secondary mo-toolbar-button" disabled={!ready} onClick={togglePlayback}>{playing ? "暂停" : "播放"}</button>
        <button type="button" className="secondary mo-toolbar-button" aria-pressed={listening}
          onClick={() => onListen(angle.clip_id)}>{listening ? "正在监听" : "监听"}</button>
        <button type="button" className="secondary mo-toolbar-button" disabled={!ready} onClick={() => {
          onWatchAngle(angle.clip_id, video.current?.currentTime ?? position);
        }}>单独看</button>
      </div>
    </>}
    <AngleSpeech client={client} projectId={projectId} angle={angle} end={end} canSeek={ready} seek={seek} clauses={clauses} matchLabel={matchLabel} openAtCue={openAtCue} />
  </article>;
}

function MulticamSession({ take, projectId, connection, scriptBlock, adjacentDialogue, preferredClipId, initialSourceTime, onWatchAngle, onOpenRepair, slate, slateReadState }: Props) {
  const root = useRef<HTMLElement>(null);
  const clauses = useMemo(() => adjacentDialogue?.flatMap(scriptSpeechClauses) ?? scriptSpeechClauses(scriptBlock), [adjacentDialogue, scriptBlock]);
  const client = useMemo(() => new SpeechEvidenceClient(connection.baseUrl), [connection.baseUrl]);
  const playable = take.angles.filter(angle => {
    const { start, end } = sourceWindow(angle);
    return canPreviewReviewPlayback(angle.playback) && end > start;
  });
  const [requestedListener, setRequestedListener] = useState(preferredClipId);
  const listener = playable.find(angle => angle.clip_id === requestedListener) ?? playable[0];

  function listen(clipId: string) {
    if (listener?.clip_id === clipId) return;
    root.current?.querySelectorAll("video").forEach(element => { element.muted = true; });
    setRequestedListener(clipId);
  }

  return <section className="review-multicam" ref={root} aria-label="同条 Take 多机位并排看片">
    <div className="review-mc-context"><ReviewFootageStatus take={take} facts={slate} readState={slateReadState} />
      <ReviewSlateReference record={slate?.take} />
      <p className="review-mc-instruction">{scriptBlock?.type === "action" ? `核对动作 · ${scriptBlock.text || scriptBlock.raw_text}` : "各机位独立播放，选择监听机位可听同期声。"}</p>
    </div>
    <div className="review-mc-grid">{take.angles.map(angle => <AngleMonitor
      key={JSON.stringify([angle.clip_id, angle.media_id, angle.playback.source_start, angle.playback.source_end])}
      angle={angle} slate={slate?.angles.get(angle.clip_id)} client={client} clauses={clauses} matchLabel={adjacentDialogue?.length ? "相邻台词" : "本句"} projectId={projectId} connection={connection}
      initialTime={angle.clip_id === preferredClipId ? initialSourceTime : undefined}
      listening={angle.clip_id === listener?.clip_id} onListen={listen} onWatchAngle={onWatchAngle} onOpenRepair={onOpenRepair}
    />)}</div>
    {!take.angles.length && <p>这条 Take 没有机位素材。</p>}
  </section>;
}

export function ReviewMulticamMonitor(props: Props) {
  return <MulticamSession key={JSON.stringify([props.connection.baseUrl, props.projectId, props.take.group_id])} {...props} />;
}
