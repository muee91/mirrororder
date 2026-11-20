import { useEffect, useRef, useState } from "react";
import { HostConnection } from "../../api/host";
import type { MulticamSyncTimeline, SyncRecordingPlacement } from "../../api/syncTimeline";
import type { FrameRate } from "../../api/timeline";

interface Props {
  baseUrl: string;
  timeline: MulticamSyncTimeline;
  cursor: number;
  rate: FrameRate | null;
  playingVideo: boolean;
  onAudition: () => void;
}

export function SyncRecordingMonitor({ baseUrl, timeline, cursor, rate, playingVideo, onAudition }: Props) {
  const recordings = timeline.recordings!;
  const [selection, setSelection] = useState<SyncRecordingPlacement | null>(null);
  const [error, setError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  const player = useRef<HTMLAudioElement>(null);
  const taskId = timeline.task?.task_id;
  const placement = selection && recordings.placements.find((row) => row.media_id === selection.media_id && row.at === selection.at);
  const frame = placement && rate && cursor >= placement.at && cursor < placement.at + placement.frames
    ? placement.source + cursor - placement.at : null;
  const playback = taskId && placement && rate
    ? new HostConnection(baseUrl).mediaUrl(timeline.project_id, `sync-recording:${placement.media_id}`)
      + `?sync_task_id=${encodeURIComponent(taskId)}`
    : "";

  useEffect(() => {
    if (playingVideo) player.current?.pause();
  }, [playingVideo]);

  return <details className="sync-recording-monitor" onToggle={(event) => {
    if (!event.currentTarget.open) player.current?.pause();
  }}>
    <summary>同期录音 <span>{recordings.placements.length}</span></summary>
    <div className="multicam-sync-details">
      <strong>同期录音核对</strong>
      <p>{recordings.candidate_count} 条已发现 · {recordings.unplaced_count} 条未上轨
        {recordings.invalid_count > 0 && ` · ${recordings.invalid_count} 条空文件或无法读取`}</p>
      {recordings.placements.length > 0 && <label>
        监听录音
        <select value={placement ? `${placement.media_id}:${placement.at}` : ""} onChange={(event) => {
          setError("");
          setSelection(recordings.placements.find((row) => `${row.media_id}:${row.at}` === event.target.value) ?? null);
        }}>
          <option value="">选择一段已上轨录音</option>
          {recordings.placements.map(row => (
            <option key={`${row.media_id}:${row.at}`} value={`${row.media_id}:${row.at}`}>{row.name} · 母版第 {row.at} 帧</option>
          ))}
        </select>
      </label>}
      {playback && !error && <>
        <audio ref={player} key={`${playback}:${placement?.at}:${loadKey}`} src={playback} preload="metadata" controls
          onPlay={onAudition} onError={() => setError("无法读取当前设备上的同期 WAV。")} />
        <button type="button" className="secondary" disabled={frame === null}
          onClick={() => {
            const audio = player.current;
            if (audio && rate && frame !== null) audio.currentTime = frame * rate.denominator / rate.numerator;
          }}>定位到播放头</button>
      </>}
      {error && <p role="alert">{error} <button className="secondary" type="button" onClick={() => {
        setError(""); setLoadKey(value => value + 1);
      }}>重新加载</button></p>}
    </div>
  </details>;
}
