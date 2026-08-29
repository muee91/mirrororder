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
}

type Draft = SlateRecord & { dirty: boolean; derived: boolean; xmlOrder: number };

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

function draftFromRecord(record: SlateRecord, take: ReviewTakeGroup | null, xmlOrder: number): Draft {
  return { ...record, attachments: mergeTakeAttachments(record, take), dirty: false, derived: false, xmlOrder };
}

function draftFromTake(take: ReviewTakeGroup, xmlOrder: number): Draft {
  return {
    record_id: `take-${take.group_id}`,
    source_group_id: take.group_id,
    script_scene_id: "",
    episode: null,
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
  return [...persisted, ...derived].sort((left, right) => {
    const leftEpisode = left.episode ?? Number.MAX_SAFE_INTEGER;
    const rightEpisode = right.episode ?? Number.MAX_SAFE_INTEGER;
    if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode;
    const scene = left.scene.localeCompare(right.scene, "zh-CN", { numeric: true });
    if (scene) return scene;
    const shot = left.shot.localeCompare(right.shot, "zh-CN", { numeric: true });
    if (shot) return shot;
    const take = (left.take_number ?? Number.MAX_SAFE_INTEGER) - (right.take_number ?? Number.MAX_SAFE_INTEGER);
    return take || left.xmlOrder - right.xmlOrder;
  });
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

export function GoldenSlateWorkbench({ baseUrl, projectId }: Props) {
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
  const [parsed, setParsed] = useState<SlateParseResult | null>(null);
  const [message, setMessage] = useState("正在读取多机位电子场记…");
  const [busy, setBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [dropActive, setDropActive] = useState(false);
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
    setSelectedClipId(selected?.preferred_clip_id || selected?.attachments[0]?.clip_id || "");
    setMessage(`场记已同步 · Slate r${nextBoard.revision} · ${nextDrafts.length} 行`);
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
        setSelectedClipId(first?.preferred_clip_id || first?.attachments[0]?.clip_id || "");
        setMessage(`场记已同步 · Slate r${nextBoard.revision} · ${nextDrafts.length} 行`);
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

  useEffect(() => {
    if (!selected) return;
    if (selectedClipId && selected.attachments.some((item) => attachmentKey(item) === selectedClipId)) return;
    setSelectedClipId(selected.preferred_clip_id || attachmentKey(selected.attachments[0] ?? { clip_id: "", media_id: "", camera: "", display_name: "", shot_type: "unknown", source_role: "sync_camera", note: "" }));
  }, [selected, selectedClipId]);

  function patchRecord(recordId: string, patch: Partial<Draft>): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? { ...row, ...patch, dirty: true } : row));
  }

  function patchAttachment(recordId: string, key: string, patch: Partial<SlateAttachment>): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? {
      ...row,
      attachments: row.attachments.map((attachment) => attachmentKey(attachment) === key ? { ...attachment, ...patch } : attachment),
      dirty: true,
    } : row));
  }

  function selectRecord(recordId: string): void {
    const row = drafts.find((item) => item.record_id === recordId) ?? null;
    setSelectedRecordId(recordId);
    setSelectedClipId(row?.preferred_clip_id || (row?.attachments[0] ? attachmentKey(row.attachments[0]) : ""));
    setParsed(null);
  }

  function addBlank(seed?: Partial<Draft>): Draft {
    const row = blankDraft(seed);
    setDrafts((current) => [...current, row]);
    setSelectedRecordId(row.record_id);
    setSelectedClipId("");
    setParsed(null);
    setQuickText("");
    setMessage("已新增空白场记；填写后保存。当前尚未写入项目。");
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
    setMessage("已把上一条的集 / 场 / 镜 / 状态填入当前行；素材与 I/O 未复制。");
  }

  function focusNextUnpersistedTake(): void {
    const row = drafts.find((item) => item.derived && item.source_group_id);
    if (!row) {
      setMessage("当前 Review Take 都已有场记记录。");
      return;
    }
    selectRecord(row.record_id);
    setMessage(`已定位 ${row.source_group_id}；编辑并保存后写入场记。`);
  }

  function attachResolvedMedia(items: SlateResolvedMediaItem[]): void {
    if (!items.length) return;
    const additions = items.map(attachmentFromResolved);
    if (selectedRecordId) {
      setDrafts((current) => current.map((row) => row.record_id === selectedRecordId ? {
        ...row,
        attachments: mergeAttachments(row.attachments, additions),
        dirty: true,
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
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropActive(true);
        return;
      }
      if (event.payload.type === "leave") {
        setDropActive(false);
        return;
      }
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
    return () => {
      disposed = true;
      unlisten?.();
    };
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
        ? saved ? draftFromRecord(saved, review?.take_groups.find((take) => take.group_id === saved.source_group_id) ?? null, row.xmlOrder) : { ...row, dirty: false, derived: false }
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
      setMessage(`${errorMessage(error)}；顺序保存已停止，未执行的行保持 dirty。`);
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

  async function parseQuick(): Promise<void> {
    if (!selected || !quickText.trim() || busy) return;
    setBusy(true);
    setMessage("正在解析场记原话…");
    try {
      const payload = await production.parseSlate(projectId, quickText, parsePrevious(selected));
      setParsed(payload.result);
      setMessage("解析完成；先核对，再应用到当前行。不会自动保存。");
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function applyParsed(): void {
    if (!selected || !parsed) return;
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
    setParsed(null);
    setQuickText("");
    setMessage("解析结果已填入当前行；仍需保存才会写入项目。");
  }

  function setIO(kind: "in" | "out"): void {
    if (!selected) return;
    const current = playerRef.current?.currentTime;
    if (typeof current !== "number" || !Number.isFinite(current)) { setMessage("当前没有可用播放器时间点。"); return; }
    const previous = selected.usable_range;
    if (kind === "in") {
      const end = previous?.end && previous.end > current ? previous.end : current + 0.04;
      patchRecord(selected.record_id, { usable_range: { start: current, end } });
      setMessage(`已设入点 ${current.toFixed(2)}s；这是人工场记范围。`);
    } else {
      const start = previous?.start ?? 0;
      if (current <= start) { setMessage("出点必须晚于入点。"); return; }
      patchRecord(selected.record_id, { usable_range: { start, end: current } });
      setMessage(`已设出点 ${current.toFixed(2)}s；这是人工场记范围。`);
    }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable=true]"));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveAll();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        addBlank();
        return;
      }
      if (!editing && event.key.toLowerCase() === "i") { event.preventDefault(); setIO("in"); }
      if (!editing && event.key.toLowerCase() === "o") { event.preventDefault(); setIO("out"); }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  });

  function mediaCell(draft: Draft, camera: "A" | "B" | "C" | "AUX") {
    const row = primaryAttachment(draft, camera);
    if (!row) return <span className="golden-slate-empty-media">—</span>;
    const angle = findReviewAngle(review, row.item.clip_id, row.item.media_id);
    const model = angle ? mediaCardFromAngle(angle, row.item) : mediaCardFromAttachment(row.item);
    model.duplicateCount = row.count;
    return <MirrorOrderMediaCard model={model} compact selected={draft.record_id === selectedRecordId && model.id === selectedClipId} preferred={draft.preferred_clip_id === model.id} onSelect={() => { selectRecord(draft.record_id); setSelectedClipId(model.id); }} />;
  }

  const inspectorAttachments = selected?.attachments ?? [];

  return (
    <section className={`golden-slate-workbench ${inspectorOpen ? "has-inspector" : ""} ${dropActive ? "is-file-drop-active" : ""}`}>
      <header className="golden-slate-toolbar">
        <div className="golden-slate-title">
          <p className="eyebrow">Production</p>
          <h2>多机位电子场记</h2>
          <span>{message}</span>
        </div>
        <div className="golden-slate-actions">
          <input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="操作者" aria-label="场记操作者" />
          <button type="button" className="secondary" onClick={focusNextUnpersistedTake}>从 Take 加入</button>
          <button type="button" onClick={() => addBlank()}>新建场记</button>
          <button type="button" className={`secondary ${inspectorOpen ? "is-active" : ""}`} onClick={() => setInspectorOpen((value) => !value)}>Inspector</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void reload(selectedRecordId)}>刷新</button>
          <button type="button" disabled={busy || dirtyCount === 0 || !actor.trim()} onClick={() => void saveAll()}>保存{dirtyCount ? ` (${dirtyCount})` : ""}</button>
        </div>
      </header>

      <section className="golden-slate-quick">
        <textarea value={quickText} onChange={(event) => { setQuickText(event.target.value); setParsed(null); }} rows={2} placeholder="快速录入：EP3 12场 3镜 第2条 B近 前半段可用；原话中的模糊范围只保留文字，不推导秒数" />
        <div className="golden-slate-quick-actions">
          <button type="button" className="secondary" disabled={!selected || busy || !quickText.trim()} onClick={() => void parseQuick()}>解析</button>
          <button type="button" disabled={!parsed || !selected} onClick={applyParsed}>填入</button>
          <button type="button" className="secondary" onClick={nextSameScene}>同场下一条</button>
          <button type="button" className="secondary" onClick={inheritPrevious}>同上</button>
          <button type="button" className="secondary" onClick={() => addBlank()}>空白</button>
        </div>
        {parsed ? <div className="golden-slate-parse"><strong>待确认</strong><span>{[parsed.episode ? `EP${parsed.episode}` : "", parsed.scene, parsed.shot, parsed.take_number ? `第${parsed.take_number}条` : "", parsed.status].filter(Boolean).join(" · ")}</span><small>{parsed.note}{parsed.range_hint ? ` · 范围原话：${parsed.range_hint}` : ""}</small></div> : null}
      </section>

      <div className="golden-slate-body">
        <div className="golden-slate-table-shell">
          {dropActive ? <div className="golden-slate-drop-overlay">松开，把 Finder / Explorer 素材加入当前场记行</div> : null}
          <table className="golden-slate-table">
            <thead><tr><th className="col-index">序号</th><th className="col-number">集</th><th className="col-text">场号</th><th className="col-text">镜号</th><th className="col-number">次号</th><th className="col-media">A机</th><th className="col-media">B机</th><th className="col-media">C机</th><th className="col-media">辅助 / 特殊</th><th className="col-status">状态</th></tr></thead>
            <tbody>
              {drafts.map((draft, index) => (
                <tr key={draft.record_id} className={`${draft.record_id === selectedRecordId ? "is-selected" : ""} ${draft.dirty ? "is-dirty" : ""}`} onClick={() => selectRecord(draft.record_id)}>
                  <td className="col-index"><strong>{index + 1}</strong>{draft.derived ? <small>Take</small> : draft.dirty ? <small>未保存</small> : null}</td>
                  <td className="col-number"><input type="number" min={1} value={draft.episode ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { episode: event.target.value ? Number(event.target.value) : null })} /></td>
                  <td className="col-text"><input value={draft.scene} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { scene: event.target.value })} /></td>
                  <td className="col-text"><input value={draft.shot} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { shot: event.target.value })} /></td>
                  <td className="col-number"><input type="number" min={1} value={draft.take_number ?? ""} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { take_number: event.target.value ? Number(event.target.value) : null })} /></td>
                  <td className="col-media">{mediaCell(draft, "A")}</td>
                  <td className="col-media">{mediaCell(draft, "B")}</td>
                  <td className="col-media">{mediaCell(draft, "C")}</td>
                  <td className="col-media">{mediaCell(draft, "AUX")}</td>
                  <td className="col-status"><select value={draft.status} onClick={(event) => event.stopPropagation()} onChange={(event) => patchRecord(draft.record_id, { status: event.target.value as SlateStatus })}>{STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!drafts.length ? <div className="golden-slate-empty">当前没有场记记录或 Review Take。可以直接新建空白场记，或从 Finder / Explorer 拖入素材。</div> : null}
        </div>

        {inspectorOpen ? (
          <aside className="golden-slate-inspector">
            {selected ? (
              <>
                <div className="golden-inspector-head"><div><p className="eyebrow">当前场记</p><strong>#{selectedIndex + 1} · {selected.episode ? `EP${selected.episode}` : "未定集"} · {selected.scene || "未定场"} · {selected.shot || "未定镜"} · {selected.take_number ? `第${selected.take_number}条` : "未定次"}</strong></div><span>{selected.dirty ? "未保存" : board?.records[selected.record_id] ? "已保存" : "Take 投影"}</span></div>

                <div className="golden-slate-player">
                  {selectedAngle?.playback.url && selectedAngle.playback.available !== false ? (
                    <video ref={playerRef} key={selectedAngle.clip_id} src={selectedAngle.playback.url} controls preload="metadata" onLoadedMetadata={(event) => { const video = event.currentTarget; const start = selectedAngle.playback.source_start ?? selectedAngle.source_start ?? 0; if (start > 0) { try { video.currentTime = start; } catch { /* safe fallback */ } } }} />
                  ) : <div className="golden-player-empty">选择已索引且可播放的机位查看素材</div>}
                </div>

                <div className="golden-inspector-media">
                  {inspectorAttachments.map((attachment) => {
                    const key = attachmentKey(attachment);
                    const angle = findReviewAngle(review, attachment.clip_id, attachment.media_id);
                    const model = angle ? mediaCardFromAngle(angle, attachment) : mediaCardFromAttachment(attachment);
                    return (
                      <div className="golden-angle-editor" key={`${attachment.clip_id}-${attachment.media_id}`}>
                        <MirrorOrderMediaCard model={model} selected={key === selectedClipId} preferred={selected.preferred_clip_id === key} showPreview={key === selectedClipId} onSelect={setSelectedClipId} onPrefer={(clipId) => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === clipId ? "" : clipId })} />
                        <div className="golden-angle-fields">
                          <label><span>机位</span><input value={attachment.camera} onChange={(event) => patchAttachment(selected.record_id, key, { camera: event.target.value })} /></label>
                          <label><span>景别</span><select value={attachment.shot_type || "unknown"} onChange={(event) => patchAttachment(selected.record_id, key, { shot_type: event.target.value })}>{SHOT_OPTIONS.map((shot) => <option value={shot} key={shot}>{shot}</option>)}</select></label>
                          <label className="golden-angle-note"><span>素材备注</span><input value={attachment.note || ""} onChange={(event) => patchAttachment(selected.record_id, key, { note: event.target.value })} placeholder="该机位独立备注" /></label>
                        </div>
                      </div>
                    );
                  })}
                  {!inspectorAttachments.length ? <span className="golden-inspector-empty">当前行没有关联素材；独立场记允许先记录文字事实，也可以直接从 Finder / Explorer 拖入。</span> : null}
                </div>

                <div className="golden-io-row">
                  <button type="button" className="secondary" onClick={() => setIO("in")}>I 设入点</button>
                  <label><span>入点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.start ?? ""} onChange={(event) => { const start = event.target.value ? Number(event.target.value) : 0; const end = selected.usable_range?.end ?? start + 0.04; patchRecord(selected.record_id, { usable_range: { start, end: Math.max(end, start + 0.04) } }); }} /></label>
                  <label><span>出点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.end ?? ""} onChange={(event) => { const end = event.target.value ? Number(event.target.value) : 0; const start = selected.usable_range?.start ?? 0; if (end > start) patchRecord(selected.record_id, { usable_range: { start, end } }); }} /></label>
                  <button type="button" className="secondary" onClick={() => setIO("out")}>O 设出点</button>
                </div>

                <label className="golden-inspector-field"><span>备注</span><textarea rows={5} value={selected.note} onChange={(event) => patchRecord(selected.record_id, { note: event.target.value })} placeholder="场记原话、可用范围描述、连续性提醒…" /></label>
                <label className="golden-inspector-field"><span>剧本场景 ID</span><input value={selected.script_scene_id} onChange={(event) => patchRecord(selected.record_id, { script_scene_id: event.target.value })} placeholder="只有明确关联时填写，不从场号猜测" /></label>
                <div className="golden-inspector-link"><span>Take</span><strong>{selected.source_group_id || "独立场记"}</strong><small>{selectedTake?.transcript.text || "没有 Take 转写证据"}</small></div>
                <div className="golden-inspector-actions"><button type="button" disabled={busy || !selected.dirty || !actor.trim()} onClick={() => void saveSelected()}>保存当前行</button><button type="button" className="danger-subtle" disabled={busy} onClick={() => void deleteSelected()}>删除场记记录</button></div>
              </>
            ) : <div className="golden-inspector-empty">选择一行场记查看 Inspector。</div>}
          </aside>
        ) : null}
      </div>

      <footer className="golden-slate-footer"><span>⌘N 新建 · ⌘S 顺序保存 · I/O 设置人工可用范围 · Finder/Explorer 拖入附加到当前行</span><span>preferred clip 是场记首选机位，不是 Editorial Best。</span></footer>

      <details className="golden-slate-review-tools">
        <summary>Review 归集辅助 · 待归集 / 已归集 / 已排除 / 孤立素材 / 场景目标</summary>
        <div className="golden-slate-review-note">现有 Review placement 工具暂时完整保留在这里；下一阶段会把这些池抽成主场记下方的专用辅助区，不再重复旧表格。</div>
        <SlateWorkbench baseUrl={baseUrl} projectId={projectId} />
      </details>
    </section>
  );
}
