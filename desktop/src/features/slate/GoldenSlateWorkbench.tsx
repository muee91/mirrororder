import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewAngle, type ReviewModelPayload, type ReviewTakeGroup } from "../../api/host";
import { ProductionClient, type SlateAttachment, type SlateBoard, type SlateEntry, type SlateParseResult, type SlateRecord, type SlateStatus } from "../../api/production";
import { SlateMediaClient, type SlateResolvedMediaItem } from "../../api/slateMedia";
import { SlateRecordClient } from "../../api/slateRecords";
import { MirrorOrderMediaCard, mediaCardFromAngle, mediaCardFromAttachment } from "../media/MirrorOrderMediaCard";
import { SlateWorkbench } from "./SlateWorkbench";
import "./golden-slate.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenMaterialScript?: () => void;
  onOpenIdentity?: () => void;
  onOpenReview?: () => void;
}

type Draft = SlateRecord & { dirty: boolean; derived: boolean; derivedSource: string; xmlOrder: number };

const ACTOR_KEY = "mirrororder.productionActor";
const STATUS_OPTIONS: Array<{ value: SlateStatus; label: string }> = [
  { value: "unmarked", label: "待定" },
  { value: "usable", label: "可用" },
  { value: "partial", label: "部分可用" },
  { value: "ng", label: "NG" },
];
const SHOT_OPTIONS = ["unknown", "wide", "full", "medium", "medium_closeup", "closeup", "extreme_closeup", "big_closeup", "insert"];

function storedActor(): string {
  try { return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() ?? ""; } catch { return ""; }
}

function saveActor(actor: string): void {
  try { globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim()); } catch { /* device-local convenience only */ }
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function newRecordId(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `slate-${id.replaceAll("-", "").toLowerCase()}`;
}

function attachmentKey(attachment: SlateAttachment): string {
  return attachment.clip_id || attachment.media_id;
}

function attachmentFromAngle(angle: ReviewAngle): SlateAttachment {
  return {
    clip_id: angle.clip_id,
    media_id: angle.media_id,
    camera: angle.camera,
    display_name: angle.name,
    shot_type: angle.shot_type || "unknown",
    source_role: "sync_camera",
    note: "",
  };
}

function attachmentFromResolved(item: SlateResolvedMediaItem): SlateAttachment {
  return {
    clip_id: item.clip_id,
    media_id: item.media_id,
    camera: item.camera,
    display_name: item.display_name,
    shot_type: "unknown",
    source_role: item.source_role || "sync_camera",
    note: "",
  };
}

function mergeAttachments(current: SlateAttachment[], additions: SlateAttachment[]): SlateAttachment[] {
  const rows = [...current];
  const seen = new Set(rows.map(attachmentKey).filter(Boolean));
  for (const item of additions) {
    const key = attachmentKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows;
}

function mergeTakeAttachments(record: SlateRecord, take: ReviewTakeGroup | null): SlateAttachment[] {
  if (!take) return record.attachments;
  const existing = new Map(record.attachments.map((item) => [attachmentKey(item), item]));
  const reviewAttachments = take.angles.map((angle) => {
    const prior = existing.get(angle.clip_id) ?? existing.get(angle.media_id);
    return prior ? {
      ...attachmentFromAngle(angle),
      ...prior,
      clip_id: prior.clip_id || angle.clip_id,
      media_id: prior.media_id || angle.media_id,
      camera: prior.camera || angle.camera,
      display_name: prior.display_name || angle.name,
    } : attachmentFromAngle(angle);
  });
  return mergeAttachments(reviewAttachments, record.attachments);
}

function derivedSource(take: ReviewTakeGroup): string {
  if (take.effective_mapping.source === "human") return "映射";
  if (take.effective_mapping.source === "automatic") {
    return take.automatic_state.mapping_source?.includes("ai") ? "AI" : "自动";
  }
  return "Take";
}

function draftFromRecord(record: SlateRecord, take: ReviewTakeGroup | null, xmlOrder: number): Draft {
  return { ...record, attachments: mergeTakeAttachments(record, take), dirty: false, derived: false, derivedSource: "", xmlOrder };
}

function draftFromTake(take: ReviewTakeGroup, xmlOrder: number): Draft {
  return {
    record_id: `take-${take.group_id}`,
    source_group_id: take.group_id,
    script_scene_id: take.effective_mapping.script_segment_ids[0] || "",
    episode: take.effective_mapping.episode_ids[0] ?? null,
    scene: "",
    shot: "",
    take_number: take.take_index || null,
    status: "unmarked",
    note: "",
    preferred_clip_id: "",
    attachments: take.angles.map(attachmentFromAngle),
    actor: "",
    updated_at: "",
    dirty: false,
    derived: true,
    derivedSource: derivedSource(take),
    xmlOrder,
  };
}

function blankDraft(seed?: Partial<Draft>): Draft {
  return {
    record_id: newRecordId(),
    source_group_id: "",
    script_scene_id: "",
    episode: null,
    scene: "",
    shot: "",
    take_number: null,
    status: "unmarked",
    note: "",
    preferred_clip_id: "",
    attachments: [],
    actor: "",
    updated_at: "",
    dirty: true,
    derived: false,
    derivedSource: "",
    xmlOrder: Number.MAX_SAFE_INTEGER,
    ...seed,
  };
}

function buildDrafts(board: SlateBoard, review: ReviewModelPayload): Draft[] {
  const takes = new Map(review.take_groups.map((take) => [take.group_id, take]));
  const persisted = Object.values(board.records).map((record, index) => draftFromRecord(record, takes.get(record.source_group_id) ?? null, index));
  const represented = new Set(persisted.map((record) => record.source_group_id).filter(Boolean));
  const derived = review.take_groups
    .filter((take) => !represented.has(take.group_id))
    .map((take, index) => draftFromTake(take, persisted.length + index));
  return [...persisted, ...derived];
}

function placedOrder(left: Draft, right: Draft): number {
  const leftEpisode = left.episode ?? Number.MAX_SAFE_INTEGER;
  const rightEpisode = right.episode ?? Number.MAX_SAFE_INTEGER;
  if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode;
  const scene = left.scene.localeCompare(right.scene, "zh-CN", { numeric: true });
  if (scene) return scene;
  const shot = left.shot.localeCompare(right.shot, "zh-CN", { numeric: true });
  if (shot) return shot;
  return (left.take_number ?? Number.MAX_SAFE_INTEGER) - (right.take_number ?? Number.MAX_SAFE_INTEGER) || left.xmlOrder - right.xmlOrder;
}

function recordPayload(draft: Draft): Partial<SlateRecord> {
  return {
    source_group_id: draft.source_group_id,
    script_scene_id: draft.script_scene_id,
    episode: draft.episode,
    scene: draft.scene,
    shot: draft.shot,
    take_number: draft.take_number,
    status: draft.status,
    note: draft.note,
    ...(draft.usable_range ? { usable_range: draft.usable_range } : {}),
    preferred_clip_id: draft.preferred_clip_id,
    attachments: draft.attachments,
  };
}

function parsePrevious(draft: Draft): Partial<SlateEntry> {
  return {
    episode: draft.episode,
    scene: draft.scene,
    shot: draft.shot,
    take_number: draft.take_number,
    status: draft.status,
    note: draft.note,
  };
}

function cameraKey(value: string): string {
  return value.trim().toUpperCase().replace(/机/g, "");
}

function primaryAttachment(draft: Draft, camera: "A" | "B" | "C" | "AUX"): { item: SlateAttachment; count: number } | null {
  const rows = draft.attachments.filter((attachment) => {
    const key = cameraKey(attachment.camera);
    if (camera === "AUX") return !["A", "B", "C"].includes(key) || attachment.source_role !== "sync_camera";
    return key === camera && attachment.source_role === "sync_camera";
  });
  return rows[0] ? { item: rows[0], count: rows.length } : null;
}

function findReviewAngle(review: ReviewModelPayload | null, clipId: string, mediaId = ""): ReviewAngle | null {
  if (!review) return null;
  for (const take of review.take_groups) {
    const angle = take.angles.find((item) => item.clip_id === clipId || (mediaId && item.media_id === mediaId));
    if (angle) return angle;
  }
  return null;
}

function statusLabel(status: SlateStatus): string {
  return STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status;
}

export function GoldenSlateWorkbench({ baseUrl, projectId, onOpenMaterialScript, onOpenIdentity, onOpenReview }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const records = useMemo(() => new SlateRecordClient(baseUrl), [baseUrl]);
  const slateMedia = useMemo(() => new SlateMediaClient(baseUrl), [baseUrl]);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [board, setBoard] = useState<SlateBoard | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState("");
  const [actor, setActor] = useState(storedActor);
  const [quickText, setQuickText] = useState("");
  const [message, setMessage] = useState("正在读取多机位电子场记…");
  const [busy, setBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const [takePickerOpen, setTakePickerOpen] = useState(false);
  const [takeSearch, setTakeSearch] = useState("");
  const playerRef = useRef<HTMLVideoElement | null>(null);

  async function reload(preferredRecordId?: string): Promise<void> {
    setMessage("正在读取多机位电子场记…");
    const [nextReview, nextBoard] = await Promise.all([host.reviewModel(projectId), production.scriptSupervisor(projectId)]);
    const nextDrafts = buildDrafts(nextBoard, nextReview);
    const nextSelected = preferredRecordId && nextDrafts.some((row) => row.record_id === preferredRecordId)
      ? preferredRecordId
      : nextDrafts.some((row) => row.record_id === selectedRecordId)
        ? selectedRecordId
        : nextDrafts[0]?.record_id ?? "";
    setReview(nextReview);
    setBoard(nextBoard);
    setDrafts(nextDrafts);
    setSelectedRecordId(nextSelected);
    const selected = nextDrafts.find((row) => row.record_id === nextSelected) ?? null;
    setSelectedClipId(selected?.preferred_clip_id || (selected?.attachments[0] ? attachmentKey(selected.attachments[0]) : ""));
    setMessage(`Slate r${nextBoard.revision} · ${nextDrafts.length} 条`);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([host.reviewModel(projectId), production.scriptSupervisor(projectId)])
      .then(([nextReview, nextBoard]) => {
        if (cancelled) return;
        const nextDrafts = buildDrafts(nextBoard, nextReview);
        setReview(nextReview);
        setBoard(nextBoard);
        setDrafts(nextDrafts);
        const first = nextDrafts[0] ?? null;
        setSelectedRecordId(first?.record_id ?? "");
        setSelectedClipId(first?.preferred_clip_id || (first?.attachments[0] ? attachmentKey(first.attachments[0]) : ""));
        setMessage(`Slate r${nextBoard.revision} · ${nextDrafts.length} 条`);
      })
      .catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [host, production, projectId]);

  const selectedIndex = drafts.findIndex((row) => row.record_id === selectedRecordId);
  const selected = selectedIndex >= 0 ? drafts[selectedIndex] : null;
  const selectedTake = selected?.source_group_id ? review?.take_groups.find((take) => take.group_id === selected.source_group_id) ?? null : null;
  const selectedAttachment = selected?.attachments.find((item) => attachmentKey(item) === selectedClipId) ?? null;
  const selectedAngle = selectedAttachment ? findReviewAngle(review, selectedAttachment.clip_id, selectedAttachment.media_id) : findReviewAngle(review, selectedClipId);
  const dirtyCount = drafts.filter((row) => row.dirty).length;
  const placedDrafts = drafts.filter((row) => Boolean(row.script_scene_id)).slice().sort(placedOrder);
  const unplacedDrafts = drafts.filter((row) => !row.script_scene_id).slice().sort((left, right) => left.xmlOrder - right.xmlOrder);
  const usedTakeIds = useMemo(() => new Set(drafts.filter((row) => !row.derived && row.source_group_id).map((row) => row.source_group_id)), [drafts]);
  const takeCandidates = useMemo(() => {
    const query = takeSearch.trim().toLowerCase();
    return (review?.take_groups ?? []).filter((take) => {
      if (!query) return true;
      const text = [take.group_id, `T${take.take_index}`, take.transcript.text, ...take.angles.flatMap((angle) => [angle.camera, angle.name])].join(" ").toLowerCase();
      return text.includes(query);
    });
  }, [review, takeSearch]);
  const episodeCandidates = useMemo(() => {
    if (!review || !selected?.episode || selected.attachments.length) return [];
    return review.take_groups.filter((take) => take.effective_mapping.episode_ids.includes(selected.episode as number) && !usedTakeIds.has(take.group_id)).slice(0, 10);
  }, [review, selected, usedTakeIds]);

  useEffect(() => {
    if (!selected) return;
    if (selectedClipId && selected.attachments.some((item) => attachmentKey(item) === selectedClipId)) return;
    setSelectedClipId(selected.preferred_clip_id || (selected.attachments[0] ? attachmentKey(selected.attachments[0]) : ""));
  }, [selected, selectedClipId]);

  function patchRecord(recordId: string, patch: Partial<Draft>): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? { ...row, ...patch, dirty: true, derived: false, derivedSource: "" } : row));
  }

  function patchAttachment(recordId: string, key: string, patch: Partial<SlateAttachment>): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? {
      ...row,
      attachments: row.attachments.map((attachment) => attachmentKey(attachment) === key ? { ...attachment, ...patch } : attachment),
      dirty: true,
      derived: false,
      derivedSource: "",
    } : row));
  }

  function removeAttachment(recordId: string, key: string): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? {
      ...row,
      attachments: row.attachments.filter((attachment) => attachmentKey(attachment) !== key),
      preferred_clip_id: row.preferred_clip_id === key ? "" : row.preferred_clip_id,
      dirty: true,
      derived: false,
      derivedSource: "",
    } : row));
    if (selectedClipId === key) setSelectedClipId("");
  }

  function selectRecord(recordId: string): void {
    const row = drafts.find((item) => item.record_id === recordId) ?? null;
    setSelectedRecordId(recordId);
    setSelectedClipId(row?.preferred_clip_id || (row?.attachments[0] ? attachmentKey(row.attachments[0]) : ""));
  }

  function addBlank(seed?: Partial<Draft>): Draft {
    const row = blankDraft(seed);
    setDrafts((current) => [...current, row]);
    setSelectedRecordId(row.record_id);
    setSelectedClipId("");
    setQuickText("");
    setMessage("已新增空白场记；保存后才写入项目。");
    return row;
  }

  function nextSameScene(): void {
    addBlank({
      episode: selected?.episode ?? null,
      scene: selected?.scene ?? "",
      shot: selected?.shot ?? "",
      take_number: selected?.take_number ? selected.take_number + 1 : null,
    });
  }

  function inheritPrevious(): void {
    const previous = selectedIndex > 0 ? drafts[selectedIndex - 1] : drafts[drafts.length - 1];
    if (!previous) { addBlank(); return; }
    if (!selected) {
      addBlank({ episode: previous.episode, scene: previous.scene, shot: previous.shot, status: previous.status });
      return;
    }
    patchRecord(selected.record_id, { episode: previous.episode, scene: previous.scene, shot: previous.shot, status: previous.status });
    setMessage("已沿用上一条集 / 场 / 镜 / 状态；素材与 I/O 未复制。");
  }

  function addTake(take: ReviewTakeGroup): void {
    const existing = drafts.find((row) => row.source_group_id === take.group_id);
    if (existing?.derived) {
      selectRecord(existing.record_id);
      setTakePickerOpen(false);
      setMessage(`已选中 T${take.take_index}；编辑后保存即可成为人工场记。`);
      return;
    }
    const attachments = take.angles.map(attachmentFromAngle);
    if (selected && !selected.source_group_id && selected.attachments.length === 0) {
      setDrafts((current) => current
        .filter((row) => row.record_id === selected.record_id || row.source_group_id !== take.group_id)
        .map((row) => row.record_id === selected.record_id ? {
          ...row,
          source_group_id: take.group_id,
          take_number: row.take_number ?? take.take_index,
          episode: row.episode ?? take.effective_mapping.episode_ids[0] ?? null,
          script_scene_id: row.script_scene_id || take.effective_mapping.script_segment_ids[0] || "",
          attachments,
          dirty: true,
          derived: false,
          derivedSource: "",
        } : row));
      setSelectedClipId(attachments[0] ? attachmentKey(attachments[0]) : "");
    } else {
      addBlank({
        source_group_id: take.group_id,
        episode: take.effective_mapping.episode_ids[0] ?? selected?.episode ?? null,
        script_scene_id: take.effective_mapping.script_segment_ids[0] || "",
        scene: selected?.scene ?? "",
        shot: selected?.shot ?? "",
        take_number: take.take_index || null,
        attachments,
      });
    }
    setTakePickerOpen(false);
    setTakeSearch("");
    setMessage(`已加入 T${take.take_index} · ${take.angles.length} 机位；保存后才写入项目。`);
  }

  function attachResolvedMedia(items: SlateResolvedMediaItem[]): void {
    if (!items.length) return;
    const additions = items.map(attachmentFromResolved);
    if (selectedRecordId) {
      setDrafts((current) => current.map((row) => row.record_id === selectedRecordId ? {
        ...row,
        attachments: mergeAttachments(row.attachments, additions),
        dirty: true,
        derived: false,
        derivedSource: "",
      } : row));
      setSelectedClipId(attachmentKey(additions[0]));
    } else {
      const row = blankDraft({ attachments: additions });
      setDrafts((current) => [...current, row]);
      setSelectedRecordId(row.record_id);
      setSelectedClipId(attachmentKey(additions[0]));
    }
  }

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") { setDropActive(true); return; }
      if (event.payload.type === "leave") { setDropActive(false); return; }
      if (event.payload.type !== "drop") return;
      setDropActive(false);
      const paths = event.payload.paths;
      if (!paths.length) return;
      setBusy(true);
      setMessage(`正在解析 ${paths.length} 个 Finder / Explorer 素材…`);
      void slateMedia.resolveDrop(projectId, paths).then((payload) => {
        if (disposed) return;
        attachResolvedMedia(payload.items);
        const suffix = payload.errors.length ? ` · ${payload.errors.length} 个文件未加入` : "";
        setMessage(`已把 ${payload.items.length} 个素材加入当前场记行${suffix}；保存后才写入项目。`);
      }).catch((error) => {
        if (!disposed) setMessage(errorMessage(error));
      }).finally(() => {
        if (!disposed) setBusy(false);
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => {
      if (!disposed) setMessage(`无法启用 Finder 拖入：${errorMessage(error)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [projectId, selectedRecordId, slateMedia]);

  async function saveDraft(draft: Draft, revision: number): Promise<SlateBoard> {
    if (!actor.trim()) throw new HostConnectionError("保存场记前需要操作者昵称");
    saveActor(actor);
    return await records.upsert(projectId, {
      recordId: draft.record_id,
      expectedRevision: revision,
      actor,
      record: recordPayload(draft),
    });
  }

  async function saveSelected(): Promise<void> {
    if (!selected || !board || busy) return;
    setBusy(true);
    setMessage("正在保存当前场记…");
    try {
      const next = await saveDraft(selected, board.revision);
      setBoard(next);
      const saved = next.records[selected.record_id];
      setDrafts((current) => current.map((row) => row.record_id === selected.record_id
        ? saved ? draftFromRecord(saved, review?.take_groups.find((take) => take.group_id === saved.source_group_id) ?? null, row.xmlOrder) : { ...row, dirty: false, derived: false, derivedSource: "" }
        : row));
      setMessage(`已保存 · Slate r${next.revision}`);
    } catch (error) {
      setMessage(errorMessage(error).includes("revision") ? `${errorMessage(error)}；未覆盖其他人的修改，请刷新后重试。` : errorMessage(error));
    } finally { setBusy(false); }
  }

  async function saveAll(): Promise<void> {
    if (!board || busy) return;
    const pending = drafts.filter((row) => row.dirty);
    if (!pending.length) { setMessage("没有待保存修改。"); return; }
    if (!actor.trim()) { setMessage("保存场记前需要操作者昵称。"); return; }
    setBusy(true);
    setMessage(`正在顺序保存 ${pending.length} 行…`);
    let nextBoard = board;
    const savedIds = new Set<string>();
    try {
      for (const row of pending) {
        nextBoard = await saveDraft(row, nextBoard.revision);
        savedIds.add(row.record_id);
      }
      setMessage(`全部保存完成 · Slate r${nextBoard.revision}`);
    } catch (error) {
      setMessage(`${errorMessage(error)}；顺序保存已停止，未执行的行保持未保存。`);
    } finally {
      if (savedIds.size) {
        setBoard(nextBoard);
        setDrafts((current) => current.map((row) => {
          if (!savedIds.has(row.record_id)) return row;
          const saved = nextBoard.records[row.record_id];
          return saved ? draftFromRecord(saved, review?.take_groups.find((take) => take.group_id === saved.source_group_id) ?? null, row.xmlOrder) : row;
        }));
      }
      setBusy(false);
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selected || !board || busy) return;
    if (!board.records[selected.record_id]) {
      setDrafts((current) => current.filter((row) => row.record_id !== selected.record_id));
      setSelectedRecordId(drafts[selectedIndex + 1]?.record_id || drafts[selectedIndex - 1]?.record_id || "");
      setMessage("已移除尚未保存的场记草稿；Review Take 本身没有删除。");
      return;
    }
    if (!actor.trim()) { setMessage("删除场记前需要操作者昵称。"); return; }
    setBusy(true);
    try {
      const next = await records.delete(projectId, { recordId: selected.record_id, expectedRevision: board.revision, actor });
      setBoard(next);
      if (review) {
        const nextDrafts = buildDrafts(next, review);
        setDrafts(nextDrafts);
        setSelectedRecordId(nextDrafts[Math.min(selectedIndex, Math.max(0, nextDrafts.length - 1))]?.record_id ?? "");
      }
      setMessage(`已删除人工场记记录 · Slate r${next.revision}；关联 Take 本身未删除。`);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function applyQuickEntry(): Promise<void> {
    if (!selected || !quickText.trim() || busy) return;
    setBusy(true);
    setMessage("正在解析场记原话…");
    try {
      const payload = await production.parseSlate(projectId, quickText, parsePrevious(selected));
      const parsed: SlateParseResult = payload.result;
      const attachments = selected.attachments.map((attachment) => {
        const shot = parsed.angle_shots[cameraKey(attachment.camera)];
        return shot ? { ...attachment, shot_type: shot } : attachment;
      });
      patchRecord(selected.record_id, {
        episode: parsed.episode ?? selected.episode,
        scene: parsed.scene || selected.scene,
        shot: parsed.shot || selected.shot,
        take_number: parsed.take_number ?? selected.take_number,
        status: parsed.status !== "unmarked" ? parsed.status : selected.status,
        note: parsed.note || selected.note,
        attachments,
      });
      setQuickText("");
      setMessage(`已填入解析结果${parsed.range_hint ? ` · 范围原话：${parsed.range_hint}` : ""}；仍需保存。`);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function setIO(kind: "in" | "out"): void {
    if (!selected) return;
    const current = playerRef.current?.currentTime;
    if (typeof current !== "number" || !Number.isFinite(current)) { setMessage("当前没有可用播放器时间点。"); return; }
    const previous = selected.usable_range;
    if (kind === "in") {
      const end = previous?.end && previous.end > current ? previous.end : current + 0.04;
      patchRecord(selected.record_id, { usable_range: { start: current, end } });
      setMessage(`已设入点 ${current.toFixed(2)}s。`);
    } else {
      const start = previous?.start ?? 0;
      if (current <= start) { setMessage("出点必须晚于入点。"); return; }
      patchRecord(selected.record_id, { usable_range: { start, end: current } });
      setMessage(`已设出点 ${current.toFixed(2)}s。`);
    }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable=true]"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveAll(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); addBlank(); return; }
      if (!editing && event.key.toLowerCase() === "i") { event.preventDefault(); setIO("in"); }
      if (!editing && event.key.toLowerCase() === "o") { event.preventDefault(); setIO("out"); }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  });

  function mediaCell(draft: Draft, camera: "A" | "B" | "C" | "AUX") {
    const row = primaryAttachment(draft, camera);
    if (!row) {
      return <button type="button" className="golden-slate-empty-media" onClick={(event) => { event.stopPropagation(); selectRecord(draft.record_id); setTakePickerOpen(true); }}>{camera === "AUX" ? "—" : `＋ ${camera}`}</button>;
    }
    const angle = findReviewAngle(review, row.item.clip_id, row.item.media_id);
    const model = angle ? mediaCardFromAngle(angle, row.item) : mediaCardFromAttachment(row.item);
    model.duplicateCount = row.count;
    return <MirrorOrderMediaCard model={model} compact selected={draft.record_id === selectedRecordId && model.id === selectedClipId} preferred={draft.preferred_clip_id === model.id} onSelect={() => { selectRecord(draft.record_id); setSelectedClipId(model.id); }} />;
  }

  function renderRows(rows: Draft[]) {
    return rows.map((draft) => {
      const index = drafts.indexOf(draft);
      return (
        <tr key={draft.record_id} className={`${draft.record_id === selectedRecordId ? "is-selected" : ""} ${draft.dirty ? "is-dirty" : ""}`} onClick={() => selectRecord(draft.record_id)}>
          <td className="col-index"><strong>{String(index + 1).padStart(3, "0")}</strong>{draft.derivedSource ? <small className="derived-source">{draft.derivedSource}</small> : draft.dirty ? <small>未保存</small> : null}</td>
          <td className="col-number"><input type="number" min={1} value={draft.episode ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { episode: event.target.value ? Number(event.target.value) : null })} /></td>
          <td className="col-text"><input value={draft.scene} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { scene: event.target.value })} /></td>
          <td className="col-text"><input value={draft.shot} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { shot: event.target.value })} /></td>
          <td className="col-number"><input type="number" min={1} value={draft.take_number ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { take_number: event.target.value ? Number(event.target.value) : null })} /></td>
          <td className="col-media">{mediaCell(draft, "A")}</td>
          <td className="col-media">{mediaCell(draft, "B")}</td>
          <td className="col-media">{mediaCell(draft, "C")}</td>
          <td className="col-media">{mediaCell(draft, "AUX")}</td>
          <td className="col-status">
            <label className={`golden-status-control status-${draft.status}`} onClick={(event) => event.stopPropagation()}>
              <span className="status-dot" />
              <select value={draft.status} aria-label={`第 ${index + 1} 条状态`} onChange={(event) => patchRecord(draft.record_id, { status: event.target.value as SlateStatus })}>{STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
              <span className="status-label">{statusLabel(draft.status)}</span>
            </label>
          </td>
        </tr>
      );
    });
  }

  function section(title: string, rows: Draft[], tone: "placed" | "unplaced") {
    if (!rows.length) return null;
    return (
      <section className={`golden-slate-section is-${tone}`}>
        <header><span className="section-dot" /><strong>{title}</strong><small>{rows.length} 条</small></header>
        <div className="golden-slate-section-scroll">
          <table className="golden-slate-table">
            <thead><tr><th className="col-index">序号</th><th className="col-number">集</th><th className="col-text">场号</th><th className="col-text">镜号</th><th className="col-number">次号</th><th className="col-media">A 机</th><th className="col-media">B 机</th><th className="col-media">C 机</th><th className="col-media">辅助 / 特殊</th><th className="col-status">状态</th></tr></thead>
            <tbody>{renderRows(rows)}</tbody>
          </table>
        </div>
      </section>
    );
  }

  const inspectorAttachments = selected?.attachments ?? [];

  return (
    <section className={`golden-slate-workbench ${inspectorOpen ? "has-inspector" : ""} ${dropActive ? "is-file-drop-active" : ""}`}>
      <header className="golden-slate-toolbar">
        <div className="golden-slate-title">
          <strong>{review?.project.name || "项目"}</strong>
          <span>{message}</span>
        </div>
        <div className="golden-slate-mode"><span className="slate-mode-icon">▦</span><strong>场记</strong></div>
        <div className="golden-slate-actions">
          <input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="操作者" aria-label="场记操作者" />
          {onOpenMaterialScript ? <button type="button" className="secondary" onClick={onOpenMaterialScript}>素材 / 剧本</button> : null}
          {onOpenReview ? <button type="button" className="secondary" onClick={onOpenReview}>审阅</button> : null}
          {onOpenIdentity ? <button type="button" className="secondary compact-action" onClick={onOpenIdentity}>人物</button> : null}
          <button type="button" className="secondary" onClick={() => setTakePickerOpen((value) => !value)}>加入 Take / 镜头</button>
          <button type="button" className={`icon-action ${inspectorOpen ? "is-active" : ""}`} onClick={() => setInspectorOpen((value) => !value)} title={inspectorOpen ? "隐藏 Inspector" : "显示 Inspector"}>▥</button>
          <button type="button" className="icon-action" disabled={busy} onClick={() => void reload(selectedRecordId)} title="刷新项目">↻</button>
          <button type="button" disabled={busy || dirtyCount === 0 || !actor.trim()} onClick={() => void saveAll()}>保存{dirtyCount ? ` ${dirtyCount}` : ""}</button>
        </div>
      </header>

      <section className="golden-slate-quick">
        <span className="quick-mic" aria-hidden="true">⌁</span>
        <input value={quickText} onChange={(event) => setQuickText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void applyQuickEntry(); } }} placeholder="快速录入：EP3 12场 B近 可用 / 同场下一条 C中" />
        <button type="button" className="quick-fill" disabled={!selected || busy || !quickText.trim()} onClick={() => void applyQuickEntry()}>填入</button>
        <span className="quick-divider" />
        <button type="button" className="secondary" onClick={nextSameScene}>同场下一条</button>
        <button type="button" className="secondary" onClick={inheritPrevious}>同上</button>
        <button type="button" onClick={() => addBlank()}>空白</button>
      </section>

      {takePickerOpen ? (
        <section className="golden-take-picker" aria-label="加入 Take / 镜头">
          <header><strong>加入 Take / 镜头</strong><input autoFocus value={takeSearch} onChange={(event) => setTakeSearch(event.target.value)} placeholder="搜索 Take / 机位 / 文件名 / 对白" /><button type="button" className="secondary" onClick={() => setTakePickerOpen(false)}>关闭</button></header>
          <div className="golden-take-picker-list">
            {takeCandidates.map((take) => <button type="button" key={take.group_id} className={usedTakeIds.has(take.group_id) ? "is-used" : ""} onClick={() => addTake(take)}><strong>T{take.take_index}</strong><span>{take.angles.map((angle) => `${angle.camera || "?"} ${angle.name}`).join(" · ")}</span><small>{take.transcript.text || `${take.duration.toFixed(1)}s · ${take.angles.length} 机位`}</small></button>)}
            {!takeCandidates.length ? <span className="golden-take-picker-empty">没有匹配 Take。</span> : null}
          </div>
        </section>
      ) : null}

      <div className="golden-slate-body">
        <div className="golden-slate-table-shell">
          {dropActive ? <div className="golden-slate-drop-overlay">松开以加入当前场记</div> : null}
          {placedDrafts.length && unplacedDrafts.length ? (
            <div className="golden-slate-split-sections">{section("已按剧本归位", placedDrafts, "placed")}{section("待标记 · 保持 XML 顺序", unplacedDrafts, "unplaced")}</div>
          ) : placedDrafts.length ? section("已按剧本归位", placedDrafts, "placed") : unplacedDrafts.length ? section("待标记 · 保持 XML 顺序", unplacedDrafts, "unplaced") : (
            <div className="golden-slate-empty"><strong>从 Take 加入第一条多机位场记</strong><span>A / B / C 会落在同一行；场号、镜号、次号只记录一次。</span><div><button type="button" onClick={() => setTakePickerOpen(true)}>从 Take 加入</button><button type="button" className="secondary" onClick={() => addBlank()}>新建空白场记</button></div></div>
          )}
        </div>

        {inspectorOpen ? (
          <aside className="golden-slate-inspector">
            {selected ? (
              <>
                <div className="golden-inspector-head"><div><strong>选中素材</strong><span>EP {selected.episode ?? "—"} / 场 {selected.scene || "—"} / 镜 {selected.shot || "—"} / 次 {selected.take_number ?? "—"}</span></div>{selected.dirty ? <em>未保存</em> : null}</div>
                <div className="golden-slate-player">
                  {selectedAngle?.playback.url && selectedAngle.playback.available !== false ? (
                    <video ref={playerRef} key={selectedAngle.clip_id} src={selectedAngle.playback.url} controls preload="metadata" onLoadedMetadata={(event) => { const video = event.currentTarget; const start = selectedAngle.playback.source_start ?? selectedAngle.source_start ?? 0; if (start > 0) { try { video.currentTime = start; } catch { /* safe fallback */ } } }} />
                  ) : <div className="golden-player-empty">{selectedAttachment ? "当前设备没有可播放素材" : "选择一个机位素材"}</div>}
                </div>

                {episodeCandidates.length ? <section className="golden-episode-candidates"><header><strong>第 {selected.episode} 集候选</strong><span>{episodeCandidates.length} Take</span></header>{episodeCandidates.map((take) => <button type="button" key={take.group_id} onClick={() => addTake(take)}><strong>T{take.take_index}</strong><span>{take.angles.map((angle) => angle.camera || "?").join(" / ")}</span><small>{take.transcript.text || `${take.duration.toFixed(1)}s`}</small></button>)}</section> : null}

                <section className="golden-inspector-media"><header><strong>机位素材</strong><span>{inspectorAttachments.length}</span></header>
                  {inspectorAttachments.map((attachment) => {
                    const key = attachmentKey(attachment);
                    const angle = findReviewAngle(review, attachment.clip_id, attachment.media_id);
                    const model = angle ? mediaCardFromAngle(angle, attachment) : mediaCardFromAttachment(attachment);
                    return (
                      <div className="golden-angle-editor" key={`${attachment.clip_id}-${attachment.media_id}`}>
                        <MirrorOrderMediaCard model={model} selected={key === selectedClipId} preferred={selected.preferred_clip_id === key} showPreview onSelect={setSelectedClipId} onPrefer={(clipId) => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === clipId ? "" : clipId })} />
                        <div className="golden-angle-fields">
                          <label><span>机位</span><input value={attachment.camera} onChange={(event) => patchAttachment(selected.record_id, key, { camera: event.target.value })} /></label>
                          <label><span>景别</span><select value={attachment.shot_type || "unknown"} onChange={(event) => patchAttachment(selected.record_id, key, { shot_type: event.target.value })}>{SHOT_OPTIONS.map((shot) => <option value={shot} key={shot}>{shot}</option>)}</select></label>
                          <label className="golden-angle-note"><span>素材备注</span><input value={attachment.note || ""} onChange={(event) => patchAttachment(selected.record_id, key, { note: event.target.value })} placeholder="该机位独立备注" /></label>
                        </div>
                        <div className="golden-angle-actions"><button type="button" className="secondary" onClick={() => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === key ? "" : key })}>{selected.preferred_clip_id === key ? "★ 取消首选" : "☆ 场记首选"}</button><button type="button" className="secondary danger-text" onClick={() => removeAttachment(selected.record_id, key)}>− 移除</button></div>
                      </div>
                    );
                  })}
                  {!inspectorAttachments.length ? <button type="button" className="golden-inspector-add-take" onClick={() => setTakePickerOpen(true)}>＋ 加入 Take / 镜头</button> : null}
                </section>

                <div className="golden-io-row"><button type="button" className="secondary" onClick={() => setIO("in")}>I 设入点</button><label><span>入点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.start ?? ""} onChange={(event) => { const start = event.target.value ? Number(event.target.value) : 0; const end = selected.usable_range?.end ?? start + 0.04; patchRecord(selected.record_id, { usable_range: { start, end: Math.max(end, start + 0.04) } }); }} /></label><label><span>出点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.end ?? ""} onChange={(event) => { const end = event.target.value ? Number(event.target.value) : 0; const start = selected.usable_range?.start ?? 0; if (end > start) patchRecord(selected.record_id, { usable_range: { start, end } }); }} /></label><button type="button" className="secondary" onClick={() => setIO("out")}>O 设出点</button></div>
                <label className="golden-inspector-field"><span>备注</span><textarea rows={4} value={selected.note} onChange={(event) => patchRecord(selected.record_id, { note: event.target.value })} placeholder="场记原话、可用范围描述、连续性提醒…" /></label>
                <div className="golden-inspector-link"><span>关联</span><strong>{selected.source_group_id ? `Take · ${selected.source_group_id}` : "独立场记"}</strong>{selected.script_scene_id ? <small>剧本场景 · {selected.script_scene_id}</small> : null}<small>{selectedTake?.transcript.text || "没有 Take 转写证据"}</small></div>
                <div className="golden-inspector-actions"><button type="button" disabled={busy || !selected.dirty || !actor.trim()} onClick={() => void saveSelected()}>保存当前行</button><button type="button" className="danger-subtle" disabled={busy} onClick={() => void deleteSelected()}>删除场记</button></div>
              </>
            ) : <div className="golden-inspector-empty">选择一行或一张机位卡。</div>}
          </aside>
        ) : null}
      </div>

      <details className="golden-slate-review-tools"><summary>Review 归集辅助 · 待归集 / 已归集 / 已排除 / 孤立素材 / 场景目标</summary><SlateWorkbench baseUrl={baseUrl} projectId={projectId} /></details>
    </section>
  );
}
