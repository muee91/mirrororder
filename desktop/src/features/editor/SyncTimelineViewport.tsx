import interact from "interactjs";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MulticamSyncClip, MulticamSyncTimeline, MulticamSyncTrack, SyncRecordingPlacement } from "../../api/syncTimeline";
import type { FrameRate } from "../../api/timeline";
import { activeClip, boundedWindow, cameraColor, clamp, firstClipFrame, indexClips, parseTimecode, pointerFrame, timecode, toFrame, toSeconds, visibleClips, zoomWindow, type ClipIndex, type FrameWindow } from "./syncTimelineNavigation";
import { framePosition, navigationKey, revealFrame, rulerTicks } from "./timelineViewport";
import { bindTimelineViewportInput } from "./timelineViewportInput";

interface Props {
  timeline: MulticamSyncTimeline;
  rate: FrameRate;
  frameAccurate: boolean;
  cursor: number;
  trackId: string;
  playing: boolean;
  canPlay: boolean;
  onSeek: (frame: number, trackId?: string) => void;
  onTogglePlay: () => void;
  onOpenRecordings?: () => void;
}
const LEVELS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const label = (frame: number, rate: FrameRate, precise: boolean) => precise ? timecode(frame, rate) : `${toSeconds(frame, rate).toFixed(3)}s`;

interface PositionedClip {
  clip: MulticamSyncClip;
  key: string;
  left: number;
  right: number;
  coalesced?: boolean;
}

const CLIP_BUCKET_WIDTH = 0.35;

function coalesceClips(clips: PositionedClip[], activeKey: string, focusedKey: string) {
  if (clips.length <= 260) return clips;
  function groupByBucket(keepWideClips: boolean) {
    const buttons: PositionedClip[] = [];
    let group: PositionedClip | undefined;
    let groupBucket = -1;
    let longestWidth = 0;
    for (const item of clips) {
      const width = item.right - item.left;
      if (item.key === activeKey || item.key === focusedKey || (keepWideClips && width >= CLIP_BUCKET_WIDTH)) {
        buttons.push(item);
        if (keepWideClips) group = undefined;
        continue;
      }
      const bucket = Math.floor(item.left / CLIP_BUCKET_WIDTH);
      if (!group || bucket !== groupBucket) {
        group = { ...item };
        groupBucket = bucket;
        longestWidth = width;
        buttons.push(group);
      } else {
        group.right = Math.max(group.right, item.right);
        group.coalesced = true;
        if (!keepWideClips && width > longestWidth) {
          group.clip = item.clip;
          group.key = item.key;
          longestWidth = width;
        }
      }
    }
    return buttons;
  }
  const buttons = groupByBucket(true);
  // A very dense mix of long and short clips can still overflow one button per visual bucket.
  return buttons.length > 300 ? groupByBucket(false) : buttons;
}

const TrackTickMarks = memo(function TrackTickMarks({ ticks, view }: { ticks: number[]; view: FrameWindow }) {
  return <div className="sync-lane-ticks" aria-hidden="true">{ticks.map(frame => <i key={frame} style={{ left: `${(frame - view.start) / view.span * 100}%` }} />)}</div>;
});

const TrackClipLayer = memo(function TrackClipLayer({ track, index, view, rate, activeClipKey, onSeek }: {
  track: MulticamSyncTrack; index: ClipIndex; view: FrameWindow; rate: FrameRate; activeClipKey: string; onSeek: Props["onSeek"];
}) {
  const positions = useMemo(() => {
    const start = toSeconds(view.start, rate), end = toSeconds(view.start + view.span, rate);
    const percent = (seconds: number) => clamp((seconds * rate.numerator / rate.denominator - view.start) / view.span * 100, 0, 100);
    return visibleClips(index, start, end).map(clip => ({
      clip, key: `${clip.clip_id}:${clip.timeline_start}`, left: percent(clip.timeline_start), right: percent(clip.timeline_start + clip.duration),
    }));
  }, [index, view, rate]);
  // A keyboard-focused button stays mounted even when playback moves into a different bucket.
  const [focusedKey, setFocusedKey] = useState("");
  return coalesceClips(positions, activeClipKey, focusedKey).map(({ clip, key, left, right, coalesced }) => {
    const selected = activeClipKey === key;
    return <button type="button" key={key} draggable={false}
      className={`multicam-sync-clip${coalesced ? " is-coalesced" : ""}${selected ? " is-selected" : ""}`} aria-pressed={selected}
      style={{ left: `${left}%`, width: `${right - left}%` }}
      title={`${clip.name}\n${clip.day} · ${timecode(toFrame(clip.timeline_start, rate), rate)} · ${clip.timecode || "无原始时码"}`}
      onFocus={() => setFocusedKey(key)} onBlur={() => setFocusedKey("")}
      onClick={event => { if (event.detail === 0) onSeek(firstClipFrame(clip.timeline_start, rate), track.track_id); }}>
      <span>{clip.name}</span></button>;
  });
});

const Track = memo(function Track({ track, view, rate, cursor, selected, onSeek, ticks }: {
  track: MulticamSyncTrack; view: FrameWindow; rate: FrameRate; cursor: number; selected: boolean; onSeek: Props["onSeek"]; ticks: number[];
}) {
  const index = useMemo(() => indexClips(track.clips), [track.clips]);
  const active = selected ? activeClip(index, toSeconds(cursor, rate)) : undefined;
  const activeClipKey = active ? `${active.clip_id}:${active.timeline_start}` : "";
  const x = framePosition(cursor, view) * 100;
  return <div className="multicam-sync-track" data-track-id={track.track_id} style={{ "--camera-color": cameraColor(track.camera) } as CSSProperties}>
    <div className="multicam-sync-track-label"><strong>{track.camera}</strong><span title={`${track.clip_count} 个片段`}>{track.clip_count} 段</span></div>
    <div className="multicam-sync-track-lane" aria-label={`${track.label} 同步轨道`}>
      <TrackTickMarks ticks={ticks} view={view} />
      <TrackClipLayer track={track} index={index} view={view} rate={rate} activeClipKey={activeClipKey} onSeek={onSeek} />
      {x >= 0 && x <= 100 ? <span className="multicam-sync-playhead-line" style={{ left: `${x}%` }} aria-hidden="true" /> : null}
    </div>
  </div>;
});

const Overview = memo(function Overview({ timeline }: { timeline: MulticamSyncTimeline }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const draw = () => {
      const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      const row = height / Math.max(1, timeline.tracks.length);
      timeline.tracks.forEach((track, trackIndex) => {
        context.fillStyle = cameraColor(track.camera);
        for (const clip of track.clips) context.fillRect(clip.timeline_start / timeline.duration_seconds * width,
          trackIndex * row, Math.max(0.5, clip.duration / timeline.duration_seconds * width), Math.max(1, row - 1));
      });
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(canvas);
    return () => observer.disconnect();
  }, [timeline]);
  return <canvas ref={ref} className="multicam-sync-overview-map" aria-hidden="true" />;
});

const WavClipLayer = memo(function WavClipLayer({ visible, view, activePlacementKey, onPick }: {
  visible: SyncRecordingPlacement[]; view: FrameWindow; activePlacementKey: number; onPick: (frame: number) => void;
}) {
  return visible.map((item) => {
    const spanFrames = Math.max(1, item.frames);
    const left = clamp((item.at - view.start) / view.span * 100, 0, 100);
    const right = clamp((item.at + spanFrames - view.start) / view.span * 100, 0, 100);
    const active = activePlacementKey >= item.at && activePlacementKey < item.at + spanFrames;
    return <button type="button" key={`${item.media_id}:${item.at}`} draggable={false}
      className={`multicam-sync-clip is-wav-clip${active ? " is-selected" : ""}`}
      style={{ left: `${left}%`, width: `${Math.max(0.4, right - left)}%` }}
      title={`同期 WAV · ${item.name} · 母版第 ${item.at} 帧`}
      onClick={() => onPick(item.at)}><span>{item.name}</span></button>;
  });
});

// All overlapping WAV highlights stay the same until a placement starts or ends.
function lastPlacementBoundary(boundaries: number[], cursor: number) {
  let low = 0, high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (boundaries[middle] <= cursor) low = middle + 1;
    else high = middle;
  }
  return boundaries[low - 1] ?? -Infinity;
}

const WavTrack = memo(function WavTrack({ placements, view, cursor, ticks, onPick }: {
  placements: SyncRecordingPlacement[]; view: FrameWindow; cursor: number; ticks: number[]; onPick: (frame: number) => void;
}) {
  const visible = useMemo(() => placements.filter(item => item.at + Math.max(1, item.frames) > view.start && item.at < view.start + view.span),
    [placements, view]);
  const boundaries = useMemo(() => visible.flatMap(item => [item.at, item.at + Math.max(1, item.frames)]).sort((a, b) => a - b), [visible]);
  const activePlacementKey = lastPlacementBoundary(boundaries, cursor);
  const x = framePosition(cursor, view) * 100;
  return (
    <div className="multicam-sync-track is-wav-track" data-track-role="sync-wav">
      <div className="multicam-sync-track-label">
        <strong>WAV</strong>
        <span title={`${placements.length} 段同期声已上轨`}>{placements.length} 段</span>
      </div>
      <div className="multicam-sync-track-lane is-wav-lane" aria-label="同期录音波形轨">
        <TrackTickMarks ticks={ticks} view={view} />
        <WavClipLayer visible={visible} view={view} activePlacementKey={activePlacementKey} onPick={onPick} />
        {x >= 0 && x <= 100 ? <span className="multicam-sync-playhead-line" style={{ left: `${x}%` }} aria-hidden="true" /> : null}
      </div>
    </div>
  );
});

export function SyncTimelineViewport({ timeline, rate, frameAccurate, cursor, trackId, playing, canPlay, onSeek, onTogglePlay, onOpenRecordings }: Props) {
  const total = Math.max(1, Math.ceil(timeline.duration_seconds * rate.numerator / rate.denominator));
  const initialZoom = LEVELS.filter(level => level <= Math.max(1, timeline.duration_seconds / 600)).at(-1) ?? 1;
  const [view, setView] = useState<FrameWindow>(() => boundedWindow(0, total / initialZoom, total));
  const [width, setWidth] = useState(800);
  const [dragMode, setDragMode] = useState("");
  const [draft, setDraft] = useState(timecode(cursor, rate));
  const editing = useRef(false);
  const [inputError, setInputError] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "seek" | "pan"; x: number; view: FrameWindow; left: number; width: number; track?: string } | null>(null);
  const latest = useRef({ view, cursor, onSeek, total, onOpenRecordings }); latest.current = { view, cursor, onSeek, total, onOpenRecordings };
  const minSpan = Math.max(2, Math.floor(width / 12));
  const zoom = total / view.span;
  const zoomValue = LEVELS.find(level => Math.abs(level - zoom) <= level * 0.00001) ?? zoom;
  const seek = useCallback((frame: number, camera?: string) => {
    latest.current.onSeek(clamp(Math.round(frame), 0, latest.current.total - 1), camera);
  }, []);
  const pickRecording = useCallback((frame: number) => {
    seek(frame);
    latest.current.onOpenRecordings?.();
  }, [seek]);
  useEffect(() => { if (!editing.current) setDraft(timecode(cursor, rate)); }, [cursor, rate]);
  useEffect(() => {
    const current = latest.current.view;
    if (!drag.current && (cursor < current.start || cursor >= current.start + current.span)) {
      setView(revealFrame(cursor, current, total));
    }
  }, [cursor, total]);
  useEffect(() => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const measure = () => setWidth(ruler.clientWidth);
    measure(); if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(ruler);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const surface = surfaceRef.current;
    const ruler = rulerRef.current;
    if (!surface || !ruler) return;
    const target = interact(surface).draggable({ manualStart: true, inertia: false,
      listeners: {
        move(event) {
          const current = drag.current;
          if (!current) return;
          if (current.mode === "pan") setView(boundedWindow(current.view.start - (event.clientX - current.x) / current.width * current.view.span,
            current.view.span, latest.current.total));
          else seek(Math.min(pointerFrame(event.clientX, current.left, current.width, current.view), current.view.start + current.view.span - 1), current.track);
        },
        end() { drag.current = null; setDragMode(""); },
      },
    }).on("down", event => {
      const element: Element | null = event.target instanceof Element ? event.target : null;
      if (!element || element.closest(".multicam-sync-track-label") || !rulerRef.current) return;
      const original = event.originalEvent as MouseEvent;
      if (original.button !== undefined && original.button > 1) return;
      const bounds = rulerRef.current.getBoundingClientRect();
      if (event.clientX < bounds.left) return;
      const mode = original.altKey || original.button === 1 ? "pan" : "seek";
      drag.current = { mode, x: event.clientX, view: latest.current.view, left: bounds.left, width: bounds.width,
        track: element.closest<HTMLElement>("[data-track-id]")?.dataset.trackId };
      setDragMode(mode); surface.focus({ preventScroll: true });
      if (mode === "seek") seek(pointerFrame(event.clientX, bounds.left, bounds.width, latest.current.view), drag.current.track);
      event.interaction.start({ name: "drag" }, target, surface);
      event.preventDefault();
    });
    const detachInput = bindTimelineViewportInput(surface, ruler, () => latest.current, setView);
    return () => { target.unset(); detachInput(); drag.current = null; };
  }, [seek]);
  const zoomBy = (factor: number) => setView(current => zoomWindow(current, factor,
    cursor >= current.start && cursor <= current.start + current.span ? cursor : current.start + current.span / 2, total, minSpan));
  const reveal = (frame: number) => { seek(frame); setView(current => boundedWindow(frame - current.span / 2, current.span, total)); };
  const x = framePosition(cursor, view) * 100;
  const tickFrames = useMemo(() => rulerTicks(view, width), [view, width]);
  return <div className="multicam-sync-timeline-pane">
    <div className="multicam-sync-controls">
      <div className="multicam-sync-time-controls" role="group" aria-label="播放与步进">
        <button type="button" title="后退一秒" aria-label="后退一秒" onClick={() => seek(cursor - toFrame(1, rate))}>−1s</button>
        <button type="button" title="上一帧（←）" aria-label="上一帧" disabled={!frameAccurate} onClick={() => seek(cursor - 1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3v10h1.6V3zm9.5 0L5.6 8l6.9 5z" /></svg>
        </button>
        <button type="button" className="sync-play" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停（空格）" : "播放（空格）"}
          disabled={!canPlay} onClick={onTogglePlay}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d={playing ? "M3.5 3h3v10h-3zm6 0h3v10h-3z" : "M4 2.5v11L13 8z"} /></svg>
        </button>
        <button type="button" title="下一帧（→）" aria-label="下一帧" disabled={!frameAccurate} onClick={() => seek(cursor + 1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 3v10h-1.6V3zm-9.5 0 6.9 5-6.9 5z" /></svg>
        </button>
        <button type="button" title="前进一秒" aria-label="前进一秒" onClick={() => seek(cursor + toFrame(1, rate))}>+1s</button>
      </div>
      <form className="sync-timecode-locator" onSubmit={event => {
        event.preventDefault(); const frame = parseTimecode(draft, rate);
        if (frame === null || frame >= total) { setInputError("请输入母版范围内的 HH:MM:SS:FF 时间码"); return; }
        setInputError(""); editing.current = false; setDraft(timecode(frame, rate)); reveal(frame);
      }}>
        <label htmlFor="sync-timecode" className="sr-only">定位时间码</label>
        <input id="sync-timecode" data-testid="sync-target-frame" data-frame={cursor}
          value={frameAccurate ? draft : label(cursor, rate, false)} disabled={!frameAccurate} spellCheck={false}
          aria-invalid={Boolean(inputError)} aria-describedby={inputError ? "sync-timecode-error" : undefined}
          onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }}
          onChange={event => { setDraft(event.target.value); setInputError(""); }} />
        <button type="submit" disabled={!frameAccurate}>定位</button>
        <span className="sync-rate">{frameAccurate ? `${Number((rate.numerator / rate.denominator).toFixed(3))} fps${rate.denominator !== 1 ? " · 非丢帧" : ""}` : "时间基待确认"}</span>
        {inputError && <span id="sync-timecode-error" role="alert">{inputError}</span>}
      </form>
      <div className="sync-zoom-controls" role="group" aria-label="时间线视图">
        <button type="button" aria-label="缩小时间线" title="缩小时间线" onClick={() => zoomBy(0.5)}>−</button>
        <label className="sr-only" htmlFor="multicam-sync-zoom">时间轴缩放</label>
        <select id="multicam-sync-zoom" value={zoomValue} onChange={event => setView(current => zoomWindow(current, Number(event.target.value) / zoom, cursor, total, minSpan))}>
          {!LEVELS.includes(zoomValue) ? <option value={zoom}>{zoom.toFixed(1)}×</option> : null}
          {LEVELS.map(level => <option value={level} key={level}>{level}×</option>)}
        </select>
        <button type="button" aria-label="放大时间线" title="放大时间线" onClick={() => zoomBy(2)}>+</button>
        <button type="button" onClick={() => reveal(cursor)}>回到播放头</button>
      </div>
    </div>
    <div className="multicam-sync-overview" aria-label="同步母版全局总览">
      <label htmlFor="multicam-sync-cursor">全局总览</label>
      <div className="sync-overview-map">
        <Overview timeline={timeline} />
        <span className="sync-overview-window" style={{ left: `${view.start / total * 100}%`, width: `${view.span / total * 100}%` }} />
        <span className="sync-overview-playhead" style={{ left: `${cursor / total * 100}%` }} />
        <input id="multicam-sync-cursor" type="range" min="0" max={toSeconds(total - 1, rate)}
          step={rate.denominator / rate.numerator} value={toSeconds(cursor, rate)}
          aria-label="同步母版播放头" aria-valuetext={label(cursor, rate, frameAccurate)}
          onChange={event => reveal(toFrame(Number(event.target.value), rate))} />
      </div>
      <span>{label(total - 1, rate, frameAccurate)}</span>
    </div>
    <div ref={surfaceRef} className={`multicam-sync-track-list sync-working-surface${dragMode ? ` is-${dragMode}` : ""}`} tabIndex={0} aria-label="机位工作轨道" title="方向键逐帧，Shift 快移，Alt 拖动平移，触摸板捏合或 ⌘／Ctrl 加滚轮缩放"
      data-playing={playing} data-view-start={view.start} data-view-end={view.start + view.span}
      onKeyDown={event => {
        if ((event.target as Element).closest("input, select, textarea, [contenteditable=true]")) return;
        // Clip buttons retain native Space/Enter activation; arrows navigate the focused track.
        if ((event.target as Element).closest("button") && (event.key === " " || event.key === "Enter")) return;
        const action = navigationKey(event, cursor, total, frameAccurate);
        if (action) {
          event.preventDefault();
          if (action.type === "seek") seek(action.frame);
          if (action.type === "zoom") zoomBy(action.factor);
          if (action.type === "pan") setView(current => boundedWindow(current.start + current.span / 2 * action.direction, current.span, total));
        }
        if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey && canPlay) {
          event.preventDefault(); onTogglePlay();
        }
      }}>
      <div className="multicam-sync-ruler"><span>机位</span>
        <div className="sync-working-ruler" ref={rulerRef} role="slider" aria-label="局部播放头" tabIndex={0}
          aria-valuemin={0} aria-valuemax={total - 1} aria-valuenow={cursor} aria-valuetext={label(cursor, rate, frameAccurate)}>
          {tickFrames.map(frame => <span key={frame} title={`${frame}f`} style={{ left: `${(frame - view.start) / view.span * 100}%`,
            transform: (frame - view.start) / view.span * width < 50 ? "none" : (frame - view.start) / view.span * width > width - 50 ? "translateX(-100%)" : undefined }}>{label(frame, rate, frameAccurate)}</span>)}
          {x >= 0 && x <= 100 ? <i className="sync-playhead-grip" style={{ left: `${x}%` }} aria-hidden="true"><svg viewBox="0 0 12 16"><path d="M1 1h10v8l-5 6-5-6Z" /></svg></i> : null}
        </div>
      </div>
      {timeline.tracks.map(track => <Track key={track.track_id} track={track} view={view} rate={rate} cursor={cursor} selected={track.track_id === trackId} onSeek={seek} ticks={tickFrames} />)}
      {timeline.recordings?.placements?.length ? <WavTrack placements={timeline.recordings.placements} view={view}
        cursor={cursor} ticks={tickFrames} onPick={pickRecording} /> : null}
    </div>
  </div>;
}
