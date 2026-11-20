import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HostConnection } from "../../api/host";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import type { FrameRate } from "../../api/timeline";
import { recordingForMasterFrame, recordingKey, recordingSecondsAtMasterFrame, shouldSeekRecording } from "./syncRecordingClock";

interface Props {
  baseUrl: string;
  timeline: MulticamSyncTimeline;
  cursor: number;
  rate: FrameRate | null;
  playingVideo: boolean;
  onAudition: () => void;
  onStartVideo?: () => void;
  onFollowChange?: (following: boolean) => void;
}

export function SyncRecordingMonitor({ baseUrl, timeline, cursor, rate, playingVideo, onAudition, onStartVideo, onFollowChange }: Props) {
  const recordings = timeline.recordings!;
  const [preferredKey, setPreferredKey] = useState("");
  const [followVideo, setFollowVideo] = useState(false);
  const [error, setError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  const followRef = useRef(false);
  const starting = useRef(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const placement = useMemo(
    () => recordingForMasterFrame(recordings.placements, cursor, preferredKey, followVideo),
    [recordings.placements, cursor, preferredKey, followVideo],
  );
  const sourceSeconds = recordingSecondsAtMasterFrame(placement, cursor, rate);
  const taskId = timeline.task?.task_id || "";
  const playback = useMemo(() => taskId && placement && rate
    ? new HostConnection(baseUrl).mediaUrl(timeline.project_id, "sync-recording:" + placement.media_id)
      + "?sync_task_id=" + encodeURIComponent(taskId)
    : "", [baseUrl, timeline.project_id, taskId, placement, rate]);

  function setFollow(next: boolean): void {
    followRef.current = next;
    setFollowVideo(next);
    onFollowChange?.(next);
    setError("");
    if (!next) player.current?.pause();
  }

  const beginAudio = useCallback((audio: HTMLAudioElement) => {
    if (starting.current) return;
    starting.current = true;
    try {
      void Promise.resolve(audio.play()).catch((reason: unknown) => {
        if (audio !== player.current || (reason instanceof DOMException && reason.name === "AbortError")) return;
        followRef.current = false;
        setFollowVideo(false);
        onFollowChange?.(false);
        setError(reason instanceof DOMException && reason.name === "NotAllowedError"
          ? "系统阻止了自动播放。可点击下方录音播放器授权，或独立试听。"
          : "同期录音未能跟随画面播放。可切换为独立试听。");
      }).finally(() => { starting.current = false; });
    } catch {
      starting.current = false;
      followRef.current = false;
      setFollowVideo(false);
      onFollowChange?.(false);
      setError("同期录音未能启动。请检查本机媒体。");
    }
  }, [onFollowChange]);

  useEffect(() => {
    if (!followVideo) return;
    const audio = player.current;
    if (!audio) return;
    if (sourceSeconds === null) { audio.pause(); return; }
    if (audio.readyState < 1) return;
    const end = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.000001) : sourceSeconds;
    const wanted = Math.min(sourceSeconds, end);
    if (shouldSeekRecording(audio.currentTime, wanted, playingVideo)) audio.currentTime = wanted;
    if (!playingVideo) {
      if (!audio.paused) audio.pause();
    } else if (audio.paused) beginAudio(audio);
  }, [followVideo, sourceSeconds, playingVideo, playback, beginAudio]);

  useEffect(() => () => {
    player.current?.pause();
    onFollowChange?.(false);
  }, [onFollowChange]);

  function openLinkedMode(): void {
    if (!rate || !playback) return;
    setFollow(true);
    const audio = player.current;
    if (audio && sourceSeconds !== null) {
      if (audio.readyState >= 1) audio.currentTime = sourceSeconds;
      if (!playingVideo) onStartVideo?.();
      // Starting both media elements in one user gesture also works on WebViews
      // that reject an effect-triggered audio.play() as autoplay.
      beginAudio(audio);
    }
  }

  const hasRecordedTime = Boolean(rate);
  return <div className="sync-recording-monitor multicam-sync-details">
    <p>{recordings.candidate_count} 条已发现 · {recordings.unplaced_count} 条未上轨
      {recordings.invalid_count > 0 && " · " + recordings.invalid_count + " 条空文件或无法读取"}</p>
    {recordings.placements.length > 0 && <label>
      监听录音
      <select aria-label="监听录音" value={placement ? recordingKey(placement) : ""} onChange={(event) => {
        setError("");
        setPreferredKey(event.target.value);
      }}>
        <option value="">选择已上轨录音</option>
        {recordings.placements.map((row) =>
          <option key={recordingKey(row)} value={recordingKey(row)}>{row.name} · 母版第 {row.at} 帧</option>)}
      </select>
    </label>}
    {recordings.placements.length === 0 && <p role="status">当前母版尚无可试听的同期声上轨片段。</p>}
    {recordings.placements.length > 0 && <div className="sync-recording-mode" role="group" aria-label="同期录音试听模式">
      <button type="button" aria-pressed={!followVideo} onClick={() => setFollow(false)}>独立试听</button>
      <button type="button" aria-pressed={followVideo} disabled={!hasRecordedTime || !playback}
        onClick={openLinkedMode}>跟随画面</button>
    </div>}
    {playback && <>
      <audio ref={player} key={playback + ":" + String(placement?.at) + ":" + String(loadKey)} src={playback}
        preload="metadata" controls aria-label="同期录音播放器"
        onLoadedMetadata={(event) => {
          if (!followRef.current || sourceSeconds === null) return;
          event.currentTarget.currentTime = sourceSeconds;
          if (playingVideo) beginAudio(event.currentTarget);
        }}
        onPlay={() => {
          if (followRef.current && !playingVideo && !starting.current) {
            setFollow(false);
            onAudition();
          } else if (!followRef.current) onAudition();
        }}
        onError={() => {
          if (followRef.current) setFollow(false);
          setError("无法读取当前设备上的同期 WAV。");
        }} />
      <button type="button" className="secondary" disabled={sourceSeconds === null}
        onClick={() => { if (player.current && sourceSeconds !== null) player.current.currentTime = sourceSeconds; }}>
        定位到画面播放头
      </button>
    </>}
    <p className="sync-recording-status" role="status">
      {!hasRecordedTime ? "母版时间基未确认，暂时只能独立试听。"
        : followVideo && sourceSeconds === null ? "当前播放头没有已上轨的同期声，移动到有效区间后将自动跟随。"
          : followVideo ? "跟随画面播放与暂停；机内声音暂时静音。"
            : "独立试听不会修改同步母版。选择跟随画面可同时听看核对。"}
    </p>
    {error && <p role="alert">{error} <button className="secondary" type="button" onClick={() => {
      setError("");
      setLoadKey(value => value + 1);
    }}>重新加载</button></p>}
  </div>;
}
