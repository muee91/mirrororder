import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload } from "../../api/host";
import { ProductionClient, type RoughCutPlan } from "../../api/production";
import {
  TimelineBridgeError,
  TimelineClient,
  type FrameRate,
  type TimelineClip,
  type TimelineCommand,
  type TimelineRuntimeStatus,
  type TimelineSnapshot,
  type TimelineTrack,
} from "../../api/timeline";
import { EditorMonitors } from "./EditorMonitors";
import { clampPlayhead } from "./editorPlayback";
import { buildRoughCutTimelineProposal } from "./timelineSeed";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof TimelineBridgeError) {
    const detail = error.issues[0]?.message;
    return detail ? `${error.message}：${detail}` : error.message;
  }
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function activeSequence(snapshot: TimelineSnapshot | null) {
  if (!snapshot) return null;
  return snapshot.project.sequences.find((sequence) => sequence.sequence_id === snapshot.project.active_sequence_id)
    ?? snapshot.project.sequences[0]
    ?? null;
}

function findClip(snapshot: TimelineSnapshot | null, clipId: string): { track: TimelineTrack; clip: TimelineClip } | null {
  const sequence = activeSequence(snapshot);
  if (!sequence) return null;
  for (const track of sequence.tracks) {
    const clip = track.clips.find((item) => item.clip_id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

function frameLabel(value: number): string {
  return `${value}f`;
}

function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function TimelineWorkbench({ baseUrl, projectId }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [plan, setPlan] = useState<RoughCutPlan | null>(null);
  const [snapshot, setSnapshot] = useState<TimelineSnapshot | null>(null);
  const [persistence, setPersistence] = useState<TimelineRuntimeStatus | null>(null);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [moveStart, setMoveStart] = useState(0);
  const [rateNumerator, setRateNumerator] = useState("");
  const [rateDenominator, setRateDenominator] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取粗剪计划…");

  const refreshPersistence = useCallback(async (): Promise<void> => {
    if (!isTauri()) return;
    try {
      setPersistence(await timeline.persistenceStatus());
    } catch {
      setPersistence(null);
    }
  }, [timeline]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setPersistence(null);
    setSelectedClipId("");
    setPlayhead(0);
    setRateNumerator("");
    setRateDenominator("");
    setMessage("正在读取粗剪计划…");
    Promise.all([host.reviewModel(projectId), production.roughCutPlan(projectId)])
      .then(([nextReview, nextPlan]) => {
        if (cancelled) return;
        setReview(nextReview);
        setPlan(nextPlan);
        const timebase = nextPlan.timebase;
        if (
          timebase?.status === "confirmed"
          && Number.isSafeInteger(timebase.numerator)
          && Number.isSafeInteger(timebase.denominator)
          && Number(timebase.numerator) > 0
          && Number(timebase.denominator) > 0
        ) {
          setRateNumerator(String(timebase.numerator));
          setRateDenominator(String(timebase.denominator));
          setMessage(`粗剪计划已读取 · ${nextPlan.readiness} · 时间基 ${timebase.numerator}/${timebase.denominator}`);
        } else {
          setMessage("粗剪计划已读取 · 当前来源没有可证明的时间基，请确认项目帧率后再建立时间线。");
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(errorMessage(error));
      });

    if (isTauri()) {
      timeline.openPersisted(projectId).then((current) => {
        if (cancelled) return;
        setSnapshot(current);
        const firstClip = activeSequence(current)?.tracks.flatMap((track) => track.clips)[0] ?? null;
        setSelectedClipId(firstClip?.clip_id ?? "");
        setPlayhead(firstClip?.timeline_start ?? 0);
        void timeline.persistenceStatus().then((status) => {
          if (!cancelled) setPersistence(status);
        }).catch(() => undefined);
      }).catch((error: unknown) => {
        if (cancelled) return;
        const text = errorMessage(error);
        if (!text.includes("还没有持久化 Timeline")) {
          setMessage(`时间线恢复失败：${text}`);
        }
      });
    }

    return () => { cancelled = true; };
  }, [host, production, projectId, timeline]);

  const frameRate = useMemo<FrameRate | null>(() => {
    const numerator = positiveInteger(rateNumerator);
    const denominator = positiveInteger(rateDenominator);
    return numerator && denominator ? { numerator, denominator } : null;
  }, [rateDenominator, rateNumerator]);
  const proposal = useMemo(
    () => review && plan && frameRate ? buildRoughCutTimelineProposal(review, plan, frameRate) : null,
    [frameRate, plan, review],
  );
  const timebaseDetected = plan?.timebase?.status === "confirmed";
  const sequence = activeSequence(snapshot);
  const selection = findClip(snapshot, selectedClipId);
  const maxEnd = Math.max(1, ...(sequence?.tracks.flatMap((track) => track.clips.map((clip) => clip.timeline_start + clip.duration)) ?? [1]));
  const selectedMulticamGroupId = selection?.clip.multicam_group_id ?? null;
  const selectedMulticam = selectedMulticamGroupId
    ? snapshot?.project.multicam_groups.find((group) => group.group_id === selectedMulticamGroupId) ?? null
    : null;

  const changePlayhead = useCallback((frame: number) => {
    if (!sequence) {
      setPlayhead(Math.max(0, Math.round(frame)));
      return;
    }
    setPlayhead(clampPlayhead(sequence, frame));
  }, [sequence]);

  const stepPlayhead = useCallback((frames: number) => {
    setPlayhead((current) => sequence ? clampPlayhead(sequence, current + frames) : Math.max(0, current + frames));
  }, [sequence]);

  async function confirmProposal(): Promise<void> {
    if (!proposal) {
      setMessage("需要先确认有效时间基，才能建立时间线。");
      return;
    }
    if (!isTauri()) {
      setMessage("浏览器预览可以检查粗剪提议；建立本机时间线需要在桌面 App 中执行。");
      return;
    }
    setBusy(true);
    setMessage("正在建立本机时间线…");
    try {
      const next = await timeline.loadWithCommands(proposal.baseProject, proposal.commands);
      setSnapshot(next);
      const firstClip = activeSequence(next)?.tracks.flatMap((track) => track.clips)[0] ?? null;
      setSelectedClipId(firstClip?.clip_id ?? "");
      setPlayhead(firstClip?.timeline_start ?? 0);
      await refreshPersistence();
      setMessage(`时间线已建立并保存 · ${proposal.commands.length} 段人工确认素材已加入`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function apply(command: TimelineCommand, success: string): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.apply(command);
      setSnapshot(next);
      await refreshPersistence();
      setMessage(success);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function undo(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.undo();
      setSnapshot(next);
      await refreshPersistence();
      setMessage(`已撤销 · 还可撤销 ${next.undo_depth} 步`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  async function redo(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.redo();
      setSnapshot(next);
      await refreshPersistence();
      setMessage(`已重做 · 当前可撤销 ${next.undo_depth} 步`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  async function checkpoint(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.checkpoint();
      setSnapshot(next);
      await refreshPersistence();
      setMessage("当前时间线已安全保存。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function splitSelected(): void {
    if (!selection) return;
    const { clip } = selection;
    if (playhead <= clip.timeline_start || playhead >= clip.timeline_start + clip.duration) {
      setMessage("切分位置必须严格位于当前片段内部。");
      return;
    }
    void apply({
      type: "split",
      sequence_id: sequence?.sequence_id ?? "main",
      clip_id: clip.clip_id,
      position: playhead,
      right_clip_id: `${clip.clip_id}:split:${playhead}`,
    }, `已在 ${frameLabel(playhead)} 切分 ${clip.clip_id}`);
  }

  return (
    <section className="timeline-workbench">
      <header className="production-heading timeline-heading">
        <div>
          <p className="eyebrow">粗剪提议与本机编辑</p>
          <h2>剪辑时间线</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="timeline-proposal production-panel">
        <div className="timeline-proposal-heading">
          <div>
            <p className="eyebrow">人工确认后建立时间线</p>
            <strong>{proposal?.included.length ?? 0} 段可加入 · {proposal?.skipped.length ?? 0} 段保持人工待决</strong>
          </div>
          <div className="timeline-fps" title={timebaseDetected ? `来自 ${plan?.timebase?.source ?? "项目"}` : "当前来源没有权威时间基，需要人工确认"}>
            <span>时间基 {timebaseDetected ? "· 项目识别" : "· 请确认"}</span>
            <label>分子 <input type="number" min={1} max={120000} value={rateNumerator} placeholder="24000" onChange={(event) => setRateNumerator(event.target.value)} /></label>
            <label>分母 <input type="number" min={1} max={10000} value={rateDenominator} placeholder="1001" onChange={(event) => setRateDenominator(event.target.value)} /></label>
          </div>
          <button type="button" disabled={busy || !proposal || proposal.commands.length === 0} onClick={() => void confirmProposal()}>确认建立时间线</button>
        </div>
        {!frameRate ? <div className="proposal-warnings"><span>未确认时间基，不会生成或提交时间线提议。</span></div> : null}
        <div className="proposal-warnings">
          {(proposal?.warnings ?? []).map((warning) => <span key={warning}>{warning}</span>)}
        </div>
        {proposal?.skipped.length ? (
          <details>
            <summary>查看未自动进入时间线的 {proposal.skipped.length} 个剧本段</summary>
            <div className="proposal-skipped">
              {proposal.skipped.slice(0, 30).map((row) => <span key={row.segmentId}><code>{row.segmentId}</code> · {row.status} · {row.reason}</span>)}
            </div>
          </details>
        ) : null}
      </div>

      {snapshot && sequence ? (
        <>
          <div className="timeline-toolbar production-panel">
            <div className="timeline-history">
              <button type="button" className="secondary" disabled={busy || snapshot.undo_depth === 0} onClick={() => void undo()}>撤销 {snapshot.undo_depth}</button>
              <button type="button" className="secondary" disabled={busy || snapshot.redo_depth === 0} onClick={() => void redo()}>重做 {snapshot.redo_depth}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void checkpoint()}>立即保存</button>
            </div>
            <label>播放头 <input type="number" min={0} value={playhead} onChange={(event) => changePlayhead(Number(event.target.value) || 0)} /></label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "set_marker", sequence_id: sequence.sequence_id, marker: { marker_id: `marker:${playhead}`, position: playhead, label: `Marker ${playhead}` } }, `已设置标记 @ ${frameLabel(playhead)}`)}>标记</button>
            <span>
              {sequence.frame_rate.numerator}/{sequence.frame_rate.denominator} fps · {snapshot.validation.length ? `${snapshot.validation.length} 个结构问题` : "结构检查通过"}
              {persistence?.used_backup ? " · 已从备份恢复" : persistence?.recovered_operations ? ` · 已恢复 ${persistence.recovered_operations} 步编辑` : ""}
            </span>
          </div>

          <EditorMonitors
            baseUrl={baseUrl}
            projectId={projectId}
            project={snapshot.project}
            sequence={sequence}
            selectedClip={selection?.clip ?? null}
            playhead={playhead}
            onPlayheadChange={changePlayhead}
            onStepFrames={stepPlayhead}
          />

          <div className="timeline-stage production-panel">
            {sequence.tracks.map((track) => (
              <div className="timeline-track" key={track.track_id}>
                <div className="track-label"><strong>{track.track_id}</strong><span>{track.kind}</span></div>
                <div className="track-lane">
                  {track.clips.map((clip) => (
                    <button
                      type="button"
                      className={`timeline-clip ${clip.clip_id === selectedClipId ? "is-selected" : ""} ${clip.enabled ? "" : "is-disabled"}`}
                      key={clip.clip_id}
                      style={{ left: `${(clip.timeline_start / maxEnd) * 100}%`, width: `${Math.max(1.5, (clip.duration / maxEnd) * 100)}%` }}
                      onClick={() => { setSelectedClipId(clip.clip_id); setMoveStart(clip.timeline_start); changePlayhead(clip.timeline_start); }}
                      title={`${clip.clip_id}\n${clip.timeline_start}–${clip.timeline_start + clip.duration}f`}
                    >
                      <strong>{clip.metadata.segment_id || clip.clip_id}</strong>
                      <span>{frameLabel(clip.duration)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {sequence.markers.length ? <div className="timeline-marker-list">{sequence.markers.map((marker) => <span key={marker.marker_id}>{frameLabel(marker.position)} · {marker.label}</span>)}</div> : null}
          </div>

          <aside className="timeline-inspector production-panel">
            {selection ? (
              <>
                <div className="parse-heading">
                  <div><p className="eyebrow">当前片段</p><strong>{selection.clip.clip_id}</strong></div>
                  <span>{selection.track.track_id}</span>
                </div>
                <div className="timeline-clip-facts">
                  <span>时间线 {frameLabel(selection.clip.timeline_start)} → {frameLabel(selection.clip.timeline_start + selection.clip.duration)}</span>
                  <span>源入点 {frameLabel(selection.clip.source_in)} · 时长 {frameLabel(selection.clip.duration)}</span>
                  <span>{selection.clip.metadata.group_id || "未关联 Take"} · {selection.clip.metadata.trim_basis || "人工"}</span>
                </div>
                <div className="timeline-edit-actions">
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={splitSelected}>在播放头切分</button>
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={() => void apply({ type: "trim", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, timeline_start: selection.clip.timeline_start + 1, source_in: selection.clip.source_in + 1, duration: selection.clip.duration - 1 }, "已向后修剪入点 1 帧")}>入点 +1f</button>
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={() => void apply({ type: "trim", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, timeline_start: selection.clip.timeline_start, source_in: selection.clip.source_in, duration: selection.clip.duration - 1 }, "已向前修剪出点 1 帧")}>出点 -1f</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "disable", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, disabled: selection.clip.enabled }, selection.clip.enabled ? "片段已停用" : "片段已启用")}>{selection.clip.enabled ? "停用" : "启用"}</button>
                  <button type="button" className="secondary danger-quiet" disabled={busy} onClick={() => void apply({ type: "ripple_delete", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id }, "已波纹删除")}>波纹删除</button>
                </div>
                <div className="timeline-move-control">
                  <label>移动到 <input type="number" min={0} value={moveStart} onChange={(event) => setMoveStart(Math.max(0, Number(event.target.value) || 0))} /></label>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "move", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, target_track_id: selection.track.track_id, timeline_start: moveStart }, `已移动 → ${frameLabel(moveStart)}`)}>移动</button>
                </div>
                {selectedMulticam ? (
                  <label className="production-field">
                    <span>多机位角度</span>
                    <select value={selection.clip.selected_angle_source_id ?? ""} onChange={(event) => { if (event.target.value) void apply({ type: "multicam_switch", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, source_id: event.target.value }, `已切换机位 → ${event.target.value}`); }}>
                      {selectedMulticam.angle_source_ids.map((sourceId) => <option value={sourceId} key={sourceId}>{sourceId.replace(/^source:/, "")}</option>)}
                    </select>
                  </label>
                ) : null}
              </>
            ) : <p className="empty-copy">选择一个时间线片段后即可继续精修。</p>}
          </aside>

          {snapshot.validation.length ? (
            <div className="timeline-validation production-panel">
              {snapshot.validation.map((issue) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}
            </div>
          ) : null}
        </>
      ) : (
        <div className="production-panel timeline-empty">
          <strong>尚未建立本机时间线</strong>
          <p>桌面 App 会优先恢复上次保存的编辑；没有已有编辑时，上方粗剪提议仍需明确点击“确认建立时间线”。</p>
        </div>
      )}
    </section>
  );
}
