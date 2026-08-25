import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnection } from "../../api/host";
import { ProductionClient, type WaveformPayload } from "../../api/production";
import type { TimelineClip, TimelineProject, TimelineSequence } from "../../api/timeline";
import {
  isEditableKeyboardTarget,
  programMediaAtPlayhead,
  selectedSourceState,
  sequenceFps,
} from "./editorPlayback";
import "./editor-monitors.css";

interface Props {
  baseUrl: string;
  projectId: string;
  project: TimelineProject;
  sequence: TimelineSequence;
  selectedClip: TimelineClip | null;
  playhead: number;
  onPlayheadChange: (frame: number) => void;
  onStepFrames: (frames: number) => void;
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

export function EditorMonitors({
  baseUrl,
  projectId,
  project,
  sequence,
  selectedClip,
  playhead,
  onPlayheadChange,
  onStepFrames,
}: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const programVideoRef = useRef<HTMLVideoElement>(null);
  const [direction, setDirection] = useState<TransportDirection>(0);
  const [waveform, setWaveform] = useState<WaveformPayload | null>(null);
  const [waveformMessage, setWaveformMessage] = useState("选择 Timeline clip 后读取 waveform");

  const fps = sequenceFps(sequence);
  const sourceState = useMemo(
    () => selectedSourceState(project, sequence, selectedClip),
    [project, selectedClip, sequence],
  );
  const programState = useMemo(
    () => programMediaAtPlayhead(project, sequence, playhead),
    [playhead, project, sequence],
  );
  const sourceUrl = sourceState?.source.clip_id ? host.mediaUrl(projectId, sourceState.source.clip_id) : "";
  const programUrl = programState?.source.clip_id ? host.mediaUrl(projectId, programState.source.clip_id) : "";
  const waveformClipId = sourceState?.source.clip_id ?? "";

  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    if (!waveformClipId) {
      setWaveformMessage("选择 Timeline clip 后读取 waveform");
      return () => { cancelled = true; };
    }
    setWaveformMessage("正在准备本机 waveform…");
    void production.waveform(projectId, waveformClipId, 640)
      .then((payload) => {
        if (cancelled) return;
        setWaveform(payload);
        setWaveformMessage(payload.peaks.length ? `waveform.v1 · ${payload.peaks.length} peaks` : "当前媒体没有可读取音频");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setWaveformMessage(message);
      });
    return () => { cancelled = true; };
  }, [production, projectId, waveformClipId]);

  useEffect(() => {
    const video = sourceVideoRef.current;
    if (!video || !sourceState) return;
    const seek = () => {
      if (Math.abs(video.currentTime - sourceState.sourceSeconds) > 0.04) {
        video.currentTime = Math.max(0, sourceState.sourceSeconds);
      }
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [sourceState]);

  useEffect(() => {
    const video = programVideoRef.current;
    if (!video || !programState) return;
    const seek = () => {
      if (Math.abs(video.currentTime - programState.sourceSeconds) > Math.max(0.02, 0.75 / fps)) {
        video.currentTime = Math.max(0, programState.sourceSeconds);
      }
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
        event.preventDefault();
        setDirection(-1);
      } else if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        setDirection(0);
      } else if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        setDirection(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setDirection(0);
        onStepFrames(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setDirection(0);
        onStepFrames(1);
      } else if (event.key === " ") {
        event.preventDefault();
        setDirection((current) => current === 0 ? 1 : 0);
      }
    };
    globalThis.addEventListener("keydown", handleKey);
    return () => globalThis.removeEventListener("keydown", handleKey);
  }, [onStepFrames]);

  const waveformProgress = selectedClip && playhead >= selectedClip.timeline_start && playhead <= selectedClip.timeline_start + selectedClip.duration
    ? Math.max(0, Math.min(100, ((playhead - selectedClip.timeline_start) / Math.max(1, selectedClip.duration)) * 100))
    : null;

  return (
    <section className="editor-monitors production-panel">
      <div className="monitor-grid">
        <article className="editor-monitor">
          <header><strong>Source Monitor</strong><span>{selectedClip ? monitorLabel(selectedClip.source_in, fps) : "未选择 source"}</span></header>
          {sourceUrl && sourceState ? (
            <video ref={sourceVideoRef} src={sourceUrl} controls preload="metadata" key={`source-${sourceState.source.source_id}`} />
          ) : <div className="monitor-empty">选择一个 Timeline clip 查看原始 source。</div>}
          <footer>{sourceState?.source.name || sourceState?.source.clip_id || "—"}</footer>
        </article>

        <article className="editor-monitor program-monitor">
          <header><strong>Program Monitor</strong><span>{monitorLabel(playhead, fps)}</span></header>
          {programUrl && programState ? (
            <video ref={programVideoRef} src={programUrl} muted playsInline preload="metadata" key={`program-${programState.source.source_id}`} />
          ) : <div className="monitor-empty">当前 playhead 没有启用的视频 clip。</div>}
          <footer>{programState ? `${programState.clip.metadata.segment_id || programState.clip.clip_id} · ${programState.source.name || programState.source.clip_id}` : "—"}</footer>
        </article>
      </div>

      <div className="proxy-transport" aria-label="Proxy transport controls">
        <button type="button" className={direction === -1 ? "is-active" : ""} onClick={() => setDirection(-1)} title="J">J ◀</button>
        <button type="button" onClick={() => { setDirection(0); onStepFrames(-1); }} title="←">−1f</button>
        <button type="button" className={direction === 0 ? "is-active" : ""} onClick={() => setDirection(0)} title="K">K ■</button>
        <button type="button" onClick={() => { setDirection(0); onStepFrames(1); }} title="→">+1f</button>
        <button type="button" className={direction === 1 ? "is-active" : ""} onClick={() => setDirection(1)} title="L">L ▶</button>
        <label>
          Playhead
          <input type="number" min={0} value={playhead} onChange={(event) => onPlayheadChange(Math.max(0, Math.round(Number(event.target.value) || 0)))} />
        </label>
        <span>WebView proxy transport · native A/V clock gate 尚未启用</span>
      </div>

      <div className="waveform-strip">
        <div className="waveform-heading"><strong>Waveform</strong><span>{waveformMessage}</span></div>
        {waveform?.peaks.length ? (
          <div className="waveform-canvas">
            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`${waveform.peaks.length} waveform peaks`}>
              <path d={waveformPath(waveform.peaks)} />
            </svg>
            {waveformProgress !== null ? <i className="waveform-playhead" style={{ left: `${waveformProgress}%` }} /> : null}
          </div>
        ) : <div className="waveform-empty">{waveformMessage}</div>}
      </div>
    </section>
  );
}
