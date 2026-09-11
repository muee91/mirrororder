import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HostConnection, type ReviewModelPayload } from "../../api/host";
import { ProductionClient, type AssemblyTimeline, type AssistantStatus, type SlateBoard } from "../../api/production";
import { TimelineClient, type FrameRate, type TimelineRuntimeStatus, type TimelineSnapshot } from "../../api/timeline";
import { clampPlayhead } from "./editorPlayback";
import { buildEditorialInspector, buildEditorialSuggestions, buildReplacementTakeOptions } from "./editorSemantics";
import { buildAssemblyTimelineProposal } from "./timelineSeed";
import { buildTimelineSourceOptions, insertCutsExistingClip, validateManualSourceRange } from "./timelineSourceEditing";
import { audioInsertCutsExistingClip, audioTrackId } from "./timelineAudioEditing";
import { clampSourceCursor } from "./timelineSourceMarks";
import { activeSequence, errorMessage, findClip, positiveInteger, statusLabel } from "./timelineWorkbenchSupport";

export function useTimelineWorkbenchModel(baseUrl: string, projectId: string) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const timeline = useMemo(() => new TimelineClient(), []);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [plan, setPlan] = useState<AssemblyTimeline | null>(null);
  const [slate, setSlate] = useState<SlateBoard | null>(null);
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus | null>(null);
  const [snapshot, setSnapshot] = useState<TimelineSnapshot | null>(null);
  const [persistence, setPersistence] = useState<TimelineRuntimeStatus | null>(null);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [moveStart, setMoveStart] = useState(0);
  const [sourceId, setSourceId] = useState("");
  const [sourceIn, setSourceIn] = useState(0);
  const [sourceDuration, setSourceDuration] = useState(1);
  const [sourcePosition, setSourcePosition] = useState(0);
  const [rateNumerator, setRateNumerator] = useState("");
  const [rateDenominator, setRateDenominator] = useState("");
  const [replaceProposalArmed, setReplaceProposalArmed] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取初始顺片与已保存剪辑…");

  const refreshPersistence = useCallback(async () => {
    if (!isTauri()) return;
    try { setPersistence(await timeline.persistenceStatus()); }
    catch (error) {
      // 持久化状态读取失败（如 journal 损坏）不能静默——
      // 那正是用户最需要看见"已从备份恢复/恢复失败"提示的时刻。
      setPersistence(null);
      setMessage(`时间线持久化状态不可用：${errorMessage(error)}`);
    }
  }, [timeline]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null); setPersistence(null); setReview(null); setPlan(null); setSlate(null); setAssistantStatus(null);
    setSelectedClipId(""); setReplacementKey(""); setPlayhead(0); setMoveStart(0); setSourceId("");
    setSourceIn(0); setSourceDuration(1); setSourcePosition(0); setRateNumerator(""); setRateDenominator("");
    setReplaceProposalArmed(false); setMessage("正在读取初始顺片与已保存剪辑…");

    Promise.all([host.reviewModel(projectId), production.assemblyTimeline(projectId)]).then(([nextReview, nextPlan]) => {
      if (cancelled) return;
      setReview(nextReview); setPlan(nextPlan);
      const timebase = nextPlan.timebase;
      if (timebase?.status === "confirmed" && Number.isSafeInteger(timebase.numerator) && Number.isSafeInteger(timebase.denominator) && Number(timebase.numerator) > 0 && Number(timebase.denominator) > 0) {
        setRateNumerator(String(timebase.numerator)); setRateDenominator(String(timebase.denominator));
        setMessage(`初始顺片已读取 · ${statusLabel(nextPlan.readiness)} · 时间基 ${timebase.numerator}/${timebase.denominator}`);
      } else setMessage("初始顺片已读取 · 当前来源没有可证明的时间基，请确认项目帧率。");
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });

    void production.scriptSupervisor(projectId).then((board) => { if (!cancelled) setSlate(board); }).catch(() => { if (!cancelled) setSlate(null); });
    void production.assistant(projectId).then((status) => { if (!cancelled) setAssistantStatus(status); }).catch(() => { if (!cancelled) setAssistantStatus(null); });

    if (isTauri()) void timeline.openPersisted(projectId).then((current) => {
      if (cancelled) return;
      setSnapshot(current);
      const firstClip = activeSequence(current)?.tracks.flatMap((track) => track.clips)[0] ?? null;
      setSelectedClipId(firstClip?.clip_id ?? ""); setPlayhead(firstClip?.timeline_start ?? 0);
      void timeline.persistenceStatus().then((status) => { if (!cancelled) setPersistence(status); }).catch(() => undefined);
    }).catch((error: unknown) => {
      if (cancelled) return;
      const text = errorMessage(error);
      if (!text.includes("还没有持久化 Timeline")) setMessage(`时间线恢复失败：${text}`);
    });
    return () => { cancelled = true; };
  }, [host, production, projectId, timeline]);

  const frameRate = useMemo<FrameRate | null>(() => {
    const numerator = positiveInteger(rateNumerator), denominator = positiveInteger(rateDenominator);
    return numerator && denominator ? { numerator, denominator } : null;
  }, [rateDenominator, rateNumerator]);
  const proposal = useMemo(() => review && plan && frameRate ? buildAssemblyTimelineProposal(review, plan, frameRate) : null, [frameRate, plan, review]);
  const timebaseDetected = plan?.timebase?.status === "confirmed";
  // 项目里识别到权威时间基时自动预填：不该让剪辑师手抄 24000/1001。
  const detectedNumerator = plan?.timebase?.numerator;
  const detectedDenominator = plan?.timebase?.denominator;
  useEffect(() => {
    if (!detectedNumerator || !detectedDenominator) return;
    setRateNumerator((current) => current || String(detectedNumerator));
    setRateDenominator((current) => current || String(detectedDenominator));
  }, [detectedDenominator, detectedNumerator]);
  const sequence = activeSequence(snapshot);
  const selection = findClip(snapshot, selectedClipId);
  const sourceOptions = useMemo(() => snapshot && sequence ? buildTimelineSourceOptions(review, snapshot.project, sequence) : [], [review, sequence, snapshot]);
  const sourceOption = sourceOptions.find((option) => option.source.source_id === sourceId) ?? null;
  const sourceRangeError = validateManualSourceRange(sourceOption, sourceIn, sourceDuration);
  const sourceOut = sourceIn + sourceDuration;
  const videoInsertBlocked = sequence ? insertCutsExistingClip(sequence, playhead) : false;
  const audioTargetTrackId = sequence ? audioTrackId(sequence) : null;
  const audioInsertBlocked = sequence ? audioInsertCutsExistingClip(sequence, playhead) : false;
  const maxEnd = Math.max(1, ...(sequence?.tracks.flatMap((track) => track.clips.map((clip) => clip.timeline_start + clip.duration)) ?? [1]));
  const selectedMulticam = selection?.clip.multicam_group_id ? snapshot?.project.multicam_groups.find((group) => group.group_id === selection.clip.multicam_group_id) ?? null : null;
  const inspector = useMemo(() => snapshot && selection ? buildEditorialInspector(review, slate, snapshot.project, selection.clip) : null, [review, selection, slate, snapshot]);
  const replacementOptions = useMemo(() => sequence && selection ? buildReplacementTakeOptions(review, slate, sequence, selection.clip, sourceOptions) : [], [review, selection, sequence, slate, sourceOptions]);
  const replacement = replacementOptions.find((item) => item.key === replacementKey) ?? replacementOptions[0] ?? null;
  const editorialSuggestions = useMemo(() => snapshot && sequence ? buildEditorialSuggestions(review, slate, plan, snapshot.project, sequence) : [], [plan, review, sequence, slate, snapshot]);

  useEffect(() => { setReplacementKey(replacementOptions[0]?.key ?? ""); }, [selectedClipId, replacementOptions]);
  useEffect(() => {
    if (!sourceOptions.length) { setSourceId(""); setSourceIn(0); setSourceDuration(1); setSourcePosition(0); return; }
    const current = sourceOptions.find((option) => option.source.source_id === sourceId);
    if (current) { setSourcePosition((position) => clampSourceCursor(current, position)); return; }
    const selectedSourceId = selection?.clip.selected_angle_source_id ?? selection?.clip.source_id ?? "";
    const next = sourceOptions.find((option) => option.source.source_id === selectedSourceId) ?? sourceOptions[0];
    setSourceId(next.source.source_id); setSourceIn(next.availableIn); setSourceDuration(next.availableDuration); setSourcePosition(next.availableIn);
  }, [selection?.clip.selected_angle_source_id, selection?.clip.source_id, sourceId, sourceOptions]);

  const changePlayhead = useCallback((frame: number) => setPlayhead(() => sequence ? clampPlayhead(sequence, frame) : Math.max(0, Math.round(frame))), [sequence]);
  const stepPlayhead = useCallback((frames: number) => setPlayhead((current) => sequence ? clampPlayhead(sequence, current + frames) : Math.max(0, current + frames)), [sequence]);

  return { baseUrl, projectId, production, timeline, review, plan, slate, assistantStatus, setAssistantStatus, snapshot, setSnapshot, persistence, refreshPersistence, selectedClipId, setSelectedClipId, playhead, setPlayhead, moveStart, setMoveStart, sourceId, setSourceId, sourceIn, setSourceIn, sourceDuration, setSourceDuration, sourcePosition, setSourcePosition, rateNumerator, setRateNumerator, rateDenominator, setRateDenominator, replaceProposalArmed, setReplaceProposalArmed, replacementKey, setReplacementKey, busy, setBusy, message, setMessage, frameRate, proposal, timebaseDetected, sequence, selection, sourceOptions, sourceOption, sourceRangeError, sourceOut, videoInsertBlocked, audioTargetTrackId, audioInsertBlocked, maxEnd, selectedMulticam, inspector, replacementOptions, replacement, editorialSuggestions, changePlayhead, stepPlayhead };
}

export type TimelineWorkbenchModel = ReturnType<typeof useTimelineWorkbenchModel>;
