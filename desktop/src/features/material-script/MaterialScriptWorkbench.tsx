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
import { reviewTakeAttention } from "../review/reviewAttention";
import { ScriptEpisodeView, dragGroupId, scriptDomId } from "./ScriptEpisodeView";
import { mappingLabel, TakeListRow, takeDisplayLabel } from "./TakeCard";
import { TakeInspector } from "./TakeInspector";
import { DRAG_TAKE_MIME, VirtualTakeList, episodeLabel } from "./VirtualTakeList";
import {
  preferredScriptSegmentId,
  relatedTakeIds,
  takeEpisodeIds,
  takeMatchesFilters,
  takeStatus,
  type TakeStatusFilter,
} from "./model";

export type MaterialScriptSurface = "takes" | "script" | "review";

type ScriptDrawerView = "list" | "detail";
type ScriptCandidateScope = "context" | "all";
type TakesDrawerView = "detail" | "batch";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  surface: MaterialScriptSurface;
  showEditorial?: boolean;
  onOpenScript?: (groupId: string) => void;
  onOpenCoverage?: () => void;
}

type LoadState = "loading" | "ready" | "error";
type WriteState = "idle" | "saving" | "error";

const ACTOR_STORAGE_KEY = "mirrororder.desktop-v2.review-actor";
const STATUS_OPTIONS: Array<{ value: TakeStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需关注" },
  { value: "candidate", label: "AI候选" },
  { value: "pending", label: "待归集" },
  { value: "placed", label: "已归集" },
  { value: "rejected", label: "已排除" },
];

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function reviewWriteNeedsRefresh(error: unknown): boolean {
  return error instanceof HostConnectionError && (error.status === 409 || error.message.includes("请刷新"));
}

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem(ACTOR_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveActor(actor: string): void {
  try {
    globalThis.localStorage?.setItem(ACTOR_STORAGE_KEY, actor.trim());
  } catch {
    // Device-local convenience only.
  }
}

function roughPreviewLabel(plan: RoughPlacementPayload["plans"][number]): string {
  const range = plan.take_start === plan.take_end ? `T${plan.take_start}` : `T${plan.take_start}–T${plan.take_end}`;
  return `${range} → EP${plan.episode}`;
}

export function MaterialScriptWorkbench({
  baseUrl,
  project,
  initialGroupId = null,
  surface,
  showEditorial = false,
  onOpenScript,
  onOpenCoverage,
}: Props) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const roughPlacement = useMemo(() => new RoughPlacementClient(baseUrl), [baseUrl]);
  const editorial = showEditorial || surface === "review";
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [message, setMessage] = useState("");
  const [writeMessage, setWriteMessage] = useState("");
  const [model, setModel] = useState<ReviewModelPayload | null>(null);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [materialEpisode, setMaterialEpisode] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<TakeStatusFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedScriptSegmentId, setSelectedScriptSegmentId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialGroupId));
  const [scriptDrawerView, setScriptDrawerView] = useState<ScriptDrawerView>("list");
  const [scriptCandidateScope, setScriptCandidateScope] = useState<ScriptCandidateScope>("context");
  const [takesDrawerView, setTakesDrawerView] = useState<TakesDrawerView>("detail");
  const [roughText, setRoughText] = useState("");
  const [roughPreview, setRoughPreview] = useState<RoughPlacementPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setMessage("正在读取制作状态…");
    setWriteMessage("");
    setDrawerOpen(Boolean(initialGroupId));
    setScriptDrawerView("list");
    setScriptCandidateScope("context");
    setTakesDrawerView("detail");
    setRoughPreview(null);
    void connection.reviewModel(project.project_id).then((next) => {
      if (cancelled) return;
      const focused = initialGroupId ? next.take_groups.find((item) => item.group_id === initialGroupId) ?? null : null;
      const first = focused ?? next.take_groups[0] ?? null;
      setModel(next);
      setSelectedGroupId(first?.group_id ?? null);
      setSelectedClipId(first?.angles[0]?.clip_id ?? null);
      setActiveEpisode(next.episodes[0]?.episode ?? null);
      setMaterialEpisode(null);
      setStatusFilter("all");
      setLoadState("ready");
      setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadState("error");
      setMessage(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [connection, initialGroupId, project.project_id, surface]);

  useEffect(() => {
    if (surface !== "script" || !selectedScriptSegmentId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(scriptDomId(selectedScriptSegmentId))?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [activeEpisode, selectedScriptSegmentId, surface]);

  const episodeButtons = model?.episodes ?? [];
  const selectedEpisode = model?.episodes.find((item) => item.episode === activeEpisode) ?? model?.episodes[0] ?? null;
  const statusOptions = editorial ? STATUS_OPTIONS : STATUS_OPTIONS.filter((option) => option.value !== "attention");
  const filteredTakes = useMemo(
    () => model?.take_groups.filter((take) => takeMatchesFilters(take, statusFilter, materialEpisode)) ?? [],
    [materialEpisode, model, statusFilter],
  );
  const selectedTake = selectedGroupId
    ? model?.take_groups.find((item) => item.group_id === selectedGroupId) ?? null
    : null;
  const statusCounts = useMemo(() => {
    const counts = { attention: 0, candidate: 0, pending: 0, placed: 0, rejected: 0 };
    for (const take of model?.take_groups ?? []) {
      counts[takeStatus(take)] += 1;
      if (reviewTakeAttention(take).hasAttention) counts.attention += 1;
    }
    return counts;
  }, [model]);

  const contextualScriptTakes = useMemo(() => {
    if (!model) return [];
    if (selectedScriptSegmentId) {
      const byId = new Map(model.take_groups.map((take) => [take.group_id, take]));
      return relatedTakeIds(model, selectedScriptSegmentId)
        .map((groupId) => byId.get(groupId) ?? null)
        .filter((take): take is ReviewTakeGroup => Boolean(take));
    }
    if (activeEpisode !== null) {
      return model.take_groups.filter((take) => takeEpisodeIds(take).includes(activeEpisode));
    }
    return [];
  }, [activeEpisode, model, selectedScriptSegmentId]);

  const scriptDrawerTakes = scriptCandidateScope === "context"
    ? contextualScriptTakes
    : model?.take_groups ?? [];

  useEffect(() => {
    if (!model || surface === "script") return;
    if (filteredTakes.length === 0) {
      setSelectedGroupId(null);
      setSelectedClipId(null);
      setDrawerOpen(false);
      return;
    }
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      setSelectedGroupId(filteredTakes[0].group_id);
      setSelectedClipId(filteredTakes[0].angles[0]?.clip_id ?? null);
      setDrawerOpen(false);
    }
  }, [filteredTakes, model, selectedGroupId, surface]);

  function selectTake(take: ReviewTakeGroup, openDetail = true): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    if (openDetail) {
      setScriptDrawerView("detail");
      setTakesDrawerView("detail");
      setDrawerOpen(true);
    }
  }

  function showTakeInScript(take: ReviewTakeGroup): void {
    if (surface !== "script") {
      onOpenScript?.(take.group_id);
      return;
    }
    const episode = take.effective_mapping.episode_ids[0] ?? takeEpisodeIds(take)[0] ?? null;
    if (episode !== null) setActiveEpisode(episode);
    setSelectedScriptSegmentId(preferredScriptSegmentId(take));
    setDrawerOpen(false);
  }

  function showScriptTake(groupId: string): void {
    const take = model?.take_groups.find((item) => item.group_id === groupId);
    if (!take) return;
    selectTake(take, true);
  }

  function displayGroup(groupId: string): string {
    const take = model?.take_groups.find((item) => item.group_id === groupId) ?? null;
    return take ? takeDisplayLabel(take) : "Take";
  }

  function beginDrag(event: DragEvent<HTMLElement>, groupId: string): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TAKE_MIME, groupId);
    event.dataTransfer.setData("text/plain", groupId);
    setDraggingGroupId(groupId);
  }

  async function refreshAfterWrite(groupId: string, summary: string): Promise<void> {
    const next = await connection.reviewModel(project.project_id);
    setModel(next);
    const refreshed = next.take_groups.find((item) => item.group_id === groupId) ?? null;
    setSelectedGroupId(refreshed?.group_id ?? null);
    setSelectedClipId((current) => refreshed?.angles.some((item) => item.clip_id === current) ? current : refreshed?.angles[0]?.clip_id ?? null);
    setMessage(`${next.take_groups.length} Take · ${next.episodes.length} 集`);
    setWriteState("idle");
    setWriteMessage(summary);
  }

  async function placeTake(groupId: string, episodeIds: number[], segmentIds: string[], interaction: "drag" | "click", sourceSurface: string): Promise<void> {
    if (!model) return;
    if (!actor.trim()) {
      setWriteState("error");
      setWriteMessage("先填写审核昵称，再写入人工归集。");
      return;
    }
    setWriteState("saving");
    setWriteMessage("正在写入人工归集…");
    saveActor(actor);
    try {
      await connection.setGroupPlacement(project.project_id, {
        groupId,
        actor,
        expectedRevision: model.revisions.review,
        episodeIds,
        scriptSegmentIds: segmentIds,
        interaction,
        sourceSurface,
        sourceClipId: groupId === selectedGroupId ? selectedClipId ?? undefined : undefined,
      });
      const label = displayGroup(groupId);
      const summary = segmentIds.length
        ? `已人工归集 ${label} → ${segmentIds.length} 个剧本段`
        : `已人工粗归集 ${label} → ${episodeIds.map(episodeLabel).join(" / ")}`;
      await refreshAfterWrite(groupId, summary);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          const latest = await connection.reviewModel(project.project_id);
          setModel(latest);
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(errorMessage(error));
        }
      } else {
        setWriteMessage(errorMessage(error));
      }
    } finally {
      setDraggingGroupId(null);
    }
  }

  async function clearPlacement(): Promise<void> {
    if (!selectedTake || !model) return;
    if (!actor.trim()) {
      setWriteState("error");
      setWriteMessage("先填写审核昵称，再清除人工归集。");
      return;
    }
    setWriteState("saving");
    saveActor(actor);
    try {
      await connection.clearGroupPlacement(project.project_id, {
        groupId: selectedTake.group_id,
        actor,
        expectedRevision: model.revisions.review,
        sourceSurface: `desktop-${surface}`,
      });
      await refreshAfterWrite(selectedTake.group_id, `已清除 ${takeDisplayLabel(selectedTake)} 的人工归集；自动状态未改动。`);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          const latest = await connection.reviewModel(project.project_id);
          setModel(latest);
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(errorMessage(error));
        }
      } else {
        setWriteMessage(errorMessage(error));
      }
    }
  }

  async function previewRoughPlacement(): Promise<void> {
    if (!roughText.trim()) return;
    setWriteState("saving");
    setWriteMessage("正在解析批量归集范围…");
    try {
      const preview = await roughPlacement.preview(project.project_id, roughText);
      setRoughPreview(preview);
      setWriteState("idle");
      setWriteMessage(`已识别 ${preview.plans.length} 段范围；确认前不会写入。`);
    } catch (error) {
      setWriteState("error");
      setWriteMessage(errorMessage(error));
    }
  }

  async function applyRoughPlacement(): Promise<void> {
    if (!model || !roughPreview || !actor.trim()) {
      setWriteState("error");
      setWriteMessage("先预览批量归集并填写审核昵称。");
      return;
    }
    setWriteState("saving");
    setWriteMessage("正在确认批量归集…");
    saveActor(actor);
    try {
      const result = await roughPlacement.apply(project.project_id, roughText, actor, model.revisions.review);
      const next = await connection.reviewModel(project.project_id);
      setModel(next);
      const refreshed = selectedGroupId ? next.take_groups.find((item) => item.group_id === selectedGroupId) ?? null : next.take_groups[0] ?? null;
      setSelectedGroupId(refreshed?.group_id ?? null);
      setSelectedClipId(refreshed?.angles[0]?.clip_id ?? null);
      setRoughPreview(null);
      setWriteState("idle");
      setWriteMessage(`已批量归集 ${result.resolved_groups} 个 Take`);
      setDrawerOpen(false);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        const latest = await connection.reviewModel(project.project_id).catch(() => null);
        if (latest) setModel(latest);
        setRoughPreview(null);
        setWriteMessage("制作状态已变化，预览已作废；请重新预览后确认。");
      } else {
        setWriteMessage(errorMessage(error));
      }
    }
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className={`material-script-workbench surface-${surface}`}>
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>
      </section>
    );
  }

  const drawerTitle = surface === "script" ? "匹配素材" : surface === "review" ? "看片详情" : takesDrawerView === "batch" ? "批量归集" : "Take 详情";

  return (
    <section className={`material-script-workbench surface-${surface}`}>
      {surface === "script" ? (
        <>
          <header className="material-script-surface-toolbar script-surface-toolbar">
            <div className="episode-strip" aria-label="剧本集数">
              {episodeButtons.map((episode) => (
                <button
                  type="button"
                  className={`${episode.episode === selectedEpisode?.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
                  key={episode.episode}
                  onClick={() => { setActiveEpisode(episode.episode); setSelectedScriptSegmentId(null); }}
                  onDragOver={(event) => { if (draggingGroupId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(event) => { event.preventDefault(); const groupId = dragGroupId(event); if (groupId) void placeTake(groupId, [episode.episode], [], "drag", "desktop-script-episode"); }}
                >{episodeLabel(episode.episode)}</button>
              ))}
            </div>
            <div className="surface-toolbar-actions">
              {selectedTake ? (
                <div
                  className="script-current-take"
                  draggable
                  onDragStart={(event) => beginDrag(event, selectedTake.group_id)}
                  onDragEnd={() => setDraggingGroupId(null)}
                  title="拖到集数或剧本段进行人工归集"
                >
                  <span>当前素材</span><strong>{takeDisplayLabel(selectedTake)}</strong>
                </div>
              ) : null}
              {onOpenCoverage ? <button type="button" className="secondary" onClick={onOpenCoverage}>覆盖</button> : null}
              <button type="button" className="secondary" onClick={() => { setScriptDrawerView("list"); setDrawerOpen(true); }}>选择素材</button>
              <label className="review-actor-field compact-actor"><span>审核昵称</span><input value={actor} placeholder="写入时必填" onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} /></label>
            </div>
          </header>
          {writeMessage ? <div className={`write-status write-${writeState}`}>{writeMessage}</div> : null}
          <main className="script-primary-canvas">
            {selectedEpisode ? (
              <ScriptEpisodeView
                episode={selectedEpisode}
                model={model}
                selectedSegmentId={selectedScriptSegmentId}
                draggingGroupId={draggingGroupId}
                placementGroupId={selectedTake?.group_id ?? null}
                onShowTake={showScriptTake}
                onDropPlacement={(groupId, block) => {
                  setSelectedScriptSegmentId(block.segment_id);
                  void placeTake(groupId, block.episode > 0 ? [block.episode] : [], [block.segment_id], "drag", "desktop-script-segment");
                }}
                onClickPlacement={(block: ReviewScriptBlock) => {
                  if (!selectedTake) {
                    setSelectedScriptSegmentId(block.segment_id);
                    setScriptDrawerView("list");
                    setDrawerOpen(true);
                    return;
                  }
                  setSelectedScriptSegmentId(block.segment_id);
                  void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "desktop-script-segment");
                }}
              />
            ) : <p className="empty-copy">当前项目没有剧本段。</p>}
          </main>
        </>
      ) : (
        <>
          <header className="material-script-surface-toolbar take-surface-toolbar">
            <div className="status-filter" aria-label={surface === "review" ? "看片筛选" : "镜次筛选"}>
              {statusOptions.map((option) => (
                <button
                  type="button"
                  className={statusFilter === option.value ? "is-active" : ""}
                  key={option.value}
                  onClick={() => setStatusFilter(option.value)}
                  title={option.value === "attention" ? "汇总问题、过期证据、未归集与待裁决团队意见；不会修改人工决定" : undefined}
                >
                  {option.label} <span>{option.value === "all" ? model.take_groups.length : statusCounts[option.value]}</span>
                </button>
              ))}
            </div>
            <div className="surface-toolbar-actions">
              <span className="surface-count">{filteredTakes.length} / {model.take_groups.length} Take</span>
              {surface === "takes" ? <button type="button" className="secondary" onClick={() => { setTakesDrawerView("batch"); setRoughPreview(null); setDrawerOpen(true); }}>批量归集</button> : null}
              <label className="review-actor-field"><span>审核昵称</span><input value={actor} placeholder="写入时必填" onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} /></label>
            </div>
          </header>
          <div className="episode-filter" aria-label="集数筛选与粗归集目标">
            <button type="button" className={materialEpisode === null ? "is-active" : ""} onClick={() => setMaterialEpisode(null)}>全部集</button>
            {episodeButtons.map((episode) => (
              <button
                type="button"
                className={`${materialEpisode === episode.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
                key={episode.episode}
                onClick={() => setMaterialEpisode(episode.episode)}
                onDragOver={(event) => { if (draggingGroupId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={(event) => { event.preventDefault(); const groupId = dragGroupId(event); if (groupId) void placeTake(groupId, [episode.episode], [], "drag", `desktop-${surface}-episode`); }}
                title="拖入 Take：只归集到该集"
              >{episodeLabel(episode.episode)}</button>
            ))}
          </div>
          {writeMessage ? <div className={`write-status write-${writeState}`}>{writeMessage}</div> : null}
          <main className="take-primary-canvas">
            {filteredTakes.length ? (
              <VirtualTakeList
                variant="compact"
                takes={filteredTakes}
                selectedGroupId={selectedGroupId}
                onSelect={(take) => selectTake(take, true)}
                onDragBegin={setDraggingGroupId}
                onDragFinish={() => setDraggingGroupId(null)}
              />
            ) : <div className="phase-placeholder compact-placeholder">当前筛选没有 Take。</div>}
          </main>
        </>
      )}

      {drawerOpen ? (
        <div className="material-script-context-layer">
          <button type="button" className="material-script-context-backdrop" aria-label="关闭上下文面板" onClick={() => setDrawerOpen(false)} />
          <aside className="material-script-context-drawer" aria-label={drawerTitle}>
            <header className="context-drawer-heading">
              <div>
                <span>{drawerTitle}</span>
                <strong>{surface === "takes" && takesDrawerView === "batch" ? "Take 范围 → 集数" : selectedTake ? takeDisplayLabel(selectedTake) : "选择 Take"}</strong>
              </div>
              <button type="button" className="secondary" onClick={() => setDrawerOpen(false)}>关闭</button>
            </header>

            {surface === "takes" && takesDrawerView === "batch" ? (
              <section className="rough-placement-tool">
                <div className="rough-placement-copy">
                  <strong>按 Take 范围归集到集数</strong>
                  <p>例如：1-10 第1集；11-20 第2集。先预览，再确认写入。</p>
                </div>
                <textarea
                  value={roughText}
                  onChange={(event) => { setRoughText(event.target.value); setRoughPreview(null); }}
                  placeholder="1-10 第1集；11-20 第2集"
                  rows={5}
                />
                <div className="rough-placement-actions">
                  <button type="button" className="secondary" disabled={writeState === "saving" || !roughText.trim()} onClick={() => void previewRoughPlacement()}>预览</button>
                  <button type="button" disabled={writeState === "saving" || !roughPreview || !actor.trim()} onClick={() => void applyRoughPlacement()}>确认归集</button>
                </div>
                {roughPreview ? (
                  <div className="rough-placement-preview">
                    {roughPreview.plans.map((plan, index) => <span key={`${plan.take_start}-${plan.take_end}-${index}`}>{roughPreviewLabel(plan)}</span>)}
                  </div>
                ) : null}
                {writeMessage ? <div className={`write-status write-${writeState}`}>{writeMessage}</div> : null}
              </section>
            ) : surface === "script" && scriptDrawerView === "list" ? (
              <div className="script-candidate-browser">
                <div className="context-drawer-tabs">
                  <button type="button" className={scriptCandidateScope === "context" ? "is-active" : ""} onClick={() => setScriptCandidateScope("context")}>当前上下文</button>
                  <button type="button" className={scriptCandidateScope === "all" ? "is-active" : ""} onClick={() => setScriptCandidateScope("all")}>全部素材</button>
                  {selectedTake ? <button type="button" onClick={() => setScriptDrawerView("detail")}>当前详情</button> : null}
                </div>
                <div className="script-context-take-list">
                  {scriptDrawerTakes.length ? scriptDrawerTakes.map((take) => (
                    <TakeListRow
                      take={take}
                      detail={take.group_id === selectedGroupId ? `当前选择 · ${mappingLabel(take)}` : mappingLabel(take)}
                      action={() => { selectTake(take, false); setDrawerOpen(false); }}
                      actionLabel={take.group_id === selectedGroupId ? "已选" : "使用"}
                      onSelect={() => { selectTake(take, false); setScriptDrawerView("detail"); }}
                      onDragStart={(event, rowTake) => beginDrag(event, rowTake.group_id)}
                      key={take.group_id}
                    />
                  )) : <div className="context-drawer-empty">当前上下文没有候选 Take；切到“全部素材”可手动选择。</div>}
                </div>
              </div>
            ) : selectedTake ? (
              <>
                {surface === "script" ? (
                  <div className="context-drawer-tabs">
                    <button type="button" onClick={() => setScriptDrawerView("list")}>素材列表</button>
                    <button type="button" className="is-active">当前详情</button>
                  </div>
                ) : null}
                <TakeInspector
                  connection={connection}
                  projectId={project.project_id}
                  take={selectedTake}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  onShowScript={() => showTakeInScript(selectedTake)}
                  onClearPlacement={() => void clearPlacement()}
                  writeSaving={writeState === "saving"}
                  showEditorial={editorial}
                />
              </>
            ) : <div className="context-drawer-empty">当前没有可查看的 Take。</div>}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
