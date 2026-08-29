import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  HostConnection,
  HostConnectionError,
  type ProjectSummary,
  type ReviewModelPayload,
  type ReviewScriptBlock,
  type ReviewTakeGroup,
} from "../../api/host";
import { RoughPlacementClient, type RoughPlacementPayload } from "../../api/roughPlacement";
import { ScriptEpisodeView, dragGroupId } from "./ScriptEpisodeView";
import { TakeInspector } from "./TakeInspector";
import { VirtualTakeList, episodeLabel } from "./VirtualTakeList";
import {
  preferredScriptSegmentId,
  takeEpisodeIds,
  takeMatchesFilters,
  takeStatus,
  type TakeStatusFilter,
} from "./model";
import "./golden-material-script.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  initialMode?: "rough" | "precise";
  showEditorial?: boolean;
}

type WriteState = "idle" | "saving" | "error";

const STATUS_OPTIONS: Array<{ value: TakeStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "candidate", label: "AI候选" },
  { value: "pending", label: "待归集" },
  { value: "placed", label: "已归集" },
  { value: "rejected", label: "已排除" },
];
const ACTOR_KEY = "mirrororder.productionActor";

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function needsRefresh(error: unknown): boolean {
  return error instanceof HostConnectionError && (error.status === 409 || error.message.includes("请刷新"));
}

function storedActor(): string {
  try { return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() ?? ""; } catch { return ""; }
}

function saveActor(actor: string): void {
  try { globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim()); } catch { /* device-local only */ }
}

function previewLabel(plan: RoughPlacementPayload["plans"][number]): string {
  const range = plan.take_start === plan.take_end ? `T${plan.take_start}` : `T${plan.take_start}–T${plan.take_end}`;
  return `${range} → EP${plan.episode}`;
}

export function GoldenMaterialScriptWorkbench({
  baseUrl,
  project,
  initialGroupId = null,
  initialMode = "rough",
  showEditorial = false,
}: Props) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const rough = useMemo(() => new RoughPlacementClient(baseUrl), [baseUrl]);
  const [model, setModel] = useState<ReviewModelPayload | null>(null);
  const [mode, setMode] = useState<"rough" | "precise">(initialMode);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [roughEpisodeFilter, setRoughEpisodeFilter] = useState<number | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TakeStatusFilter>("all");
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [roughText, setRoughText] = useState("");
  const [roughPreview, setRoughPreview] = useState<RoughPlacementPayload | null>(null);
  const [message, setMessage] = useState("正在读取素材 / 剧本工作区…");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [writeMessage, setWriteMessage] = useState("");

  async function reload(preferredGroupId?: string | null): Promise<ReviewModelPayload> {
    const next = await connection.reviewModel(project.project_id);
    const focused = preferredGroupId ? next.take_groups.find((item) => item.group_id === preferredGroupId) ?? null : null;
    const current = selectedGroupId ? next.take_groups.find((item) => item.group_id === selectedGroupId) ?? null : null;
    const take = focused ?? current ?? next.take_groups[0] ?? null;
    setModel(next);
    setSelectedGroupId(take?.group_id ?? null);
    setSelectedClipId((clip) => take?.angles.some((angle) => angle.clip_id === clip) ? clip : take?.angles[0]?.clip_id ?? null);
    setActiveEpisode((value) => value && next.episodes.some((episode) => episode.episode === value) ? value : next.episodes[0]?.episode ?? null);
    setMessage(`review.v1 · Review r${next.revisions.review} · ${next.take_groups.length} Take`);
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    setMessage("正在读取素材 / 剧本工作区…");
    void connection.reviewModel(project.project_id).then((next) => {
      if (cancelled) return;
      const focused = initialGroupId ? next.take_groups.find((item) => item.group_id === initialGroupId) ?? null : null;
      const take = focused ?? next.take_groups[0] ?? null;
      setModel(next);
      setSelectedGroupId(take?.group_id ?? null);
      setSelectedClipId(take?.angles[0]?.clip_id ?? null);
      setActiveEpisode(next.episodes[0]?.episode ?? null);
      setMode(initialMode);
      setMessage(`review.v1 · Review r${next.revisions.review} · ${next.take_groups.length} Take`);
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [connection, initialGroupId, initialMode, project.project_id]);

  const takes = model?.take_groups ?? [];
  const episodes = model?.episodes ?? [];
  const filteredTakes = useMemo(
    () => takes.filter((take) => takeMatchesFilters(take, statusFilter, roughEpisodeFilter)),
    [roughEpisodeFilter, statusFilter, takes],
  );
  const selectedTake = selectedGroupId ? takes.find((take) => take.group_id === selectedGroupId) ?? null : null;
  const selectedEpisode = episodes.find((episode) => episode.episode === activeEpisode) ?? episodes[0] ?? null;
  const statusCounts = useMemo(() => {
    const counts = { candidate: 0, pending: 0, placed: 0, rejected: 0 };
    for (const take of takes) counts[takeStatus(take)] += 1;
    return counts;
  }, [takes]);

  useEffect(() => {
    if (!filteredTakes.length) return;
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      setSelectedGroupId(filteredTakes[0].group_id);
      setSelectedClipId(filteredTakes[0].angles[0]?.clip_id ?? null);
    }
  }, [filteredTakes, selectedGroupId]);

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
  }

  function showTakeInScript(take: ReviewTakeGroup): void {
    const episode = take.effective_mapping.episode_ids[0] ?? takeEpisodeIds(take)[0] ?? null;
    if (episode !== null) setActiveEpisode(episode);
    setSelectedSegmentId(preferredScriptSegmentId(take));
    setMode("precise");
  }

  function showScriptTake(groupId: string): void {
    const take = takes.find((item) => item.group_id === groupId);
    if (!take) return;
    setStatusFilter("all");
    setRoughEpisodeFilter(null);
    selectTake(take);
  }

  async function placeTake(groupId: string, episodeIds: number[], segmentIds: string[], interaction: "drag" | "click", surface: string): Promise<void> {
    if (!model) return;
    if (!actor.trim()) { setWriteState("error"); setWriteMessage("先填写操作者昵称，再写入人工归集。"); return; }
    setWriteState("saving");
    setWriteMessage("正在写入 Review 人工归集…");
    saveActor(actor);
    try {
      await connection.setGroupPlacement(project.project_id, {
        groupId,
        actor,
        expectedRevision: model.revisions.review,
        episodeIds,
        scriptSegmentIds: segmentIds,
        interaction,
        sourceSurface: surface,
        sourceClipId: groupId === selectedGroupId ? selectedClipId ?? undefined : undefined,
      });
      await reload(groupId);
      setWriteState("idle");
      setWriteMessage(segmentIds.length ? `已精确归集 ${groupId} → ${segmentIds.length} 个剧本段` : `已粗归集 ${groupId} → ${episodeIds.map(episodeLabel).join(" / ")}`);
    } catch (error) {
      setWriteState("error");
      if (needsRefresh(error)) {
        await reload(groupId).catch(() => undefined);
        setWriteMessage("Review 已变化，已刷新；请重新拖放。");
      } else setWriteMessage(errorMessage(error));
    } finally { setDraggingGroupId(null); }
  }

  async function clearPlacement(): Promise<void> {
    if (!selectedTake || !model) return;
    if (!actor.trim()) { setWriteState("error"); setWriteMessage("先填写操作者昵称。"); return; }
    setWriteState("saving");
    saveActor(actor);
    try {
      await connection.clearGroupPlacement(project.project_id, {
        groupId: selectedTake.group_id,
        actor,
        expectedRevision: model.revisions.review,
        sourceSurface: "golden-material-script",
      });
      await reload(selectedTake.group_id);
      setWriteState("idle");
      setWriteMessage(`已清除 ${selectedTake.group_id} 的人工归集；自动候选未改动。`);
    } catch (error) {
      setWriteState("error");
      if (needsRefresh(error)) {
        await reload(selectedTake.group_id).catch(() => undefined);
        setWriteMessage("Review 已变化，已刷新；请重新操作。");
      } else setWriteMessage(errorMessage(error));
    }
  }

  async function previewRough(): Promise<void> {
    if (!roughText.trim()) return;
    setWriteState("saving");
    setWriteMessage("正在解析粗场记范围…");
    try {
      const preview = await rough.preview(project.project_id, roughText);
      setRoughPreview(preview);
      setWriteState("idle");
      setWriteMessage(`已识别 ${preview.plans.length} 段范围；确认前不会写入 Review。`);
    } catch (error) { setWriteState("error"); setWriteMessage(errorMessage(error)); }
  }

  async function applyRough(): Promise<void> {
    if (!model || !roughPreview || !actor.trim()) { setWriteMessage("先预览粗归集并填写操作者昵称。"); return; }
    setWriteState("saving");
    setWriteMessage("正在确认粗归集…");
    saveActor(actor);
    try {
      const result = await rough.apply(project.project_id, roughText, actor, model.revisions.review);
      setRoughPreview(null);
      await reload(selectedGroupId);
      setWriteState("idle");
      setWriteMessage(`已粗归 ${result.resolved_groups} 个 Take · Review r${result.review_revision ?? "?"}`);
    } catch (error) {
      setWriteState("error");
      if (needsRefresh(error)) {
        await reload(selectedGroupId).catch(() => undefined);
        setRoughPreview(null);
        setWriteMessage("Review 已变化，预览已作废；请重新预览后确认。");
      } else setWriteMessage(errorMessage(error));
    }
  }

  function roughEpisodeDrop(event: DragEvent<HTMLButtonElement>, episode: number): void {
    event.preventDefault();
    const groupId = dragGroupId(event);
    if (groupId) void placeTake(groupId, [episode], [], "drag", "golden-material-script-rough-episode");
  }

  if (!model) {
    return <section className="golden-material-script"><div className="golden-ms-loading">{message}</div></section>;
  }

  return (
    <section className="golden-material-script">
      <header className="golden-ms-toolbar">
        <div><p className="eyebrow">Production</p><h2>素材 / 剧本</h2><span>{message}</span></div>
        <div className="golden-ms-mode" aria-label="工作阶段">
          <button type="button" className={mode === "rough" ? "is-active" : ""} onClick={() => setMode("rough")}>粗归集</button>
          <button type="button" className={mode === "precise" ? "is-active" : ""} onClick={() => setMode("precise")}>精确剧本</button>
        </div>
        <label className="golden-ms-actor"><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="写入时必填" /></label>
      </header>

      {mode === "rough" ? (
        <section className="golden-ms-rough-entry">
          <div><strong>粗场记</strong><span>只确定集数，不猜场号或对白。</span></div>
          <input value={roughText} onChange={(event) => { setRoughText(event.target.value); setRoughPreview(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void previewRough(); } }} placeholder="1-10 第1集；11-20 第2集" />
          <button type="button" className="secondary" disabled={writeState === "saving" || !roughText.trim()} onClick={() => void previewRough()}>预览</button>
          <button type="button" disabled={writeState === "saving" || !roughPreview || !actor.trim()} onClick={() => void applyRough()}>确认归集</button>
          {roughPreview ? <div className="golden-ms-preview">{roughPreview.plans.map((plan, index) => <span key={`${plan.take_start}-${plan.take_end}-${index}`}>{previewLabel(plan)}</span>)}</div> : null}
        </section>
      ) : null}

      <div className={`golden-ms-write write-${writeState}`}>{writeMessage || (mode === "rough" ? "拖 Take 到左侧集数 = episode-only 粗归集。" : "拖 Take 到左侧剧本段 = 精确人工 placement。")}</div>

      <div className="golden-ms-columns">
        <aside className="golden-ms-target-pane">
          {mode === "rough" ? (
            <>
              <header><strong>集数目标</strong><span>先大概放进去，后面看片再精确到剧本。</span></header>
              <div className="golden-ms-episode-grid">
                <button type="button" className={roughEpisodeFilter === null ? "is-active" : ""} onClick={() => setRoughEpisodeFilter(null)}>全集</button>
                {episodes.map((episode) => <button type="button" className={`${roughEpisodeFilter === episode.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`} key={episode.episode} onClick={() => setRoughEpisodeFilter(episode.episode)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => roughEpisodeDrop(event, episode.episode)}>EP{episode.episode}<small>{episode.scenes.length} 场</small></button>)}
              </div>
              <div className="golden-ms-target-note">点击集数筛选中间素材池；拖入则写入人工集级归集。AI 候选只作为筛选线索，不自动确认。</div>
            </>
          ) : (
            <>
              <header><strong>剧本目标</strong><span>当前 Take 可拖到具体对白 / 动作。</span></header>
              <div className="golden-ms-episode-strip">{episodes.map((episode) => <button type="button" className={episode.episode === selectedEpisode?.episode ? "is-active" : ""} key={episode.episode} onClick={() => setActiveEpisode(episode.episode)}>EP{episode.episode}</button>)}</div>
              <div className="golden-ms-script-scroll">
                {selectedEpisode ? <ScriptEpisodeView episode={selectedEpisode} model={model} selectedSegmentId={selectedSegmentId} draggingGroupId={draggingGroupId} placementGroupId={selectedTake?.group_id ?? null} onShowTake={showScriptTake} onDropPlacement={(groupId, block) => { setSelectedSegmentId(block.segment_id); void placeTake(groupId, block.episode > 0 ? [block.episode] : [], [block.segment_id], "drag", "golden-material-script-segment"); }} onClickPlacement={(block: ReviewScriptBlock) => { if (!selectedTake) return; setSelectedSegmentId(block.segment_id); void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "golden-material-script-segment"); }} /> : <span className="golden-ms-empty">当前没有剧本段。</span>}
              </div>
            </>
          )}
        </aside>

        <section className="golden-ms-pool-pane">
          <header><div><strong>素材池</strong><span>{filteredTakes.length} / {takes.length} Take</span></div><div className="golden-ms-filters">{STATUS_OPTIONS.map((option) => <button type="button" className={statusFilter === option.value ? "is-active" : ""} key={option.value} onClick={() => setStatusFilter(option.value)}>{option.label}<small>{option.value === "all" ? takes.length : statusCounts[option.value]}</small></button>)}</div></header>
          <div className="golden-ms-take-list">{filteredTakes.length ? <VirtualTakeList takes={filteredTakes} selectedGroupId={selectedGroupId} onSelect={selectTake} onDragBegin={setDraggingGroupId} onDragFinish={() => setDraggingGroupId(null)} /> : <div className="golden-ms-empty">当前筛选没有 Take。</div>}</div>
        </section>

        <TakeInspector connection={connection} projectId={project.project_id} take={selectedTake} selectedClipId={selectedClipId} onSelectClip={setSelectedClipId} onShowScript={() => selectedTake && showTakeInScript(selectedTake)} onClearPlacement={() => void clearPlacement()} writeSaving={writeState === "saving"} showEditorial={showEditorial} />
      </div>
    </section>
  );
}
