import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload } from "../../api/host";
import { ProductionClient, type RoughCutPlan } from "../../api/production";
import {
  TimelineBridgeError,
  TimelineClient,
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
  const [fps, setFps] = useState(24);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取 rough_cut_plan.v1…");

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
    setMessage("正在读取 rough_cut_plan.v1…");
    Promise.all([host.reviewModel(projectId), production.roughCutPlan(projectId)])
      .then(([nextReview, nextPlan]) => {
        if (cancelled) return;
        setReview(nextReview);
        setPlan(nextPlan);
        setMessage(`rough_cut_plan.v1 · ${nextPlan.readiness} · ${nextPlan.revision || "no revision"}`);
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
          setMessage(`Timeline 恢复失败：${text}`);
        }
      });
    }

    return () => { cancelled = true; };
  }, [host, production, projectId, timeline]);

  const proposal = useMemo(
    () => review && plan ? buildRoughCutTimelineProposal(review, plan, fps) : null,
    [fps, plan, review],
  );
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
    if (!proposal) return;
    if (!isTauri()) {
      setMessage("浏览器预览可以检查 proposal，但确认应用必须在 Tauri Desktop 中执行。");
      return;
    }
    setBusy(true);
    setMessage("正在事务性提交 proposal → Rust Timeline Core…");
    try {
      const next = await timeline.loadWithCommands(proposal.baseProject, proposal.commands);
      setSnapshot(next);
      const firstClip = activeSequence(next)?.tracks.flatMap((track) => track.clips)[0] ?? null;
      setSelectedClipId(firstClip?.clip_id ?? "");
      setPlayhead(firstClip?.timeline_start ?? 0);
      await refreshPersistence();
      setMessage(`Timeline 已建立并 checkpoint · ${proposal.commands.length} 条 human-confirmed insert command · validator 通过`);
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
      setMessage(`Undo · 剩余 ${next.undo_depth}`);
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
      setMessage(`Redo · 可撤销 ${next.undo_depth}`);
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
      setMessage("Timeline checkpoint 已原子写入；journal 已折叠。 ");
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
      setMessage("Split playhead 必须严格位于当前 clip 内部。");
      return;
    }
    void apply({
      type: "split",
      sequence_id: sequence?.sequence_id ?? "main",
      clip_id: clip.clip_id,
      position: playhead,
      right_clip_id: `${clip.clip_id}:split:${playhead}`,
    }, `已在 ${frameLabel(playhead)} split ${clip.clip_id}`);
  }

  return (
    <section className="timeline-workbench">
      <header className="production-heading timeline-heading">
        <div>
          <p className="eyebrow">Phase 4–5 · Persistent Timeline + Proxy Edit</p>
          <h2>剪辑 / Timeline</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="timeline-proposal production-panel">
        <div className="timeline-proposal-heading">
          <div>
            <p className="eyebrow">Python proposal → human confirm → Rust commands</p>
            <strong>{proposal?.included.length ?? 0} 段可提议 · {proposal?.skipped.length ?? 0} 段保持人工待决</strong>
          </div>
          <label className="timeline-fps">FPS <input type="number" min={1} max={240} value={fps} onChange={(event) => setFps(Math.max(1, Number(event.target.value) || 24))} /></label>
          <button type="button" disabled={busy || !proposal || proposal.commands.length === 0} onClick={() => void confirmProposal()}>确认建立时间线</button>
        </div>
        <div className="proposal-warnings">
          {(proposal?.warnings ?? []).map((warning) => <span key={warning}>{warning}</span>)}
        </div>
        {proposal?.skipped.length ? (
          <details>
            <summary>查看未自动进入 Timeline 的 {proposal.skipped.length} 个剧本段</summary>
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
              <button type="button" className="secondary" disabled={busy || snapshot.undo_depth === 0} onClick={() => void undo()}>Undo {snapshot.undo_depth}</button>
              <button type="button" className="secondary" disabled={busy || snapshot.redo_depth === 0} onClick={() => void redo()}>Redo {snapshot.redo_depth}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void checkpoint()}>Checkpoint</button>
            </div>
            <label>Playhead <input type="number" min={0} value={playhead} onChange={(event) => changePlayhead(Number(event.target.value) || 0)} /></label>
            <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "set_marker", sequence_id: sequence.sequence_id, marker: { marker_id: `marker:${playhead}`, position: playhead, label: `Marker ${playhead}` } }, `已设置 Marker @ ${frameLabel(playhead)}`)}>Marker</button>
            <span>
              {sequence.frame_rate.numerator}/{sequence.frame_rate.denominator} fps · validator {snapshot.validation.length ? `${snapshot.validation.length} issues` : "OK"}
              {persistence ? ` · journal ${persistence.persistence.journal_operations}${persistence.recovered_operations ? ` · recovered ${persistence.recovered_operations}` : ""}${persistence.used_backup ? " · backup recovery" : ""}` : ""}
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
                  <div><p className="eyebrow">Selected Clip</p><strong>{selection.clip.clip_id}</strong></div>
                  <span>{selection.track.track_id}</span>
                </div>
                <div className="timeline-clip-facts">
                  <span>timeline {frameLabel(selection.clip.timeline_start)} → {frameLabel(selection.clip.timeline_start + selection.clip.duration)}</span>
                  <span>source in {frameLabel(selection.clip.source_in)} · duration {frameLabel(selection.clip.duration)}</span>
                  <span>{selection.clip.metadata.group_id || "no group"} · {selection.clip.metadata.trim_basis || "manual"}</span>
                </div>
                <div className="timeline-edit-actions">
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={splitSelected}>Split @ playhead</button>
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={() => void apply({ type: "trim", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, timeline_start: selection.clip.timeline_start + 1, source_in: selection.clip.source_in + 1, duration: selection.clip.duration - 1 }, "已 Trim 入点 +1 frame")}>Trim In +1f</button>
                  <button type="button" className="secondary" disabled={busy || selection.clip.duration <= 1} onClick={() => void apply({ type: "trim", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, timeline_start: selection.clip.timeline_start, source_in: selection.clip.source_in, duration: selection.clip.duration - 1 }, "已 Trim Out -1 frame")}>Trim Out -1f</button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "disable", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, disabled: selection.clip.enabled }, selection.clip.enabled ? "已 Disable clip" : "已 Enable clip")}>{selection.clip.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" className="secondary danger-quiet" disabled={busy} onClick={() => void apply({ type: "ripple_delete", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id }, "已 Ripple Delete")}>Ripple Delete</button>
                </div>
                <div className="timeline-move-control">
                  <label>Move start <input type="number" min={0} value={moveStart} onChange={(event) => setMoveStart(Math.max(0, Number(event.target.value) || 0))} /></label>
                  <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "move", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, target_track_id: selection.track.track_id, timeline_start: moveStart }, `已 Move → ${frameLabel(moveStart)}`)}>Move</button>
                </div>
                {selectedMulticam ? (
                  <label className="production-field">
                    <span>Multicam Angle</span>
                    <select value={selection.clip.selected_angle_source_id ?? ""} onChange={(event) => { if (event.target.value) void apply({ type: "multicam_switch", sequence_id: sequence.sequence_id, clip_id: selection.clip.clip_id, source_id: event.target.value }, `已切换 multicam → ${event.target.value}`); }}>
                      {selectedMulticam.angle_source_ids.map((sourceId) => <option value={sourceId} key={sourceId}>{sourceId.replace(/^source:/, "")}</option>)}
                    </select>
                  </label>
                ) : null}
              </>
            ) : <p className="empty-copy">选择 Timeline clip 后可执行 deterministic edit command。</p>}
          </aside>

          {snapshot.validation.length ? (
            <div className="timeline-validation production-panel">
              {snapshot.validation.map((issue) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}
            </div>
          ) : null}
        </>
      ) : (
        <div className="production-panel timeline-empty">
          <strong>尚未建立 Rust Timeline</strong>
          <p>Tauri 会先尝试恢复本机 checkpoint + journal；没有持久化编辑时，上方 proposal 仍需明确点击“确认建立时间线”。</p>
        </div>
      )}
    </section>
  );
}
