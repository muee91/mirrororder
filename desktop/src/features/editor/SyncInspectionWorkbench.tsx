import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ProductionClient, type AssistantSelection, type WaveformPayload } from "../../api/production";
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
import { closeDetailsMenu, handleDetailsMenuBlur, handleDetailsMenuToggle } from "../../components/detailsMenuDismiss";
import {
  activeClip, cameraColor, clamp, compactSyncTimeline, confirmedSyncRate, firstClipFrame, indexClips,
  indexReviewGaps, timecode, toFrame, toMasterFrame, toReviewFrame, toSeconds,
} from "./syncTimelineNavigation";
const MILLISECOND_GRID = { numerator: 1000, denominator: 1 };
type SplitView = { kind: "all" };
type MonitorView = SplitView | { kind: "single"; trackId: string; previous: SplitView };

interface Props {
  syncTimeline: MulticamSyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  showDelivery?: boolean;
  onOpenDelivery?: () => void;
  onOpenSyncTask?: () => void;
  onInspectSelection?: (selection: AssistantSelection) => void;
  onTimelineUpdated?: () => void;
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

export function SyncInspectionWorkbench({ syncTimeline, baseUrl, onMulticamSync, showDelivery = true, onOpenDelivery, onOpenSyncTask, onInspectSelection, onTimelineUpdated }: Props) {
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
  const [splitPanAudition, setSplitPanAudition] = useState(false);
  const [nudgeDraft, setNudgeDraft] = useState(0);
  const [nudgeScope, setNudgeScope] = useState<"single" | "following" | "track">("single");
  const [nudgeBusy, setNudgeBusy] = useState(false);
  const [nudgeMessage, setNudgeMessage] = useState("");
  const [clipWaveform, setClipWaveform] = useState<WaveformPayload | null>(null);
  const [waveformState, setWaveformState] = useState<"idle" | "loading" | "missing" | "building" | "ready">("idle");
  const [waveformNote, setWaveformNote] = useState("");
  const waveformPollRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const waveformTokenRef = useRef(0);
  const cancelWaveformPoll = useCallback(() => {
    waveformTokenRef.current += 1;
    if (waveformPollRef.current !== null) {
      globalThis.clearTimeout(waveformPollRef.current);
      waveformPollRef.current = null;
    }
  }, []);
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
  const productionClient = useMemo(() => baseUrl ? new ProductionClient(baseUrl) : null, [baseUrl]);
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
  const displayTracks = useMemo(() => {
    if (monitorView.kind === "all") return tracks;
    const ids = monitorView.kind === "single" ? [monitorView.trackId] : tracks.map(track => track.track_id);
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

  useEffect(() => {
    cancelWaveformPoll();
    if (inspector !== "clip" || !productionClient || !clip?.media_clip_id) {
      setClipWaveform(null);
      setWaveformState("idle");
      setWaveformNote("");
      return cancelWaveformPoll;
    }
    let cancelled = false;
    setWaveformState("loading");
    setWaveformNote("");
    void productionClient.waveform(syncTimeline.project_id, clip.media_clip_id, 256)
      .then((payload) => {
        if (cancelled) return;
        if (payload.peaks?.length) {
          setClipWaveform(payload);
          setWaveformState("ready");
        } else {
          setClipWaveform(null);
          setWaveformState("missing");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setClipWaveform(null);
        setWaveformState("missing");
      });
    return () => {
      cancelled = true;
      cancelWaveformPoll();
    };
  }, [cancelWaveformPoll, inspector, productionClient, syncTimeline.project_id, clip?.media_clip_id]);

  async function requestClipWaveform(): Promise<void> {
    if (!productionClient || !clip?.media_clip_id || waveformState === "building") return;
    cancelWaveformPoll();
    const token = waveformTokenRef.current;
    const projectId = syncTimeline.project_id;
    const mediaClipId = clip.media_clip_id;
    setWaveformState("building");
    setWaveformNote("正在生成实时声波，完成后将自动显示…");
    try {
      await productionClient.buildWaveform(projectId, mediaClipId, 256);
      if (token !== waveformTokenRef.current) return;
      const poll = (attempt: number) => {
        if (token !== waveformTokenRef.current) return;
        void productionClient.waveform(projectId, mediaClipId, 256)
          .then((payload) => {
            if (token !== waveformTokenRef.current) return;
            if (payload.peaks?.length) {
              setClipWaveform(payload);
              setWaveformState("ready");
              setWaveformNote("");
              return;
            }
            if (attempt >= 25) {
              setWaveformNote("声波仍在后台提取中，可点击「刷新波形」继续查看。");
              return;
            }
            waveformPollRef.current = globalThis.setTimeout(() => poll(attempt + 1), 1200);
          })
          .catch(() => {
            if (token !== waveformTokenRef.current) return;
            if (attempt >= 25) {
              setWaveformNote("声波仍在后台提取中，可点击「刷新波形」继续查看。");
              return;
            }
            waveformPollRef.current = globalThis.setTimeout(() => poll(attempt + 1), 1200);
          });
      };
      waveformPollRef.current = globalThis.setTimeout(() => poll(0), 1000);
    } catch (error) {
      if (token !== waveformTokenRef.current) return;
      setWaveformState("missing");
      setWaveformNote(error instanceof Error ? error.message : "无法提交波形生成任务");
    }
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

  function toggleSingleAngle(id: string): void {
    selectAngle(id);
    setMonitorView(current => current.kind === "single" && current.trackId === id
      ? current.previous
      : { kind: "single", trackId: id, previous: current.kind === "single" ? current.previous : current });
  }

  // Pro-editor shortcuts: 1-6 switch camera angle, J/K/L shuttle/pause/play
  const editorKeysRef = useRef({ tracks, selectAngle, togglePlay, onSeek, cursor, rate, playing });
  editorKeysRef.current = { tracks, selectAngle, togglePlay, onSeek, cursor, rate, playing };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector("dialog[open], .semantic-search-palette")) return;
      const el = event.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable=true]")) return;
      const current = editorKeysRef.current;
      if (/^[1-6]$/.test(event.key)) {
        const targetTrack = current.tracks[Number(event.key) - 1];
        if (targetTrack) {
          event.preventDefault();
          current.selectAngle(targetTrack.track_id);
        }
        return;
      }
      const lower = event.key.toLowerCase();
      if (lower === "k") {
        if (current.playing) { event.preventDefault(); current.togglePlay(); }
      } else if (lower === "l") {
        if (!current.playing) { event.preventDefault(); current.togglePlay(); }
      } else if (lower === "j") {
        event.preventDefault();
        current.onSeek(current.cursor - toFrame(1, current.rate));
      }
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, []);

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

  async function commitOffset(targetKind: "clip" | "recording"): Promise<void> {
    if (!baseUrl || !nudgeDraft || nudgeBusy) return;
    setNudgeBusy(true);
    setNudgeMessage("");
    try {
      const client = new SyncTimelineClient(baseUrl);
      const firstRecording = syncTimeline.recordings?.placements.find(p => cursor >= p.at && cursor < p.at + p.frames)
        ?? syncTimeline.recordings?.placements[0];
      await client.applyOffset(syncTimeline.project_id, {
        target_kind: targetKind,
        scope: nudgeScope,
        delta_frames: nudgeDraft,
        track_id: selectedTrackId || undefined,
        clip_id: clip?.clip_id || undefined,
        media_id: firstRecording?.media_id || undefined,
        expected_revision: syncTimeline.offset_revision ?? 0,
      });
      setNudgeDraft(0);
      setNudgeMessage(`已保存修正版 r${(syncTimeline.offset_revision ?? 0) + 1}（不覆盖旧交付文件）`);
      onTimelineUpdated?.();
    } catch (reason) {
      setNudgeMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNudgeBusy(false);
    }
  }

  async function undoLastOffset(): Promise<void> {
    if (!baseUrl || nudgeBusy || !(syncTimeline.offset_revision ?? 0)) return;
    setNudgeBusy(true);
    setNudgeMessage("");
    try {
      await new SyncTimelineClient(baseUrl).undoOffset(syncTimeline.project_id, syncTimeline.offset_revision ?? 0);
      setNudgeDraft(0);
      setNudgeMessage("已回退上一版人工偏移修正");
      onTimelineUpdated?.();
    } catch (reason) {
      setNudgeMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setNudgeBusy(false);
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
          {showDelivery ? <h2>同步母版</h2> : null}
          <span>{syncTimeline.cameras.length} 机位 · {syncTimeline.clip_count.toLocaleString()} 个片段</span>
          {selectedTrack && <span className="sync-monitor-listening">监听 {selectedTrack.label}</span>}
        </div>
        <div className="multicam-sync-inspection-meta">
          {viewKind === "single" && <button type="button" className="secondary" onClick={() => setMonitorView({ kind: "all" })}>返回全部机位</button>}
          <details className="sync-more-menu"
            onToggle={handleDetailsMenuToggle}
            onBlur={handleDetailsMenuBlur}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.removeAttribute("open");
              event.currentTarget.querySelector("summary")?.focus();
            }}>
            <summary aria-label="更多同步检查选项">⋯</summary>
            <div className="sync-more-menu-popover">
              <button type="button" className="secondary sync-inspector-toggle" ref={clipInspectorButton}
                aria-expanded={inspector === "clip"} aria-controls={inspector === "clip" ? inspectorId : undefined}
                onClick={(event) => { closeDetailsMenu(event.currentTarget); setInspector(current => current === "clip" ? null : "clip"); }}>手动微调偏移…</button>
              {recordingsAvailable && <button type="button" className="secondary sync-inspector-toggle" ref={audioInspectorButton}
                aria-expanded={inspector === "audio"} aria-controls={inspector === "audio" ? inspectorId : undefined}
                onClick={(event) => { closeDetailsMenu(event.currentTarget); setInspector(current => current === "audio" ? null : "audio"); }}>同期录音监听</button>}
              {reviewGaps.length > 0 && <button type="button" className="sync-gap-toggle secondary" aria-pressed={compactView}
                title="只去除所有机位都停拍的间隙" onClick={(event) => { closeDetailsMenu(event.currentTarget); toggleGaps(); }}>{compactView ? "显示原始停拍间隙" : "自动收紧停拍间隙"}</button>}
              {onOpenSyncTask && <button type="button" className="secondary" onClick={(event) => { closeDetailsMenu(event.currentTarget); onOpenSyncTask(); }}>查看同步进度与重新同步</button>}
            </div>
          </details>
          {onOpenDelivery && <button type="button" className="sync-delivery-cta" onClick={onOpenDelivery}>导出到剪辑软件…</button>}
        </div>
      </header>

      <div className="sync-inspection-desk" data-inspector={inspector && (inspector === "clip" || recordingsAvailable) || undefined}
        style={{ "--sync-inspector-width": `${inspectorWidth}px` } as CSSProperties}>
      <div className="multicam-sync-inspection-canvas" ref={canvasRef}
        style={{ "--sync-preview-height": `${pictureHeight}px` } as CSSProperties}>
        <div className="multicam-sync-monitor">
          <div className="multicam-sync-viewers multicam-sync-angle-grid"
            role="group" aria-label={{ all: "机位分屏", single: "单机画面" }[viewKind]}
            data-view={viewKind}
            style={{ "--sync-grid-columns": gridColumns, "--sync-grid-narrow-columns": Math.min(2, gridColumns) } as CSSProperties}>
            {mountedTracks.map(track => {
              const active = track.track_id === selectedTrackId;
              const item = active ? clip : activeClip(indices.get(track.track_id), position);
              const url = mediaUrl(item);
              return <div key={track.track_id} className="sync-camera-cell" data-camera={track.camera}
                data-listening={active ? "" : undefined} hidden={active && !selectedVisible}
                onDoubleClick={() => { if (item) toggleSingleAngle(track.track_id); }}
                style={{ "--camera-color": cameraColor(track.camera) } as CSSProperties}>
                <div className="sync-camera-picture">
                  {item && url
                    ? <SyncAnglePreview key={`${item.clip_id}:${item.timeline_start}:${url}`}
                        src={url} sourceTime={sourcePosition(item, position)} playing={playing}
                        muteListening={active && inspector === "audio" && followingRecording && !splitPanAudition}
                        panLeft={active && inspector === "audio" && followingRecording && splitPanAudition}
                        clock={active ? clock : undefined} />
                    : <span className="multicam-sync-angle-placeholder">
                        {item ? "尚未建立无歧义的素材身份" : "此处无片段"}
                      </span>}
                </div>
                <button type="button" className="sync-camera-caption" aria-label={track.camera === "?" ? track.label : `${track.camera} 机`}
                  aria-pressed={active} disabled={!item} onClick={() => selectAngle(track.track_id)}
                  title={item ? `${item.name}（双击放大/还原）` : "当前位置无片段"}>
                  <strong>{track.label}</strong>
                  <span>{item?.name ?? "空档"}</span>
                  {active && <em className="sync-tally-pill" aria-hidden="true">{playing ? "LIVE" : "监听"}</em>}
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
        cursor={reviewCursor} trackId={selectedTrack?.track_id ?? ""} playing={playing} canPlay={Boolean(playbackUrl)}
        onSeek={onSeek} onTogglePlay={togglePlay}
        onOpenRecordings={recordingsAvailable ? () => setInspector("audio") : undefined} />
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
              <>
              <dl className="sync-clip-summary">
                <dt>文件</dt><dd>{clip.name}</dd>
                <dt>机位 / 拍摄日</dt><dd>{clip.camera} / {clip.day}</dd>
                <dt>片段时长</dt><dd>{secondsLabel(clip.duration)}</dd>
              </dl>
              {baseUrl ? (
                <section className="sync-offset-card" aria-label="帧级偏移修正">
                  <div className="sync-offset-head">
                    <strong>帧级偏移修正</strong>
                    <span>修正版 r{syncTimeline.offset_revision ?? 0}</span>
                  </div>
                  <div className="sync-offset-nudge" role="group" aria-label="增减帧偏移">
                    <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => setNudgeDraft(v => v - 5)}>−5f</button>
                    <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => setNudgeDraft(v => v - 1)}>−1f</button>
                    <span className="sync-offset-readout" data-dirty={nudgeDraft !== 0 || undefined}>{nudgeDraft > 0 ? `+${nudgeDraft}f` : `${nudgeDraft}f`}</span>
                    <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => setNudgeDraft(v => v + 1)}>+1f</button>
                    <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => setNudgeDraft(v => v + 5)}>+5f</button>
                  </div>
                  <label className="sync-offset-scope">
                    <span>传播范围</span>
                    <select value={nudgeScope} disabled={nudgeBusy} onChange={(e) => setNudgeScope(e.target.value as "single" | "following" | "track")}>
                      <option value="single">仅当前片段</option>
                      <option value="following">同机位此后全部（解决换电池漂移）</option>
                      <option value="track">整条机位轨道统一偏移</option>
                    </select>
                  </label>
                  <div className="sync-offset-actions">
                    <button type="button" disabled={nudgeBusy || nudgeDraft === 0} onClick={() => void commitOffset("clip")}>
                      {nudgeBusy ? "保存中…" : `保存为 r${(syncTimeline.offset_revision ?? 0) + 1}`}
                    </button>
                    {nudgeDraft !== 0 ? <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => setNudgeDraft(0)}>清零</button> : null}
                    {(syncTimeline.offset_revision ?? 0) > 0 ? <button type="button" className="secondary" disabled={nudgeBusy} onClick={() => void undoLastOffset()}>撤销上一版</button> : null}
                  </div>
                  {nudgeMessage ? <p className="sync-offset-status" role="status">{nudgeMessage}</p> : null}
                </section>
              ) : null}
              <details className="sync-debug-telemetry">
                <summary>技术时间码详情</summary>
                <dl>
                  <dt>母版起点</dt><dd>{secondsLabel(clip.timeline_start)}</dd>
                  <dt>目标源内</dt><dd>{sourceTime.toFixed(6)}s</dd>
                  <dt>画面源内</dt><dd>{!selectedVisible ? "监听机位未显示" : displayedTime !== null ? `${displayedTime.toFixed(6)}s` : "等待画面"}</dd>
                  <dt>定位时间码</dt><dd>{confirmedRate ? timecode(reviewCursor, rate) : `${position.toFixed(3)}s`}</dd>
                  {compactView && <><dt>母版时间码</dt><dd>{timecode(cursor, rate)}</dd></>}
                  <dt>画面时间码</dt><dd data-testid="sync-presented-frame" data-frame={reviewPresentedFrame}>
                    {!selectedVisible ? "监听机位未显示" : reviewPresentedFrame !== undefined
                      ? confirmedRate ? timecode(reviewPresentedFrame, rate) : `${displayedTime?.toFixed(3)}s`
                      : frameCallbackSupported ? "等待画面定位" : "当前系统未提供显示帧时间"}</dd>
                  <dt>原始时码</dt><dd>{clip.timecode || "未记录"}</dd>
                  <dt>媒体匹配</dt><dd>{clip.media_clip_id ? "已关联项目媒体身份" : "待核实"}</dd>
                </dl>
              </details>
              </>
            ) : <p>请在时间线选择片段，或移动播放头到有素材的位置。</p>}
            {baseUrl && clip ? (
              <section className="sync-waveform-card" aria-label="声波峰值对齐预览">
                <div className="sync-offset-head">
                  <strong>音频声波峰值</strong>
                  <span>{waveformState === "ready" && clipWaveform ? `${clipWaveform.peaks.length} 采样点` : waveformState === "loading" ? "读取缓存…" : "按需生成"}</span>
                </div>
                {waveformState === "ready" && clipWaveform && clipWaveform.peaks.length > 0 ? (
                  <div
                    className="sync-waveform-canvas"
                    role="button"
                    tabIndex={0}
                    aria-label="点击声波跳转到对应位置"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      if (rect.width <= 0) return;
                      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
                      const targetSec = clip.timeline_start + ratio * clip.duration;
                      const targetMasterFrame = toFrame(targetSec, rate);
                      onSeek(compactView ? toReviewFrame(targetMasterFrame, reviewGaps) : targetMasterFrame);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        togglePlay();
                      }
                    }}
                  >
                    <svg viewBox={`0 0 ${clipWaveform.peaks.length} 48`} preserveAspectRatio="none" aria-hidden="true">
                      <line x1="0" y1="24" x2={clipWaveform.peaks.length} y2="24" className="sync-waveform-centerline" />
                      {clipWaveform.peaks.map((peak, index) => {
                        const half = Math.max(1, Math.min(22, peak * 22));
                        return (
                          <line
                            key={index}
                            x1={index + 0.5}
                            x2={index + 0.5}
                            y1={24 - half}
                            y2={24 + half}
                            className={peak > 0.72 ? "sync-waveform-bar is-transient" : "sync-waveform-bar"}
                          />
                        );
                      })}
                    </svg>
                    <span
                      className="sync-waveform-playhead"
                      style={{ left: `${clamp((sourceTime / Math.max(0.01, clip.duration)) * 100, 0, 100)}%` }}
                    />
                  </div>
                ) : (
                  <div className="sync-waveform-empty">
                    <span>{waveformNote || (clip.media_clip_id ? "尚未缓存该片段声波，点击后通过后台任务生成（不阻塞检视）。" : "该片段尚未关联项目媒体 ID。")}</span>
                    {clip.media_clip_id ? (
                      <div className="sync-waveform-actions">
                        <button type="button" className="secondary" disabled={waveformState === "building"} onClick={() => void requestClipWaveform()}>
                          {waveformState === "building" ? "已提交任务…" : "生成实时声波"}
                        </button>
                        {waveformState === "building" ? (
                          <button type="button" className="secondary" onClick={() => {
                            if (!productionClient || !clip.media_clip_id) return;
                            void productionClient.waveform(syncTimeline.project_id, clip.media_clip_id, 256)
                              .then((payload) => { if (payload.peaks?.length) { setClipWaveform(payload); setWaveformState("ready"); setWaveformNote(""); } })
                              .catch(() => { setWaveformNote("波形仍在后台生成中，请稍候再试。"); });
                          }}>刷新波形</button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
            <div className="sync-master-info">
              <span>{syncTimeline.cameras.length ? `${syncTimeline.cameras.join(" / ")} 机位` : "暂无已识别机位"}</span>
              {onMulticamSync && <button type="button" className="secondary" onClick={onMulticamSync}>重新同步</button>}
            </div>
          </div> : baseUrl && syncTimeline.recordings && <SyncRecordingMonitor baseUrl={baseUrl} timeline={syncTimeline}
            cursor={cursor} rate={confirmedRate} playingVideo={playing} onFollowChange={setFollowingRecording}
            onSplitPanChange={setSplitPanAudition}
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
