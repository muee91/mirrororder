import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload, type ReviewTakeGroup } from "../../api/host";
import { MediaRoleClient, type MediaInventoryItem } from "../../api/mediaRoles";
import { ProductionClient, type SlateBoard, type SlateEntry, type SlateParseResult } from "../../api/production";
import {
  buildSlateSceneTargets,
  buildSlatePools,
  createSlateTakeDragPayload,
  decodeSlateTakeDragPayload,
  hasHumanPlacement,
  isReviewExcluded,
  SLATE_TAKE_MIME,
  type SlateSceneTarget,
  type SlateTakeDragPayload,
} from "./slatePools";
import "./slate-table.css";

interface Props {
  baseUrl: string;
  projectId: string;
}

const ACTOR_KEY = "mirrororder.desktop.review-actor";

function readActor(): string {
  try {
    return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function takeLabel(take: ReviewTakeGroup): string {
  const cameras = take.angles.map((angle) => angle.camera).filter(Boolean).join("/");
  return `${take.group_id}${cameras ? ` · ${cameras}` : ""}`;
}

function parseSummary(result: SlateParseResult): string {
  const bits = [
    result.episode ? `EP${result.episode}` : "",
    result.scene ? `场 ${result.scene}` : "",
    result.shot ? `镜 ${result.shot}` : "",
    result.take_number ? `第 ${result.take_number} 条` : "",
    result.status !== "unmarked" ? result.status : "",
  ].filter(Boolean);
  return bits.join(" · ") || "只记录原始备注";
}

function entryAngles(take: ReviewTakeGroup, entry: SlateEntry | null): string[] {
  return take.angles.map((angle) => {
    const shot = entry?.angles?.[angle.clip_id]?.shot_type || "—";
    return `${angle.camera || "—"}:${shot}`;
  });
}

function statusLabel(value: string): string {
  return {
    usable: "可用",
    partial: "部分可用",
    ng: "NG",
    unmarked: "未标记",
  }[value] ?? value;
}

function reviewWriteNeedsRefresh(error: unknown): boolean {
  return error instanceof HostConnectionError && (error.status === 409 || error.message.includes("请刷新"));
}

function PoolCard({
  take,
  detail,
  action,
  actionLabel,
  onSelect,
  onDragStart,
}: {
  take: ReviewTakeGroup;
  detail?: string;
  action?: () => void;
  actionLabel?: string;
  onSelect: () => void;
  onDragStart: (event: DragEvent<HTMLElement>, take: ReviewTakeGroup) => void;
}) {
  return (
    <div
      className="slate-pool-item"
      draggable
      onClick={onSelect}
      onDragStart={(event) => onDragStart(event, take)}
      title="拖到场景目标以人工归集；拖回待归集以清除人工归集"
    >
      <div className="slate-pool-item-main">
        <strong>{take.group_id}</strong>
        <span>{detail || take.angles.map((angle) => angle.camera).filter(Boolean).join("/") || "无机位"}</span>
      </div>
      {action && actionLabel ? <button type="button" className="slate-pool-action" onClick={(event) => { event.stopPropagation(); action(); }}>{actionLabel}</button> : null}
    </div>
  );
}

function placementLabel(take: ReviewTakeGroup, targets: SlateSceneTarget[]): string {
  const placement = take.editorial_state.legacy_manual?.placement;
  if (!placement) return "已归集";
  const segmentIds = placement.script_segment_ids?.filter(Boolean) ?? [];
  const episode = placement.episode_ids?.[0];
  const target = segmentIds.length && episode
    ? targets.find((item) => (
      item.episode === episode &&
      item.segmentIds.length === segmentIds.length &&
      item.segmentIds.every((segmentId, index) => segmentId === segmentIds[index])
    ))
    : undefined;
  if (target) return `EP${target.episode} · ${target.sceneId} · ${target.segmentIds.length}段`;
  if (episode && segmentIds.length) return `EP${episode} · ${segmentIds.length}段`;
  if (episode) return `EP${episode} · episode-only`;
  return segmentIds.length ? `${segmentIds.length}段` : "已归集";
}

function PoolSection({ title, count, children, dropTarget, onDrop }: { title: string; count: number; children: ReactNode; dropTarget?: boolean; onDrop?: (event: DragEvent<HTMLDivElement>) => void }) {
  return (
    <section className={`slate-pool ${dropTarget ? "slate-pool-drop-target" : ""}`} onDragOver={dropTarget ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } : undefined} onDrop={dropTarget ? onDrop : undefined}>
      <header><strong>{title}</strong><span>{count}</span></header>
      <div className="slate-pool-list">{children}</div>
    </section>
  );
}

export function SlateWorkbench({ baseUrl, projectId }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const media = useMemo(() => new MediaRoleClient(baseUrl), [baseUrl]);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [board, setBoard] = useState<SlateBoard | null>(null);
  const [mediaItems, setMediaItems] = useState<MediaInventoryItem[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [quickText, setQuickText] = useState("");
  const [parsed, setParsed] = useState<SlateParseResult | null>(null);
  const [actor, setActor] = useState(readActor);
  const [message, setMessage] = useState("正在读取电子场记…");
  const [busy, setBusy] = useState(false);
  const quickInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessage("正在读取电子场记…");
    Promise.all([host.reviewModel(projectId), production.scriptSupervisor(projectId), media.inventory(projectId)])
      .then(([nextReview, nextBoard, nextInventory]) => {
        if (cancelled) return;
        setReview(nextReview);
        setBoard(nextBoard);
        setMediaItems(nextInventory.items);
        setSelectedGroupId((current) => current || nextReview.take_groups[0]?.group_id || "");
        setMessage(`场记已同步 · r${nextBoard.revision}`);
        globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
      })
      .catch((error) => {
        if (!cancelled) setMessage(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, [host, media, production, projectId]);

  const takes = review?.take_groups ?? [];
  const pools = useMemo(() => buildSlatePools(takes, mediaItems), [mediaItems, takes]);
  const targets = useMemo(() => buildSlateSceneTargets(review), [review]);
  const selectedIndex = takes.findIndex((take) => take.group_id === selectedGroupId);
  const selectedTake = selectedIndex >= 0 ? takes[selectedIndex] : null;
  const existing = board?.entries[selectedGroupId] ?? null;

  async function reloadSlate(): Promise<void> {
    const [nextReview, nextBoard, nextInventory] = await Promise.all([
      host.reviewModel(projectId),
      production.scriptSupervisor(projectId),
      media.inventory(projectId),
    ]);
    setReview(nextReview);
    setBoard(nextBoard);
    setMediaItems(nextInventory.items);
    setSelectedGroupId((current) => current && nextReview.take_groups.some((take) => take.group_id === current) ? current : nextReview.take_groups[0]?.group_id || "");
    setMessage(`场记已同步 · Review r${nextReview.revisions.review} · Slate r${nextBoard.revision}`);
  }

  function beginSlateDrag(event: DragEvent<HTMLElement>, take: ReviewTakeGroup): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(SLATE_TAKE_MIME, JSON.stringify(createSlateTakeDragPayload(take)));
    event.dataTransfer.setData("text/plain", take.group_id);
  }

  function readSlateDrag(event: DragEvent<HTMLElement>): SlateTakeDragPayload | null {
    return decodeSlateTakeDragPayload(event.dataTransfer.getData(SLATE_TAKE_MIME));
  }

  async function placeDraggedTake(payload: SlateTakeDragPayload, target: SlateSceneTarget): Promise<void> {
    if (target.segmentIds.length === 0) {
      setMessage("本场没有可归集剧本段。");
      return;
    }
    const take = takes.find((item) => item.group_id === payload.groupId);
    if (!take || isReviewExcluded(take)) {
      setMessage("该 Take 已排除或已不在当前项目，请刷新后重试。恢复排除项后才能归集。");
      return;
    }
    if (!review) return;
    if (!actor.trim()) {
      setMessage("拖放归集前需要操作者昵称。");
      return;
    }
    const expectedRevision = review.revisions.review;
    setBusy(true);
    setMessage(`正在将 ${payload.groupId} 拖入 EP${target.episode} · ${target.sceneId}…`);
    try {
      globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim());
      await host.setGroupPlacement(projectId, {
        groupId: payload.groupId,
        actor,
        expectedRevision,
        episodeIds: [target.episode],
        scriptSegmentIds: target.segmentIds,
        interaction: "drag",
        sourceSurface: "slate-table",
        sourceKind: payload.sourceKind,
        sourceClipId: payload.sourceClipId,
      });
      await reloadSlate();
      setMessage(`已人工归集 ${payload.groupId} → EP${target.episode} · ${target.sceneId}`);
    } catch (error) {
      if (reviewWriteNeedsRefresh(error)) {
        await reloadSlate().catch(() => undefined);
        setMessage("Review 已被其他操作更新，已刷新到最新 revision；请重新拖放。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearOrRestoreDraggedTake(payload: SlateTakeDragPayload): Promise<void> {
    const take = takes.find((item) => item.group_id === payload.groupId);
    if (!take || !review) {
      setMessage("拖放的 Take 已不在当前项目，请刷新后重试。");
      return;
    }
    if (!actor.trim()) {
      setMessage("清除归集或恢复排除前需要操作者昵称。");
      return;
    }
    const expectedRevision = review.revisions.review;
    setBusy(true);
    setMessage(isReviewExcluded(take) ? `正在恢复 ${payload.groupId}…` : `正在清除 ${payload.groupId} 的人工归集…`);
    try {
      globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim());
      if (isReviewExcluded(take)) {
        await host.setGroupExclusion(projectId, {
          groupId: payload.groupId,
          actor,
          excluded: false,
          expectedRevision,
          interaction: "drag",
          sourceSurface: "slate-table",
          sourceClipId: payload.sourceClipId,
        });
      } else if (hasHumanPlacement(take)) {
        await host.clearGroupPlacement(projectId, {
          groupId: payload.groupId,
          actor,
          expectedRevision,
          interaction: "drag",
          sourceSurface: "slate-table",
          sourceKind: payload.sourceKind,
          sourceClipId: payload.sourceClipId,
        });
      } else {
        setMessage("只有已归集或已排除的 Take 可以拖回待归集。");
        return;
      }
      await reloadSlate();
      setMessage(isReviewExcluded(take) ? `已恢复 ${payload.groupId}，现在位于待归集` : `已清除 ${payload.groupId} 的人工归集，场记事实保留`);
    } catch (error) {
      if (reviewWriteNeedsRefresh(error)) {
        await reloadSlate().catch(() => undefined);
        setMessage("Review 已被其他操作更新，已刷新到最新 revision；请重新拖放。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function setExcluded(take: ReviewTakeGroup, excluded: boolean): Promise<void> {
    if (!review || !actor.trim()) {
      setMessage("排除或恢复前需要操作者昵称。");
      return;
    }
    setBusy(true);
    try {
      globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim());
      await host.setGroupExclusion(projectId, {
        groupId: take.group_id,
        actor,
        excluded,
        expectedRevision: review.revisions.review,
        sourceSurface: "slate-table",
        sourceClipId: take.angles[0]?.clip_id,
      });
      await reloadSlate();
      setMessage(excluded ? `已排除 ${take.group_id}；这是 Review 排除状态，不是场记 NG` : `已恢复 ${take.group_id} 到待归集`);
    } catch (error) {
      if (reviewWriteNeedsRefresh(error)) {
        await reloadSlate().catch(() => undefined);
        setMessage("Review 已被其他操作更新，已刷新到最新 revision；请重新操作。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSceneDrop(event: DragEvent<HTMLButtonElement>, target: SlateSceneTarget): void {
    event.preventDefault();
    const payload = readSlateDrag(event);
    if (payload) void placeDraggedTake(payload, target);
  }

  function handlePendingDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const payload = readSlateDrag(event);
    if (payload) void clearOrRestoreDraggedTake(payload);
  }

  function selectTakeAt(index: number): void {
    const next = takes[index];
    if (!next) return;
    setSelectedGroupId(next.group_id);
    setParsed(null);
    setQuickText("");
    globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
  }

  function selectTake(groupId: string): void {
    const nextIndex = takes.findIndex((take) => take.group_id === groupId);
    if (nextIndex >= 0) selectTakeAt(nextIndex);
  }

  function moveTake(delta: -1 | 1): void {
    if (!takes.length) return;
    const origin = selectedIndex >= 0 ? selectedIndex : 0;
    const next = Math.max(0, Math.min(takes.length - 1, origin + delta));
    if (next !== origin) selectTakeAt(next);
  }

  async function parseQuickEntry(): Promise<void> {
    if (!selectedTake || !quickText.trim()) return;
    setBusy(true);
    setMessage("正在解析场记原话…");
    try {
      const response = await production.parseSlate(projectId, quickText, existing ?? undefined);
      setParsed(response.result);
      setMessage("解析完成，请确认后写入。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmParsed(): Promise<void> {
    if (!selectedTake || !board || !parsed) return;
    if (!actor.trim()) {
      setMessage("写入场记前需要操作者昵称。");
      return;
    }

    const angles: SlateEntry["angles"] = { ...(existing?.angles ?? {}) };
    for (const angle of selectedTake.angles) {
      const camera = angle.camera.trim().toUpperCase().replace(/机/g, "");
      const shotType = parsed.angle_shots[camera];
      if (shotType) {
        angles[angle.clip_id] = { shot_type: shotType, note: existing?.angles?.[angle.clip_id]?.note ?? "" };
      }
    }

    const entry: Partial<SlateEntry> = { note: parsed.note, angles };
    if (parsed.episode !== null) entry.episode = parsed.episode;
    if (parsed.scene) entry.scene = parsed.scene;
    if (parsed.shot) entry.shot = parsed.shot;
    if (parsed.take_number !== null) entry.take_number = parsed.take_number;
    if (parsed.status !== "unmarked" || !existing) entry.status = parsed.status;

    const completedIndex = selectedIndex;
    setBusy(true);
    setMessage("正在写入人工场记…");
    try {
      globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim());
      const next = await production.writeSlateEntry(projectId, {
        groupId: selectedTake.group_id,
        expectedRevision: board.revision,
        actor,
        entry,
      });
      setBoard(next);
      setParsed(null);
      setQuickText("");
      const nextTake = takes[completedIndex + 1];
      if (nextTake) {
        setSelectedGroupId(nextTake.group_id);
        setMessage(`已写入 · r${next.revision} · 已进入下一条 Take`);
      } else {
        setMessage(`已写入 · r${next.revision} · 已到最后一条 Take`);
      }
      globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
    } catch (error) {
      setMessage(errorMessage(error));
      if (error instanceof HostConnectionError && error.status === 409) {
        try {
          const latest = await production.scriptSupervisor(projectId);
          setBoard(latest);
          setMessage(`场记已被其他操作更新，已刷新到 r${latest.revision}；请重新确认。`);
        } catch {
          // Preserve the original conflict message if refresh also fails.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function handleQuickKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      moveTake(-1);
      return;
    }
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      moveTake(1);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (busy) return;
      if (parsed) void confirmParsed();
      else if (quickText.trim()) void parseQuickEntry();
    }
  }

  return (
    <section className="phase3-workbench slate-table-workbench">
      <header className="production-heading slate-heading">
        <div><p className="eyebrow">现场记录</p><h2>电子场记</h2></div>
        <div className="slate-heading-status"><strong>{selectedTake ? takeLabel(selectedTake) : "未选择 Take"}</strong><span>{message}</span></div>
      </header>

      <section className="slate-entry-bar" aria-label="场记快速录入">
        <div className="slate-entry-context">
          <button type="button" className="secondary" disabled={busy || selectedIndex <= 0} onClick={() => moveTake(-1)}>⌥↑</button>
          <select value={selectedGroupId} onChange={(event) => selectTake(event.target.value)} aria-label="当前 Take">
            {takes.map((take) => <option value={take.group_id} key={take.group_id}>{takeLabel(take)}</option>)}
          </select>
          <button type="button" className="secondary" disabled={busy || selectedIndex < 0 || selectedIndex >= takes.length - 1} onClick={() => moveTake(1)}>⌥↓</button>
          <input className="slate-actor-input" value={actor} onChange={(event) => setActor(event.target.value)} placeholder="场记员" aria-label="操作者昵称" />
        </div>
        <textarea
          ref={quickInputRef}
          value={quickText}
          onChange={(event) => { setQuickText(event.target.value); if (parsed) setParsed(null); }}
          onKeyDown={handleQuickKeyDown}
          placeholder="快速录入：EP3 12-3-2 B近 前半段可用；同场下一条 C特 看片再定"
          rows={2}
        />
        <button type="button" className="slate-primary-action" disabled={busy || (!parsed && !quickText.trim()) || !selectedTake || (Boolean(parsed) && !actor.trim())} onClick={() => parsed ? void confirmParsed() : void parseQuickEntry()}>
          {parsed ? "确认写入 ⌘↵" : "解析 ⌘↵"}
        </button>
      </section>

      {parsed ? (
        <section className="slate-parse-inline">
          <div><span>待确认</span><strong>{parseSummary(parsed)}</strong><p>{parsed.note}</p></div>
          <div className="slate-parse-facts">
            {Object.entries(parsed.angle_shots).map(([camera, shot]) => <span key={camera}>{camera} · {shot}</span>)}
            {parsed.range_hint ? <span>范围：{parsed.range_hint} · 原话保留，不生成虚构秒数</span> : null}
            {parsed.generic_shot ? <em>通用景别 {parsed.generic_shot} 不会自动复制到 A/B/C</em> : null}
          </div>
        </section>
      ) : null}

      <section className="slate-intake" aria-label="场记素材归集池">
        <header className="slate-intake-heading">
          <div><strong>场记归集池</strong><span>拖 Take 到右侧场景直接写入 Review placement；场记表仍是生产事实。</span></div>
          <small>Review r{review?.revisions.review ?? "—"}</small>
        </header>
        <div className="slate-intake-layout">
          <aside className="slate-pools" aria-label="四个场记素材池">
            <PoolSection title="待归集" count={pools.pending.length} dropTarget onDrop={handlePendingDrop}>
              {pools.pending.length ? pools.pending.map((take) => (
                <PoolCard key={take.group_id} take={take} onSelect={() => selectTake(take.group_id)} onDragStart={beginSlateDrag} action={() => void setExcluded(take, true)} actionLabel="排除" />
              )) : <span className="slate-pool-empty">没有待归集 Take</span>}
            </PoolSection>
            <PoolSection title="已归集" count={pools.placed.length}>
              {pools.placed.length ? pools.placed.map((take) => (
                <PoolCard key={take.group_id} take={take} detail={placementLabel(take, targets)} onSelect={() => selectTake(take.group_id)} onDragStart={beginSlateDrag} />
              )) : <span className="slate-pool-empty">没有人工归集 Take</span>}
            </PoolSection>
            <PoolSection title="已排除" count={pools.excluded.length}>
              {pools.excluded.length ? pools.excluded.map((take) => (
                <PoolCard key={take.group_id} take={take} onSelect={() => selectTake(take.group_id)} onDragStart={beginSlateDrag} action={() => void setExcluded(take, false)} actionLabel="恢复" />
              )) : <span className="slate-pool-empty">没有 Review 排除项</span>}
            </PoolSection>
            <PoolSection title="孤立素材" count={pools.orphan.length}>
              {pools.orphan.length ? pools.orphan.map((item) => (
                <div className="slate-pool-item slate-orphan-item" key={item.media_id}>
                  <div className="slate-pool-item-main"><strong>{item.display_name || item.media_id}</strong><span>{item.folder_label || "未分组"} · {item.inferred_camera || "未知机位"}</span></div>
                  <small>{item.indexed ? "已索引" : "未索引"}</small>
                </div>
              )) : <span className="slate-pool-empty">没有未关联媒体</span>}
            </PoolSection>
          </aside>
          <div className="slate-scene-targets" aria-label="场记场景目标">
            <header><strong>场景目标</strong><span>放到场景行 = 该场全部剧本段；没有剧本段的场景不可归集</span></header>
            <div className="slate-scene-target-list">
              {targets.length ? targets.map((target) => (
                <button type="button" className="slate-scene-target" key={target.key} disabled={busy || target.segmentIds.length === 0} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => handleSceneDrop(event, target)}>
                  <strong>EP{target.episode} · {target.sceneId}</strong><span>{target.heading}</span><small>{target.segmentIds.length ? `${target.segmentIds.length} 个可归集剧本段` : "本场没有可归集剧本段"}</small>
                </button>
              )) : <span className="slate-pool-empty">当前项目没有可用场景目标</span>}
            </div>
          </div>
        </div>
      </section>

      <div className="slate-table-shell">
        <table className="slate-table">
          <thead>
            <tr>
              <th className="slate-col-take">Take</th>
              <th>集</th>
              <th>场</th>
              <th>镜</th>
              <th>条</th>
              <th className="slate-col-angle">机位 / 景别</th>
              <th>状态</th>
              <th className="slate-col-note">备注</th>
              <th>记录人</th>
            </tr>
          </thead>
          <tbody>
            {takes.map((take) => {
              const entry = board?.entries[take.group_id] ?? null;
              const selected = take.group_id === selectedGroupId;
              return (
                <tr
                  className={selected ? "is-selected" : ""}
                  key={take.group_id}
                  onClick={() => selectTake(take.group_id)}
                  draggable={hasHumanPlacement(take) || isReviewExcluded(take)}
                  onDragStart={(event) => { if (hasHumanPlacement(take) || isReviewExcluded(take)) beginSlateDrag(event, take); }}
                  title={hasHumanPlacement(take) ? "拖回左侧待归集以清除人工归集；场记表事实保留" : isReviewExcluded(take) ? "拖回待归集以恢复 Review" : undefined}
                >
                  <td className="slate-col-take"><strong>{take.group_id}</strong><small>{take.angles.map((angle) => angle.camera).filter(Boolean).join("/") || "—"}</small></td>
                  <td>{entry?.episode ? `EP${entry.episode}` : "—"}</td>
                  <td>{entry?.scene || "—"}</td>
                  <td>{entry?.shot || "—"}</td>
                  <td>{entry?.take_number ?? "—"}</td>
                  <td className="slate-col-angle"><div className="slate-angle-values">{entryAngles(take, entry).map((value) => <span key={`${take.group_id}-${value}`}>{value}</span>)}</div></td>
                  <td><span className={`slate-status slate-status-${entry?.status || "unmarked"}`}>{statusLabel(entry?.status || "unmarked")}</span></td>
                  <td className="slate-col-note" title={entry?.note || ""}>{entry?.note || "—"}</td>
                  <td>{entry?.actor || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="production-note slate-keyboard-note">⌥↑ / ⌥↓ 切换 Take；⌘/Ctrl+Enter 解析，再按一次确认并自动进入下一条。场记只记录生产事实，不改写 Review placement 或最终 Editorial Decision。</p>
    </section>
  );
}
