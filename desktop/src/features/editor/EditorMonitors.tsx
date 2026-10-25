import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnection, HostConnectionError } from "../../api/host";
import { ProductionClient, type WaveformPayload } from "../../api/production";
import type { TimelineClip, TimelineProject, TimelineSequence, TimelineSource } from "../../api/timeline";
import {
  isEditableKeyboardTarget,
  programMediaAtPlayhead,
  selectedSourceState,
  sequenceFps,
  videoClipAtPlayhead,
} from "./editorPlayback";
import "./editor-monitors.css";

export interface SourceMonitorPreview {
  source: TimelineSource;
  frame: number;
  rangeStart: number;
  rangeEnd: number;
}

interface Props {
  baseUrl: string;
  projectId: string;
  project: TimelineProject;
  sequence: TimelineSequence;
  selectedClip: TimelineClip | null;
  sourcePreview?: SourceMonitorPreview | null;
  playhead: number;
  onPlayheadChange: (frame: number) => void;
  onStepFrames: (frames: number) => void;
  onSourceFrameChange?: (frame: number) => void;
}

type TransportDirection = -1 | 0 | 1;

function waveformPath(peaks: number[]): string {
  if (!peaks.length) return "";
  const width = Math.max(1, peaks.length - 1);
  const upper = peaks.map((peak, index) => `${(index / width) * 1000},${50 - Math.max(0, Math.min(1, peak)) * 46}`);
  const lower = [...peaks].reverse().map((peak, reverseIndex) => {
    const index = peaks.length - reverseIndex - 1;
    return `${(index / width) * 1000},${50 + Math.max(0, Math.min(1, peak)) * 46}`;
  });
  return `M${upper.join(" L")} L${lower.join(" L")} Z`;
}

function monitorLabel(frame: number, fps: number): string {
  return `${frame}f · ${(frame / fps).toFixed(2)}s`;
}

function waveformError(error: unknown): string {
  if (error instanceof HostConnectionError && error.status === 404) return "当前素材尚未生成波形缓存";
  return error instanceof Error ? error.message : String(error);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function EditorMonitors({
  baseUrl,
  projectId,
  project,
  sequence,
  selectedClip,
  sourcePreview = null,
  playhead,
  onPlayheadChange,
  onStepFrames,
  onSourceFrameChange,
}: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const programVideoRef = useRef<HTMLVideoElement>(null);
  const [direction, setDirection] = useState<TransportDirection>(0);
  const [waveform, setWaveform] = useState<WaveformPayload | null>(null);
  const [waveformMessage, setWaveformMessage] = useState("选择时间线片段或素材后读取波形");
  const [waveformBusy, setWaveformBusy] = useState(false);

  const fps = sequenceFps(sequence);
  const sourceState = useMemo(() => {
    if (sourcePreview) {
      const frame = Math.max(sourcePreview.rangeStart, Math.min(sourcePreview.rangeEnd, Math.round(sourcePreview.frame)));
      return { source: sourcePreview.source, sourceSeconds: frame / fps, sourceFrame: frame };
    }
    const current = selectedSourceState(project, sequence, selectedClip);
    return current ? { ...current, sourceFrame: selectedClip?.source_in ?? 0 } : null;
  }, [fps, project, selectedClip, sequence, sourcePreview]);
  const programLocated = useMemo(() => videoClipAtPlayhead(sequence, playhead), [playhead, sequence]);
  const programAnglePending = Boolean(programLocated?.clip.multicam_group_id && !programLocated.clip.selected_angle_source_id);
  const programState = useMemo(() => programMediaAtPlayhead(project, sequence, playhead), [playhead, project, sequence]);
  const sourceUrl = sourceState?.source.clip_id ? host.mediaUrl(projectId, sourceState.source.clip_id) : "";
  const programUrl = programState?.source.clip_id ? host.mediaUrl(projectId, programState.source.clip_id) : "";
  const waveformClipId = sourceState?.source.clip_id ?? "";

  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    if (!waveformClipId) {
      setWaveformMessage("选择时间线片段或素材后读取波形");
      return () => { cancelled = true; };
    }
    setWaveformMessage("正在读取波形缓存…");
    void production.waveform(projectId, waveformClipId, 640)
      .then((payload) => {
        if (cancelled) return;
        setWaveform(payload);
        setWaveformMessage(payload.peaks.length ? `波形缓存 · ${payload.peaks.length} 个采样峰值` : "当前媒体没有可读取音频");
      })
      .catch((error: unknown) => {
        if (!cancelled) setWaveformMessage(waveformError(error));
      });
    return () => { cancelled = true; };
  }, [production, projectId, waveformClipId]);

  async function refreshWaveform(): Promise<void> {
    if (!waveformClipId || waveformBusy) return;
    setWaveformBusy(true);
    setWaveformMessage("正在刷新波形缓存…");
    try {
      const payload = await production.waveform(projectId, waveformClipId, 640);
      setWaveform(payload);
      setWaveformMessage(payload.peaks.length ? `波形缓存 · ${payload.peaks.length} 个采样峰值` : "当前媒体没有可读取音频");
    } catch (error) {
      setWaveform(null);
      setWaveformMessage(waveformError(error));
    } finally {
      setWaveformBusy(false);
    }
  }

  async function buildWaveform(): Promise<void> {
    if (!waveformClipId || waveformBusy) return;
    setWaveformBusy(true);
    setWaveformMessage("正在提交波形生成任务…");
    try {
      const payload = await production.buildWaveform(projectId, waveformClipId, 640);
      if (payload.task.type && payload.task.type !== "waveform_build") {
        setWaveformMessage(`波形生成返回未知任务类型：${payload.task.type}`);
        return;
      }
      setWaveformMessage("波形生成已提交到状态中心；完成后点“刷新”读取缓存。");
    } catch (error) {
      setWaveformMessage(waveformError(error));
    } finally {
      setWaveformBusy(false);
    }
  }

  useEffect(() => {
    const video = sourceVideoRef.current;
    if (!video || !sourceState) return;
    const seek = () => {
      if (Math.abs(video.currentTime - sourceState.sourceSeconds) > 0.04) video.currentTime = Math.max(0, sourceState.sourceSeconds);
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [sourceState]);

  useEffect(() => {
    const video = programVideoRef.current;
    if (!video || !programState) return;
    const seek = () => {
      if (Math.abs(video.currentTime - programState.sourceSeconds) > Math.max(0.02, 0.75 / fps)) video.currentTime = Math.max(0, programState.sourceSeconds);
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [fps, programState]);

  useEffect(() => {
    if (direction === 0) return;
    const step = Math.max(1, Math.round(fps / 12));
    const timer = globalThis.setInterval(() => onStepFrames(direction * step), 80);
    return () => globalThis.clearInterval(timer);
  }, [direction, fps, onStepFrames]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j" || event.key === "J") {
        event.preventDefault(); setDirection(-1);
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault(); setDirection(0);
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault(); setDirection(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault(); setDirection(0); onStepFrames(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); setDirection(0); onStepFrames(1);
      } else if (event.key === " ") {
        event.preventDefault(); setDirection((current) => current === 0 ? 1 : 0);
      }
    };
    globalThis.addEventListener("keydown", handleKey);
    return () => globalThis.removeEventListener("keydown", handleKey);
  }, [onStepFrames]);

  function reportSourceFrame(video: HTMLVideoElement): void {
    if (!sourcePreview || !onSourceFrameChange) return;
    const rawFrame = Math.round(video.currentTime * fps);
    const bounded = Math.max(sourcePreview.rangeStart, Math.min(sourcePreview.rangeEnd, rawFrame));
    if (bounded !== rawFrame) {
      video.currentTime = bounded / fps;
      video.pause();
    }
    onSourceFrameChange(bounded);
  }

  const waveformProgress = sourcePreview && sourceState
    ? clampPercent((sourceState.sourceFrame / Math.max(1, sourceState.source.duration_frames ?? sourcePreview.rangeEnd)) * 100)
    : selectedClip && playhead >= selectedClip.timeline_start && playhead <= selectedClip.timeline_start + selectedClip.duration
      ? clampPercent(((playhead - selectedClip.timeline_start) / Math.max(1, selectedClip.duration)) * 100)
      : null;

  return (
    <section className="editor-monitors production-panel">
      <div className="monitor-grid">
        <article className="editor-monitor">
          <header><strong>素材监看</strong><span>{sourceState ? monitorLabel(sourceState.sourceFrame, fps) : "未选择素材"}</span></header>
          {sourceUrl && sourceState ? (
            <video ref={sourceVideoRef} src={sourceUrl} controls preload="metadata" key={`source-${sourceState.source.source_id}`} onTimeUpdate={(event) => reportSourceFrame(event.currentTarget)} onSeeked={(event) => reportSourceFrame(event.currentTarget)} />
          ) : <div className="monitor-empty">选择素材池或时间线片段查看原始素材。</div>}
          <footer>{sourceState?.source.name || sourceState?.source.clip_id || "—"}</footer>
        </article>

        <article className="editor-monitor program-monitor">
          <header><strong>节目监看</strong><span>{monitorLabel(playhead, fps)}</span></header>
          {programUrl && programState ? (
            <video ref={programVideoRef} src={programUrl} muted playsInline preload="metadata" key={`program-${programState.source.source_id}`} />
          ) : (
            <div className="monitor-empty">{programAnglePending ? "当前多机位片段机位待选；在右侧片段检查器明确选择 A/B/C 后预览。" : "当前播放头没有启用的视频片段。"}</div>
          )}
          <footer>{programAnglePending && programLocated ? `${programLocated.clip.metadata.segment_id || programLocated.clip.clip_id} · 机位待选` : programState ? `${programState.clip.metadata.segment_id || programState.clip.clip_id} · ${programState.source.name || programState.source.clip_id}` : "—"}</footer>
        </article>
      </div>

      <div className="proxy-transport" aria-label="代理播放控制">
        <button type="button" className={direction === -1 ? "is-active" : ""} onClick={() => setDirection(-1)} title="J">J ◀</button>
        <button type="button" onClick={() => { setDirection(0); onStepFrames(-1); }} title="←">−1f</button>
        <button type="button" className={direction === 0 ? "is-active" : ""} onClick={() => setDirection(0)} title="K">K ■</button>
        <button type="button" onClick={() => { setDirection(0); onStepFrames(1); }} title="→">+1f</button>
        <button type="button" className={direction === 1 ? "is-active" : ""} onClick={() => setDirection(1)} title="L">L ▶</button>
        <label>播放头 <input type="number" min={0} value={playhead} onChange={(event) => onPlayheadChange(Math.max(0, Math.round(Number(event.target.value) || 0)))} /></label>
        <span>WebView 代理播放 · 原生音视频时钟门控尚未启用</span>
      </div>

      <div className="waveform-strip">
        <div className="waveform-heading"><strong>音频波形</strong><div className="waveform-heading-actions"><span>{waveformMessage}</span><button type="button" disabled={!waveformClipId || waveformBusy} onClick={() => void refreshWaveform()}>刷新</button><button type="button" disabled={!waveformClipId || waveformBusy} onClick={() => void buildWaveform()}>生成波形</button></div></div>
        {waveform?.peaks.length ? (
          <div className="waveform-canvas"><svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`${waveform.peaks.length} 个波形峰值`}><path d={waveformPath(waveform.peaks)} /></svg>{waveformProgress !== null ? <i className="waveform-playhead" style={{ left: `${waveformProgress}%` }} /> : null}</div>
        ) : <div className="waveform-empty">{waveformMessage}</div>}
      </div>
    </section>
  );
}
