import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AssistantSelection } from "../../api/production";
import {
  SyncTimelineClient,
  syncDeliveryFileLabel,
  type MulticamSyncClip,
  type MulticamSyncTimeline,
  type SyncDeliveryArtifacts,
} from "../../api/syncTimeline";
import { SyncRecordingMonitor } from "./SyncRecordingMonitor";
import { PlatformClient } from "../../api/platform";
import { SyncAnglePreview, type SyncPreviewClock } from "./SyncAnglePreview";
import { SyncTimelineViewport } from "./SyncTimelineViewport";
import {
  activeClip, cameraColor, clamp, compactSyncTimeline, confirmedSyncRate, firstClipFrame, indexClips,
  indexReviewGaps, timecode, toFrame, toMasterFrame, toReviewFrame, toSeconds,
} from "./syncTimelineNavigation";
const MILLISECOND_GRID = { numerator: 1000, denominator: 1 };
type SplitView = { kind: "all" } | { kind: "compare"; left: string; right: string };
type MonitorView = SplitView | { kind: "single"; trackId: string; previous: SplitView };

interface Props {
  syncTimeline: MulticamSyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  showDelivery?: boolean;
  onOpenDelivery?: () => void;
  onInspectSelection?: (selection: AssistantSelection) => void;
}

function secondsLabel(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function readMonitorSize(projectId: string, dimension: "preview-height" | "inspector-width"): number | null {
  try {
    const value = Number(globalThis.localStorage?.getItem(`mirrororder.sync-${dimension}.${projectId}`));
    return Number.isFinite(value) && value >= 120 ? value : null;
  } catch { return null; }
}

function rememberMonitorSize(projectId: string, dimension: "preview-height" | "inspector-width", size: number): void {
  try { globalThis.localStorage?.setItem(`mirrororder.sync-${dimension}.${projectId}`, String(size)); }
  catch { /* A layout preference must not block source inspection. */ }
}

function sourcePosition(clip: MulticamSyncClip | undefined, position: number): number {
  return clip ? clamp(position - clip.timeline_start, 0, Math.max(0, clip.duration - 0.000001)) : 0;
}

export function SyncInspectionWorkbench({ syncTimeline, baseUrl, onMulticamSync, showDelivery = true, onOpenDelivery, onInspectSelection }: Props) {
  const duration = Math.max(syncTimeline.duration_seconds, 0.1);
  const firstPosition = syncTimeline.tracks[0]?.clips[0]?.timeline_start ?? 0;
  const confirmedRate = useMemo(() => confirmedSyncRate(syncTimeline), [syncTimeline.timebase]);
  const rate = confirmedRate ?? MILLISECOND_GRID;
  const totalFrames = Math.max(1, Math.ceil(duration * rate.numerator / rate.denominator));
  const reviewGaps = useMemo(() => indexReviewGaps(confirmedRate ? syncTimeline.review_gaps ?? [] : []),
    [syncTimeline.review_gaps, confirmedRate]);
  const [showOriginalGaps, setShowOriginalGaps] = useState(false);
  const compactView = !showOriginalGaps && reviewGaps.length > 0;
  // Playback and assistant selections stay on the master. Only the ruler and track view move.
  const reviewTimeline = useMemo(() => compactView ? compactSyncTimeline(syncTimeline, rate, reviewGaps) : syncTimeline,
    [compactView, syncTimeline, rate, reviewGaps]);
  const [cursor, setCursor] = useState(() => firstClipFrame(firstPosition, rate));
  const reviewCursor = compactView ? toReviewFrame(cursor, reviewGaps) : cursor;
  const position = toSeconds(cursor, rate);
  const [seekRevision, setSeekRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followingRecording, setFollowingRecording] = useState(false);
  const [presented, setPresented] = useState<{ source: string; seconds: number } | null>(null);
  const [frameCallbackSupported, setFrameCallbackSupported] = useState(true);
  const seeking = useRef(false);
  const resumeOnAngleChange = useRef(false);
  const [previewHeight, setPreviewHeight] = useState<number | null>(() => readMonitorSize(syncTimeline.project_id, "preview-height"));
  const [preferredInspectorWidth, setInspectorWidth] = useState(() => readMonitorSize(syncTimeline.project_id, "inspector-width") ?? 296);
  const [deskSize, setDeskSize] = useState({ height: 0, width: 0, chrome: 110, row: 36 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const inspectorResizeStart = useRef<{ x: number; width: number } | null>(null);
  const minInspectorWidth = 228;
  const maxInspectorWidth = Math.max(minInspectorWidth, Math.min(448, Math.floor((deskSize.width || 1180) * 0.44)));
  const inspectorWidth = clamp(preferredInspectorWidth, minInspectorWidth, maxInspectorWidth);
  const minPreviewHeight = 120;
  const minimumRows = Math.min(3, syncTimeline.tracks.length);
  const maxPreviewHeight = Math.max(minPreviewHeight, deskSize.height - deskSize.chrome - minimumRows * deskSize.row);
  const preferredHeight = Math.round(deskSize.height * 0.53);
  const pictureHeight = clamp(previewHeight ?? preferredHeight, minPreviewHeight, maxPreviewHeight);
  const [trackId, setTrackId] = useState(syncTimeline.tracks[0]?.track_id ?? "");
  const [monitorView, setMonitorView] = useState<MonitorView>({ kind: "all" });
  const [playbackError, setPlaybackError] = useState("");
  const [artifacts, setArtifacts] = useState<SyncDeliveryArtifacts | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [revealBusy, setRevealBusy] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const platform = useMemo(() => new PlatformClient(), []);
  const tracks = syncTimeline.tracks;
  const selectedTrack = tracks.find(track => track.track_id === trackId) ?? tracks[0];
  const selectedTrackId = selectedTrack?.track_id ?? "";
  const indices = useMemo(() => new Map(syncTimeline.tracks.map(track => [track.track_id, indexClips(track.clips)])), [syncTimeline.tracks]);
  const clip = activeClip(indices.get(selectedTrackId), position);
  useLayoutEffect(() => {
    onInspectSelection?.({
      sync_clip_id: clip?.clip_id, clip_id: clip?.media_clip_id || undefined,
      camera: selectedTrack?.camera, playhead_frame: confirmedRate ? cursor : undefined,
      sync_task_id: syncTimeline.task?.task_id,
    });
  }, [onInspectSelection, clip, selectedTrack?.camera, confirmedRate, cursor, syncTimeline.task?.task_id]);
  const mediaUrl = useCallback((item: MulticamSyncClip | undefined) => baseUrl && item?.media_clip_id
    ? `${baseUrl.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(syncTimeline.project_id)}/media/${encodeURIComponent(item.media_clip_id)}`
    : "", [baseUrl, syncTimeline.project_id]);
  const playbackUrl = mediaUrl(clip);
  const playbackKey = clip && playbackUrl ? `${clip.clip_id}:${clip.timeline_start}:${playbackUrl}` : "";
  const sourceTime = sourcePosition(clip, position);
  const canShowAngles = tracks.length > 1;
  const displayTracks = useMemo(() => {
    if (monitorView.kind === "all") return tracks;
    const ids = monitorView.kind === "compare" ? [monitorView.left, monitorView.right] : [monitorView.trackId];
    const visible = ids.flatMap(id => tracks.find(track => track.track_id === id) ?? []);
    return visible.length === ids.length ? visible : tracks;
  }, [monitorView, tracks]);
  const viewKind = displayTracks === tracks ? "all" : monitorView.kind;
  const selectedVisible = displayTracks.some(track => track.track_id === selectedTrackId);
  const displayedTime = selectedVisible && presented?.source === playbackKey ? presented.seconds : null;
  const presentedFrame = displayedTime !== null && clip ? toFrame(clip.timeline_start + displayedTime, rate) : undefined;
  const reviewPresentedFrame = presentedFrame !== undefined && compactView ? toReviewFrame(presentedFrame, reviewGaps) : presentedFrame;
  // A timeline selection can listen to a camera outside the current monitor view.
  const mountedTracks = selectedTrack && !selectedVisible ? [...displayTracks, selectedTrack] : displayTracks;
  const gridColumns = viewKind === "all" && tracks.length >= 3
    ? tracks.length === 4 ? 2 : 3
    : Math.max(1, displayTracks.length);
  const [inspector, setInspector] = useState<"clip" | "audio" | null>(null);
  const clipInspectorButton = useRef<HTMLButtonElement>(null);
  const audioInspectorButton = useRef<HTMLButtonElement>(null);
  const inspectorId = useId();
  const recordingsAvailable = Boolean(baseUrl && syncTimeline.recordings);

  function closeInspector() {
    const trigger = inspector === "audio" ? audioInspectorButton : clipInspectorButton;
    setInspector(null);
    trigger.current?.focus();
  }

  function resizeInspector(width: number, persist: boolean): void {
    const next = clamp(width, minInspectorWidth, maxInspectorWidth);
    setInspectorWidth(next);
    if (persist) rememberMonitorSize(syncTimeline.project_id, "inspector-width", next);
  }

  useEffect(() => {
    resumeOnAngleChange.current = false;
    setCursor(firstClipFrame(firstPosition, rate));
    setSeekRevision(value => value + 1);
    setPreviewHeight(readMonitorSize(syncTimeline.project_id, "preview-height"));
    setInspectorWidth(readMonitorSize(syncTimeline.project_id, "inspector-width") ?? 296);
    setTrackId(syncTimeline.tracks[0]?.track_id ?? "");
    setMonitorView({ kind: "all" });
    setFollowingRecording(false);
    setInspector(null);
  }, [syncTimeline.project_id, rate.numerator, rate.denominator]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const desk = canvas?.parentElement;
    if (!canvas || !desk) return;
    const bars = Array.from(canvas.querySelectorAll<HTMLElement>(
      ".multicam-sync-divider, .multicam-sync-controls, .multicam-sync-overview, .multicam-sync-ruler"));
    const lane = canvas.querySelector<HTMLElement>(".multicam-sync-track");
    const measure = () => {
      const height = canvas.clientHeight;
      const width = desk.clientWidth;
      const chrome = bars.reduce((sum, bar) => sum + bar.offsetHeight, 2);
      const row = lane?.offsetHeight || 36;
      setDeskSize(previous => previous.height === height && previous.width === width && previous.chrome === chrome && previous.row === row
        ? previous : { height, width, chrome, row });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(desk);
    bars.forEach(bar => observer.observe(bar));
    if (lane) observer.observe(lane);
    return () => observer.disconnect();
  }, [syncTimeline.tracks.length]);

  useEffect(() => {
    const video = videoRef.current;
    const failed = Boolean(video?.error);
    setPlaybackError(failed ? "媒体读取或解码失败，请检查本机绑定或该视频编码。" : "");
    seeking.current = false;
    if (!resumeOnAngleChange.current || !video || failed) {
      resumeOnAngleChange.current = false;
      setPlaying(false);
      if (video && !video.paused) {
        seeking.current = true;
        video.pause();
      }
    }
  }, [playbackKey, selectedTrackId]);

  const target = useRef({ sourceTime, clip, cursor, selectedTrackId });
  target.current = { sourceTime, clip, cursor, selectedTrackId };
  const seekMedia = useCallback((video: HTMLVideoElement) => {
    if (video !== videoRef.current || !target.current.clip || video.readyState < 1) return;
    const wanted = Math.max(0, Math.min(target.current.sourceTime, Number.isFinite(video.duration) ? video.duration - 0.000001 : Infinity));
    if (Math.abs(video.currentTime - wanted) <= 0.0000001) {
      seeking.current = false;
      return;
    }
    seeking.current = true;
    video.currentTime = wanted;
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setPresented(null);
    const supported = typeof video.requestVideoFrameCallback === "function";
    setFrameCallbackSupported(supported);
    if (!supported) return;
    let stopped = false, callback = 0, lastUpdate = 0;
    const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      if (video.paused || now - lastUpdate >= 100) {
        setPresented({ source: playbackKey, seconds: metadata.mediaTime });
        if (video === videoRef.current && !video.paused && !video.seeking && !seeking.current
          && !resumeOnAngleChange.current && target.current.clip) {
          setCursor(clamp(toFrame(target.current.clip.timeline_start + metadata.mediaTime, rate), 0, totalFrames - 1));
        }
        lastUpdate = now;
      }
      callback = video.requestVideoFrameCallback(frame);
    };
    callback = video.requestVideoFrameCallback(frame);
    return () => { stopped = true; video.cancelVideoFrameCallback(callback); };
  }, [playbackKey, selectedTrackId, rate, totalFrames]);
  const onSeek = useCallback((frame: number, camera?: string) => {
    const targetFrame = Math.round(frame);
    const next = clamp(compactView ? toMasterFrame(targetFrame, reviewGaps) : targetFrame, 0, totalFrames - 1);
    if (next !== target.current.cursor || (camera && camera !== target.current.selectedTrackId)) {
      resumeOnAngleChange.current = false;
      seeking.current = true;
      videoRef.current?.pause();
      setPlaying(false);
      setCursor(next);
      setSeekRevision(value => value + 1);
    }
    if (camera) setTrackId(camera);
  }, [totalFrames, compactView, reviewGaps]);

  function toggleGaps(): void {
    if (showOriginalGaps) {
      // A position in a removed gap lands on the first surviving frame after the cut.
      onSeek(toMasterFrame(toReviewFrame(cursor, reviewGaps), reviewGaps));
    }
    setShowOriginalGaps(!showOriginalGaps);
  }
  const playVideo = useCallback((video: HTMLVideoElement) => {
    void video.play().catch((error: unknown) => {
      if (video !== videoRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setPlaying(false);
      setPlaybackError("原片无法开始播放，请检查媒体状态。");
    });
  }, []);
  const resumeAnglePlayback = useCallback((video: HTMLVideoElement) => {
    if (!resumeOnAngleChange.current || video !== videoRef.current || video.readyState < 1 || video.seeking) return;
    resumeOnAngleChange.current = false;
    if (video.paused) playVideo(video);
  }, [playVideo]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.error) return;
    seekMedia(video);
    resumeAnglePlayback(video);
  }, [seekRevision, playbackKey, selectedTrackId, seekMedia, resumeAnglePlayback]);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video?.paused) playVideo(video);
    else video?.pause();
  }, [playVideo]);

  function selectAngle(id: string): void {
    if (id === selectedTrackId) return;
    const video = videoRef.current;
    const wasPlaying = Boolean(playing && video && clip && !video.paused);
    const frame = wasPlaying && video && clip
      ? clamp(toFrame(clip.timeline_start + video.currentTime, rate), 0, totalFrames - 1) : cursor;
    const newClip = activeClip(indices.get(id), toSeconds(frame, rate));
    resumeOnAngleChange.current = wasPlaying && Boolean(mediaUrl(newClip));
    if (wasPlaying) setCursor(frame);
    setTrackId(id);
  }

  function showComparison(): void {
    const previous = monitorView.kind === "single" ? monitorView.previous : monitorView;
    if (previous.kind === "compare" && tracks.some(track => track.track_id === previous.left)
      && tracks.some(track => track.track_id === previous.right)) {
      setMonitorView(previous);
      return;
    }
    const other = tracks.find(track => track.track_id !== selectedTrackId);
    if (other && selectedTrackId) setMonitorView({ kind: "compare", left: selectedTrackId, right: other.track_id });
  }

  function setComparisonAngle(side: "left" | "right", id: string): void {
    setMonitorView(current => {
      if (current.kind !== "compare") return current;
      const other = side === "left" ? "right" : "left";
      return id === current[other]
        ? { kind: "compare", left: current.right, right: current.left }
        : { ...current, [side]: id };
    });
  }

  useEffect(() => {
    if (!showDelivery || !baseUrl) return;
    let cancelled = false;
    setArtifacts(null);
    setArtifactError("");
    void new SyncTimelineClient(baseUrl).readArtifacts(syncTimeline.project_id).then((value) => {
      if (!cancelled) setArtifacts(value);
    }).catch((error: unknown) => {
      if (!cancelled) setArtifactError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [baseUrl, showDelivery, syncTimeline.project_id]);

  async function reveal(path: string, target: string): Promise<void> {
    setRevealBusy(target);
    setArtifactError("");
    try {
      await platform.reveal(path);
    } catch (error) {
      setArtifactError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealBusy("");
    }
  }

  function resizePicture(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!resizeStart.current) return;
    setPreviewHeight(clamp(resizeStart.current.height + event.clientY - resizeStart.current.y,
      minPreviewHeight, maxPreviewHeight));
  }

  const clock: SyncPreviewClock | undefined = clip && playbackUrl ? {
    video: videoRef,
    onLoadedMetadata(event) {
        seekMedia(event.currentTarget);
        resumeAnglePlayback(event.currentTarget);
    },
    onSeeked(event) {
        if (event.currentTarget !== videoRef.current) return;
        seeking.current = false;
        resumeAnglePlayback(event.currentTarget);
    },
    onPlay(event) {
      if (event.currentTarget === videoRef.current) setPlaying(true);
    },
    onPause(event) {
        const video = event.currentTarget;
        if (video !== videoRef.current) return;
        if (seeking.current || video.seeking || resumeOnAngleChange.current) return;
        setPlaying(false);
        setCursor(clamp(toFrame(clip.timeline_start + video.currentTime, rate), 0, totalFrames - 1));
    },
    onEnded(event) {
      if (event.currentTarget === videoRef.current) setPlaying(false);
    },
    onTimeUpdate(event) {
        const video = event.currentTarget;
        if (video !== videoRef.current || video.paused || video.seeking || seeking.current || resumeOnAngleChange.current) return;
        if (selectedVisible && typeof video.requestVideoFrameCallback === "function") return;
        setCursor(clamp(toFrame(clip.timeline_start + video.currentTime, rate), 0, totalFrames - 1));
    },
    onError(event) {
        if (event.currentTarget !== videoRef.current) return;
        resumeOnAngleChange.current = false;
        setPlaying(false);
        setPlaybackError("媒体读取或解码失败，请检查本机绑定或该视频编码。");
    },
  } : undefined;

  return (
    <section className={`multicam-sync-inspection${showDelivery ? " is-embedded" : ""}`} aria-label="多机位同步时间线检查">
      <header className="multicam-sync-inspection-heading">
        <div className="sync-master-heading">
          <h2>{showDelivery ? "同步母版" : "多机位监看"}</h2>
          <span>{syncTimeline.cameras.length} 机位 · {syncTimeline.clip_count.toLocaleString()} 个片段</span>
          {selectedTrack && <span className="sync-monitor-listening">监听 {selectedTrack.label}</span>}
        </div>
        <div className="multicam-sync-inspection-meta">
          {canShowAngles && <div className="sync-monitor-modes" role="group" aria-label="监看方式">
            <button type="button" aria-pressed={viewKind === "all"} onClick={() => setMonitorView({ kind: "all" })}>
              {viewKind === "all" ? "全部机位" : "返回全部机位"}
            </button>
            <button type="button" aria-pressed={viewKind === "compare"} onClick={showComparison}>双机对照</button>
            <button type="button" aria-pressed={viewKind === "single"} onClick={() => setMonitorView({
              kind: "single", trackId: selectedTrackId, previous: monitorView.kind === "single" ? monitorView.previous : monitorView,
            })}>放大所选</button>
          </div>}
          {viewKind === "compare" && monitorView.kind === "compare" &&
            <div className="sync-monitor-pair" role="group" aria-label="对照机位">
              {(["left", "right"] as const).map(side => <select key={side} aria-label={side === "left" ? "左侧机位" : "右侧机位"}
                value={monitorView[side]} onChange={event => setComparisonAngle(side, event.target.value)}>
                {tracks.map(track => <option key={track.track_id} value={track.track_id}>{track.label}</option>)}
              </select>)}
            </div>}
          <button type="button" className="secondary sync-inspector-toggle" ref={clipInspectorButton}
            aria-expanded={inspector === "clip"} aria-controls={inspector === "clip" ? inspectorId : undefined}
            onClick={() => setInspector(current => current === "clip" ? null : "clip")}>片段检查器</button>
          {recordingsAvailable && <button type="button" className="secondary sync-inspector-toggle" ref={audioInspectorButton}
            aria-expanded={inspector === "audio"} aria-controls={inspector === "audio" ? inspectorId : undefined}
            onClick={() => setInspector(current => current === "audio" ? null : "audio")}>同期录音 <span>{syncTimeline.recordings?.placements.length}</span></button>}
          {reviewGaps.length > 0 && <button type="button" className="sync-gap-toggle secondary" aria-pressed={compactView}
            title="只去除所有机位都停拍的间隙" onClick={toggleGaps}>去除共同间隙</button>}
          {onOpenDelivery && <button type="button" onClick={onOpenDelivery}>进入工程交付</button>}
        </div>
      </header>

      <div className="sync-inspection-desk" data-inspector={inspector && (inspector === "clip" || recordingsAvailable) || undefined}
        style={{ "--sync-inspector-width": `${inspectorWidth}px` } as CSSProperties}>
      <div className="multicam-sync-inspection-canvas" ref={canvasRef}
        style={{ "--sync-preview-height": `${pictureHeight}px` } as CSSProperties}>
        <div className="multicam-sync-monitor">
          <div className="multicam-sync-viewers multicam-sync-angle-grid"
            role="group" aria-label={{ all: "机位分屏", compare: "双机对照画面", single: "单机画面" }[viewKind]} data-view={viewKind}
            style={{ "--sync-grid-columns": gridColumns, "--sync-grid-narrow-columns": Math.min(2, gridColumns) } as CSSProperties}>
            {mountedTracks.map(track => {
              const active = track.track_id === selectedTrackId;
              const item = active ? clip : activeClip(indices.get(track.track_id), position);
              const url = mediaUrl(item);
              return <div key={track.track_id} className="sync-camera-cell" data-camera={track.camera}
                data-listening={active ? "" : undefined} hidden={active && !selectedVisible}
                style={{ "--camera-color": cameraColor(track.camera) } as CSSProperties}>
                <div className="sync-camera-picture">
                  {item && url
                    ? <SyncAnglePreview key={`${item.clip_id}:${item.timeline_start}:${url}`}
                        src={url} sourceTime={sourcePosition(item, position)} playing={playing} muteListening={active && inspector === "audio" && followingRecording} clock={active ? clock : undefined} />
                    : <span className="multicam-sync-angle-placeholder">
                        {item ? "尚未建立无歧义的素材身份" : "此处无片段"}
                      </span>}
                </div>
                <button type="button" className="sync-camera-caption" aria-label={track.camera === "?" ? track.label : `${track.camera} 机`}
                  aria-pressed={active} disabled={!item} onClick={() => selectAngle(track.track_id)}
                  title={item?.name ?? "当前位置无片段"}>
                  <strong>{track.label}</strong>
                  <span>{item?.name ?? "空档"}</span>
                </button>
              </div>;
            })}
            {!displayTracks.length && <div className="multicam-sync-preview-empty">当前母版没有可预览的机位。</div>}
          </div>
          {playbackError && <p role="alert" className="multicam-sync-error">{playbackError}</p>}
        </div>

      <div className="multicam-sync-divider" role="separator" aria-label="调整画面与轨道高度"
        aria-orientation="horizontal" aria-valuemin={minPreviewHeight} aria-valuemax={maxPreviewHeight}
        aria-valuenow={pictureHeight} tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeStart.current = { y: event.clientY, height: pictureHeight };
        }}
        onPointerMove={resizePicture}
        onPointerUp={(event) => {
          if (resizeStart.current) {
            const height = clamp(resizeStart.current.height + event.clientY - resizeStart.current.y,
              minPreviewHeight, maxPreviewHeight);
            setPreviewHeight(height);
            rememberMonitorSize(syncTimeline.project_id, "preview-height", height);
          }
          resizeStart.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { resizeStart.current = null; }}
        onKeyDown={(event) => {
          const next = event.key === "ArrowUp" ? pictureHeight - 16
            : event.key === "ArrowDown" ? pictureHeight + 16
              : event.key === "Home" ? minPreviewHeight : event.key === "End" ? maxPreviewHeight : null;
          if (next === null) return;
          event.preventDefault();
          const height = clamp(next, minPreviewHeight, maxPreviewHeight);
          setPreviewHeight(height);
          rememberMonitorSize(syncTimeline.project_id, "preview-height", height);
        }}><span aria-hidden="true" /></div>
      <SyncTimelineViewport key={`${syncTimeline.project_id}:${compactView}`} timeline={reviewTimeline} rate={rate} frameAccurate={Boolean(confirmedRate)}
        cursor={reviewCursor} trackId={selectedTrack?.track_id ?? ""} playing={playing} canPlay={Boolean(playbackUrl)} onSeek={onSeek} onTogglePlay={togglePlay} />
      </div>
      {inspector && (inspector === "clip" || recordingsAvailable) && <>
        <div className="sync-inspection-grip" role="separator" aria-label="调整检查器宽度" aria-orientation="vertical"
          aria-valuemin={minInspectorWidth} aria-valuemax={maxInspectorWidth} aria-valuenow={inspectorWidth}
          aria-controls={inspectorId} tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            inspectorResizeStart.current = { x: event.clientX, width: inspectorWidth };
          }}
          onPointerMove={(event) => {
            const start = inspectorResizeStart.current;
            if (start) resizeInspector(start.width + start.x - event.clientX, false);
          }}
          onPointerUp={(event) => {
            const start = inspectorResizeStart.current;
            if (start) resizeInspector(start.width + start.x - event.clientX, true);
            inspectorResizeStart.current = null;
          }}
          onLostPointerCapture={() => { inspectorResizeStart.current = null; }}
          onKeyDown={(event) => {
            const width = event.key === "ArrowLeft" ? inspectorWidth + 16
              : event.key === "ArrowRight" ? inspectorWidth - 16
                : event.key === "Home" ? minInspectorWidth : event.key === "End" ? maxInspectorWidth : null;
            if (width === null) return;
            event.preventDefault();
            event.stopPropagation();
            resizeInspector(width, true);
          }} />
        <aside className="sync-inspection-sidebar" id={inspectorId} aria-label="同步检查器" onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); closeInspector(); }
        }}>
          <header>
            <h3>{inspector === "clip" ? "片段信息" : "同期录音"}</h3>
            <button type="button" className="secondary" aria-label="关闭检查器" onClick={closeInspector}>收起</button>
          </header>
          {inspector === "clip" ? <div className="multicam-sync-details">
            {clip ? (
              <dl>
                <dt>文件</dt><dd>{clip.name}</dd>
                <dt>机位 / 拍摄日</dt><dd>{clip.camera} / {clip.day}</dd>
                <dt>母版起点</dt><dd>{secondsLabel(clip.timeline_start)}</dd>
                <dt>片段时长</dt><dd>{secondsLabel(clip.duration)}</dd>
                <dt>目标源内</dt><dd>{sourceTime.toFixed(6)}s</dd>
                <dt>画面源内</dt><dd>{!selectedVisible ? "监听机位未显示" : displayedTime !== null ? `${displayedTime.toFixed(6)}s` : "等待画面"}</dd>
                <dt>定位时间码</dt><dd>{confirmedRate ? timecode(reviewCursor, rate) : `${position.toFixed(3)}s`}</dd>
                {compactView && <><dt>母版时间码</dt><dd>{timecode(cursor, rate)}</dd></>}
                <dt>画面时间码</dt><dd data-testid="sync-presented-frame"
                  data-frame={reviewPresentedFrame}>
                  {!selectedVisible ? "监听机位未显示" : reviewPresentedFrame !== undefined
                    ? confirmedRate ? timecode(reviewPresentedFrame, rate) : `${displayedTime?.toFixed(3)}s`
                    : frameCallbackSupported ? "等待画面定位" : "当前系统未提供显示帧时间"}</dd>
                <dt>原始时码</dt><dd>{clip.timecode || "未记录"}</dd>
                <dt>媒体匹配</dt><dd>{clip.media_clip_id ? "已关联项目媒体身份" : "待核实"}</dd>
              </dl>
            ) : <p>请在时间线选择片段，或移动播放头到有素材的位置。</p>}
            <div className="sync-master-info">
              <span>{syncTimeline.cameras.length ? `${syncTimeline.cameras.join(" / ")} 机位` : "暂无已识别机位"}</span>
              {onMulticamSync && <button type="button" className="secondary" onClick={onMulticamSync}>重新同步</button>}
            </div>
          </div> : baseUrl && syncTimeline.recordings && <SyncRecordingMonitor baseUrl={baseUrl} timeline={syncTimeline}
            cursor={cursor} rate={confirmedRate} playingVideo={playing} onFollowChange={setFollowingRecording}
            onStartVideo={() => { const video = videoRef.current; if (video?.paused) playVideo(video); }}
            onAudition={() => videoRef.current?.pause()} />}
        </aside>
      </>}
      </div>

      {showDelivery ? <div className="multicam-sync-export">
        <div className="multicam-sync-export-heading">
          <div><strong>同步工程 · 已生成文件</strong><p>复用同步引擎的现有导出文件，不需要先完成场记或选片。</p></div>
          <span>外部 NLE 导入仍需实测</span>
        </div>
        {artifacts ? (
          <div className="multicam-sync-export-list">
            {artifacts.artifacts.map((item) => (
              <div className="multicam-sync-export-item" key={item.target}>
                <div><strong>{item.label}</strong><span>{item.format} · {item.filename}</span></div>
                <button type="button" className="secondary"
                  disabled={!item.available || !isTauri() || Boolean(revealBusy)}
                  onClick={() => void reveal(item.local_path, item.target)}
                >{revealBusy === item.target ? "打开中…" : item.available ? "显示工程文件" : syncDeliveryFileLabel(item)}</button>
              </div>
            ))}
          </div>
        ) : <p className="multicam-sync-export-hint">{artifactError ? "读取交付清单失败，请检查 Host 连接。" : "正在检查同步引擎生成的交付文件…"}</p>}
        {artifactError ? <p role="alert" className="multicam-sync-error">{artifactError}</p> : null}
        <p className="multicam-sync-export-hint">多轨可导入不等于原生多机位可切换；剪映版本兼容及四款剪辑软件的实际导入尚未验收。缺少文件时不要把工程标记为已交付。</p>
      </div> : null}
    </section>
  );
}
