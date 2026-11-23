import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HostConnection } from "../../api/host";
import { SyncTimelineClient, type MulticamSyncTimeline, type SyncRecordingCandidate } from "../../api/syncTimeline";
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
  onSplitPanChange?: (split: boolean) => void;
  onTimelineUpdated?: () => void;
}

export function SyncRecordingMonitor({ baseUrl, timeline, cursor, rate, playingVideo, onAudition, onStartVideo, onFollowChange, onSplitPanChange, onTimelineUpdated }: Props) {
  const recordings = timeline.recordings!;
  const candidates = recordings.candidates ?? [];
  const [preferredKey, setPreferredKey] = useState("");
  const [candidateKey, setCandidateKey] = useState("");
  const [followVideo, setFollowVideo] = useState(false);
  const [splitPan, setSplitPan] = useState(false);
  const [error, setError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  const [confirming, setConfirming] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const followRef = useRef(false);
  const starting = useRef(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const pannerRef = useRef<{ ctx: AudioContext; panner: StereoPannerNode; el: HTMLAudioElement } | null>(null);
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

  function setFollow(next: boolean, nextSplit = false): void {
    followRef.current = next;
    setFollowVideo(next);
    setSplitPan(next && nextSplit);
    onFollowChange?.(next);
    onSplitPanChange?.(next && nextSplit);
    setError("");
    if (!next) player.current?.pause();
  }

  // Apply Web Audio StereoPannerNode (+1 right ear) in split-pan mode with safe fallback
  useEffect(() => {
    const audio = player.current;
    if (!audio) return;
    if (!splitPan) {
      if (pannerRef.current && pannerRef.current.el === audio) {
        pannerRef.current.panner.pan.value = 0;
      }
      return;
    }
    try {
      const AudioCtx = globalThis.AudioContext || (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!pannerRef.current || pannerRef.current.el !== audio) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaElementSource(audio);
        const panner = ctx.createStereoPanner();
        source.connect(panner).connect(ctx.destination);
        pannerRef.current = { ctx, panner, el: audio };
      }
      if (pannerRef.current.ctx.state === "suspended") void pannerRef.current.ctx.resume().catch(() => undefined);
      pannerRef.current.panner.pan.value = 1;
    } catch {
      // Fallback: continue normal playback if Web Audio routing is unavailable.
    }
  }, [splitPan, playback]);

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
    onSplitPanChange?.(false);
    if (pannerRef.current) {
      void pannerRef.current.ctx.close().catch(() => undefined);
      pannerRef.current = null;
    }
  }, [onFollowChange, onSplitPanChange]);

  function openLinkedMode(enableSplit = false): void {
    if (!rate || !playback) return;
    setFollow(true, enableSplit);
    const audio = player.current;
    if (audio && sourceSeconds !== null) {
      if (audio.readyState >= 1) audio.currentTime = sourceSeconds;
      if (!playingVideo) onStartVideo?.();
      // Starting both media elements in one user gesture also works on WebViews
      // that reject an effect-triggered audio.play() as autoplay.
      beginAudio(audio);
    }
  }

  async function confirmCandidate(candidate: SyncRecordingCandidate): Promise<void> {
    if (!rate || confirming) return;
    setConfirming(candidate.media_id);
    setConfirmError("");
    try {
      await new SyncTimelineClient(baseUrl).confirmRecordingPlacement(timeline.project_id, {
        media_id: candidate.media_id,
        at: cursor,
        source: 0,
        expected_revision: recordings.alignment_revision ?? 0,
      });
      onTimelineUpdated?.();
    } catch (reason) {
      setConfirmError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConfirming("");
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
    {candidates.some(candidate => candidate.status === "unverified_candidate" && !recordings.placements.some(item => item.media_id === candidate.media_id)) && <section className="sync-recording-candidates" aria-label="待确认录音">
      <label>
        待确认录音
        <select aria-label="待确认录音" value={candidateKey} onChange={(event) => setCandidateKey(event.target.value)}>
          <option value="">选择待确认 WAV</option>
          {candidates.filter(candidate => candidate.status === "unverified_candidate" && !recordings.placements.some(item => item.media_id === candidate.media_id)).map(candidate =>
            <option key={candidate.media_id} value={`candidate:${candidate.media_id}`}>{candidate.name}</option>)}
        </select>
      </label>
      {candidateKey.startsWith("candidate:") && (() => {
        const candidate = candidates.find(item => `candidate:${item.media_id}` === candidateKey);
        return candidate ? <button type="button" disabled={Boolean(confirming) || !rate} onClick={() => void confirmCandidate(candidate)}>
          {confirming === candidate.media_id ? "保存中…" : "放到播放头"}
        </button> : null;
      })()}
      {confirmError && <p role="alert">{confirmError}</p>}
    </section>}
    {recordings.placements.length > 0 && <div className="sync-recording-mode" role="group" aria-label="同期录音试听模式">
      <button type="button" aria-pressed={!followVideo} onClick={() => setFollow(false, false)}>独立试听</button>
      <button type="button" aria-pressed={followVideo && !splitPan} disabled={!hasRecordedTime || !playback}
        onClick={() => openLinkedMode(false)}>跟随画面</button>
      <button type="button" aria-pressed={followVideo && splitPan} disabled={!hasRecordedTime || !playback}
        title="左耳放机内参考音、右耳放同期 WAV，1 帧误差立刻可听出相位回声"
        onClick={() => openLinkedMode(true)}>声相分裂</button>
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
          : followVideo && splitPan ? "声相分裂监听中：左声道机内参考音 / 右声道同期 WAV；对齐瞬间声音会聚回正中干声。"
            : followVideo ? "跟随画面播放与暂停；机内声音暂时静音。"
              : "独立试听不会修改同步母版。选择跟随画面或声相分裂可精准对口型。"}
    </p>
    {error && <p role="alert">{error} <button className="secondary" type="button" onClick={() => {
      setError("");
      setLoadKey(value => value + 1);
    }}>重新加载</button></p>}
  </div>;
}
