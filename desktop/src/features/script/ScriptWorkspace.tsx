import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type {
  ProjectSummary,
  ReviewEpisode,
  ReviewScriptBlock,
  ReviewTakeGroup,
} from "../../api/host";
import { RoughPlacementClient, type RoughPlacementPayload } from "../../api/roughPlacement";
import { ScriptEpisodeView, dragGroupId, scriptDomId } from "../material-script/ScriptEpisodeView";
import type { ScriptProjectionMode } from "../material-script/ScriptBlock";
import { mappingLabel, TakeListRow, takeDisplayLabel } from "../material-script/TakeCard";
import { TakeInspector } from "../material-script/TakeInspector";
import { DRAG_TAKE_MIME, episodeLabel } from "../material-script/VirtualTakeList";
import {
  candidateTakeIds,
  mappedTakeIds,
  preferredScriptSegmentId,
  relatedTakeIds,
  takeEpisodeIds,
} from "../material-script/model";
import {
  reviewModelErrorMessage,
  reviewWriteNeedsRefresh,
  useReviewModelSnapshot,
} from "../material-script/useReviewModelSnapshot";
import "../material-script/material-script.css";

type DrawerView = "segment" | "detail" | "batch";
type CandidateScope = "context" | "all";
type WriteState = "idle" | "saving" | "error";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
}

const ACTOR_STORAGE_KEY = "mirrororder.desktop-v2.review-actor";
const PROJECTION_OPTIONS: Array<{ value: ScriptProjectionMode; label: string }> = [
  { value: "script", label: "正文" },
  { value: "coverage", label: "覆盖" },
  { value: "issues", label: "问题" },
];

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

function firstPlaceableBlock(episode: ReviewEpisode | null): ReviewScriptBlock | null {
  if (!episode) return null;
  for (const scene of episode.scenes) {
    const block = scene.script_blocks.find((item) => item.type !== "scene_heading");
    if (block) return block;
  }
  return episode.scenes[0]?.script_blocks[0] ?? null;
}

function episodeHasSegment(episode: ReviewEpisode | null, segmentId: string | null): boolean {
  if (!episode || !segmentId) return false;
  return episode.scenes.some((scene) => scene.script_blocks.some((block) => block.segment_id === segmentId));
}

function scriptBlockSearchText(sceneHeading: string, block: ReviewScriptBlock): string {
  return [sceneHeading, block.speaker, block.type, block.text, block.raw_text, ...block.issues.map((issue) => issue.label)]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

function takeSearchText(take: ReviewTakeGroup): string {
  return [
    takeDisplayLabel(take),
    take.transcript.text,
    mappingLabel(take),
    ...take.angles.flatMap((angle) => [angle.name, angle.camera, angle.shot_type || ""]),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

export function ScriptWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
}: Props) {
  const { connection, loadState, message, model, refresh } = useReviewModelSnapshot(baseUrl, project.project_id);
  const roughPlacement = useMemo(() => new RoughPlacementClient(baseUrl), [baseUrl]);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [projectionMode, setProjectionMode] = useState<ScriptProjectionMode>("script");
  const [query, setQuery] = useState("");
  const [selectedScriptSegmentId, setSelectedScriptSegmentId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialGroupId));
  const [drawerView, setDrawerView] = useState<DrawerView>(initialGroupId ? "detail" : "segment");
  const [candidateScope, setCandidateScope] = useState<CandidateScope>("context");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [writeMessage, setWriteMessage] = useState("");
  const [roughText, setRoughText] = useState("");
  const [roughPreview, setRoughPreview] = useState<RoughPlacementPayload | null>(null);
  const appliedFocusKey = useRef("");

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;
  const selectedEpisode = model?.episodes.find((episode) => episode.episode === activeEpisode) ?? model?.episodes[0] ?? null;

  const selectedBlock = useMemo(() => {
    if (!model || !selectedScriptSegmentId) return null;
    for (const episode of model.episodes) {
      for (const scene of episode.scenes) {
        const block = scene.script_blocks.find((item) => item.segment_id === selectedScriptSegmentId);
        if (block) return block;
      }
    }
    return null;
  }, [model, selectedScriptSegmentId]);

  useEffect(() => {
    if (!model) return;
    const focusKey = `${project.project_id}:${initialGroupId ?? ""}`;
    const shouldApplyFocus = Boolean(initialGroupId) && appliedFocusKey.current !== focusKey;
    const focused = shouldApplyFocus
      ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null
      : null;

    if (focused) {
      const segmentId = preferredScriptSegmentId(focused);
      const episode = focused.effective_mapping.episode_ids[0] ?? takeEpisodeIds(focused)[0] ?? model.episodes[0]?.episode ?? null;
      setSelectedGroupId(focused.group_id);
      setSelectedClipId(focused.angles[0]?.clip_id ?? null);
      setActiveEpisode(episode);
      setSelectedScriptSegmentId(segmentId);
      setDrawerView("detail");
      setDrawerOpen(true);
      appliedFocusKey.current = focusKey;
      return;
    }

    setActiveEpisode((current) => current ?? model.episodes[0]?.episode ?? null);
    setSelectedScriptSegmentId((current) => current ?? firstPlaceableBlock(model.episodes[0] ?? null)?.segment_id ?? null);
    setSelectedGroupId((current) => current && model.take_groups.some((take) => take.group_id === current) ? current : null);
  }, [initialGroupId, model, project.project_id]);

  useEffect(() => {
    if (!selectedEpisode) return;
    if (!episodeHasSegment(selectedEpisode, selectedScriptSegmentId)) {
      setSelectedScriptSegmentId(firstPlaceableBlock(selectedEpisode)?.segment_id ?? null);
    }
  }, [selectedEpisode, selectedScriptSegmentId]);

  useEffect(() => {
    if (!selectedScriptSegmentId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(scriptDomId(selectedScriptSegmentId))?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [activeEpisode, selectedScriptSegmentId]);

  const visibleEpisode = useMemo(() => {
    if (!selectedEpisode || !model) return null;
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const scenes = selectedEpisode.scenes.flatMap((scene) => {
      const sceneMatches = Boolean(needle && scene.heading.toLocaleLowerCase("zh-CN").includes(needle));
      const scriptBlocks = scene.script_blocks.filter((block) => {
        const canPlace = block.type !== "scene_heading";
        const mapped = mappedTakeIds(model, block.segment_id);
        const issueProjection = projectionMode !== "issues" || (canPlace && (mapped.length === 0 || block.issues.length > 0));
        if (!issueProjection) return false;
        if (!needle || sceneMatches) return true;
        return scriptBlockSearchText(scene.heading, block).includes(needle);
      });
      return scriptBlocks.length ? [{ ...scene, script_blocks: scriptBlocks }] : [];
    });
    return { ...selectedEpisode, scenes };
  }, [model, projectionMode, query, selectedEpisode]);

  const episodeStats = useMemo(() => {
    const result = { blocks: 0, mapped: 0, candidate: 0, attention: 0 };
    if (!selectedEpisode || !model) return result;
    for (const scene of selectedEpisode.scenes) {
      for (const block of scene.script_blocks) {
        if (block.type === "scene_heading") continue;
        result.blocks += 1;
        const mapped = mappedTakeIds(model, block.segment_id).length;
        const candidates = candidateTakeIds(model, block.segment_id).length;
        if (mapped) result.mapped += 1;
        if (candidates) result.candidate += 1;
        if (!mapped || block.issues.length) result.attention += 1;
      }
    }
    return result;
  }, [model, selectedEpisode]);

  useEffect(() => {
    if (!visibleEpisode || !selectedScriptSegmentId) return;
    const visible = episodeHasSegment(visibleEpisode, selectedScriptSegmentId);
    if (!visible && visibleEpisode.scenes.length) {
      setSelectedScriptSegmentId(firstPlaceableBlock(visibleEpisode)?.segment_id ?? null);
    }
  }, [selectedScriptSegmentId, visibleEpisode]);

  const contextualTakes = useMemo(() => {
    if (!model || !selectedScriptSegmentId) return [];
    const byId = new Map(model.take_groups.map((take) => [take.group_id, take]));
    return relatedTakeIds(model, selectedScriptSegmentId)
      .map((groupId) => byId.get(groupId) ?? null)
      .filter((take): take is ReviewTakeGroup => Boolean(take));
  }, [model, selectedScriptSegmentId]);

  const candidateTakes = useMemo(() => {
    if (!model) return [];
    if (candidateScope === "context") return contextualTakes;
    const needle = candidateQuery.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return model.take_groups;
    return model.take_groups.filter((take) => takeSearchText(take).includes(needle));
  }, [candidateQuery, candidateScope, contextualTakes, model]);

  const selectedMappedTakeIds = selectedScriptSegmentId && model ? mappedTakeIds(model, selectedScriptSegmentId) : [];
  const selectedCandidateTakeIds = selectedScriptSegmentId && model ? candidateTakeIds(model, selectedScriptSegmentId) : [];
  const selectedTakeMappedHere = Boolean(selectedTake && selectedScriptSegmentId && selectedTake.effective_mapping.script_segment_ids.includes(selectedScriptSegmentId));

  function selectTake(take: ReviewTakeGroup, openDetail = false): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    if (openDetail) {
      setDrawerView("detail");
      setDrawerOpen(true);
    }
  }

  function selectBlock(block: ReviewScriptBlock): void {
    setSelectedScriptSegmentId(block.segment_id);
  }

  function openBlockContext(block: ReviewScriptBlock): void {
    setSelectedScriptSegmentId(block.segment_id);
    setCandidateScope("context");
    setCandidateQuery("");
    setDrawerView("segment");
    setDrawerOpen(true);
  }

  function beginDrag(event: DragEvent<HTMLElement>, groupId: string): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TAKE_MIME, groupId);
    event.dataTransfer.setData("text/plain", groupId);
    setDraggingGroupId(groupId);
  }

  async function refreshAfterWrite(groupId: string, summary: string): Promise<void> {
    const next = await refresh();
    const refreshed = next.take_groups.find((take) => take.group_id === groupId) ?? null;
    setSelectedGroupId(refreshed?.group_id ?? null);
    setSelectedClipId((current) => refreshed?.angles.some((angle) => angle.clip_id === current) ? current : refreshed?.angles[0]?.clip_id ?? null);
    setWriteState("idle");
    setWriteMessage(summary);
  }

  async function placeTake(
    groupId: string,
    episodeIds: number[],
    segmentIds: string[],
    interaction: "drag" | "click",
    sourceSurface: string,
  ): Promise<void> {
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
      const take = model.take_groups.find((item) => item.group_id === groupId) ?? null;
      const label = take ? takeDisplayLabel(take) : "Take";
      const summary = segmentIds.length
        ? `已人工归集 ${label} → 当前剧本段`
        : `已人工粗归集 ${label} → ${episodeIds.map(episodeLabel).join(" / ")}`;
      await refreshAfterWrite(groupId, summary);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          await refresh();
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(reviewModelErrorMessage(error));
        }
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
      }
    } finally {
      setDraggingGroupId(null);
    }
  }

  async function placeTakeOnSelectedBlock(take: ReviewTakeGroup): Promise<void> {
    if (!selectedBlock) return;
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    await placeTake(
      take.group_id,
      selectedBlock.episode > 0 ? [selectedBlock.episode] : [],
      [selectedBlock.segment_id],
      "click",
      "desktop-script-segment-context",
    );
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
        sourceSurface: "desktop-script",
      });
      await refreshAfterWrite(selectedTake.group_id, `已清除 ${takeDisplayLabel(selectedTake)} 的人工归集；自动状态未改动。`);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          await refresh();
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(reviewModelErrorMessage(error));
        }
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
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
      setWriteMessage(reviewModelErrorMessage(error));
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
      await refresh();
      setRoughPreview(null);
      setWriteState("idle");
      setWriteMessage(`已批量归集 ${result.resolved_groups} 个 Take`);
      setDrawerOpen(false);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        await refresh().catch(() => null);
        setRoughPreview(null);
        setWriteMessage("制作状态已变化，预览已作废；请重新预览后确认。");
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
      }
    }
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="script-workspace">
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>
      </section>
    );
  }

  return (
    <section className="script-workspace">
      <header className="script-command-bar">
        <div className="script-projection-switch" aria-label="剧本显示模式">
          {PROJECTION_OPTIONS.map((option) => (
            <button type="button" className={projectionMode === option.value ? "is-active" : ""} aria-pressed={projectionMode === option.value} key={option.value} onClick={() => setProjectionMode(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <input
          className="script-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索剧本、角色或场景"
          aria-label="搜索剧本"
        />
        <div className="workspace-toolbar-actions">
          <button type="button" className="secondary" disabled={!selectedBlock} onClick={() => selectedBlock && openBlockContext(selectedBlock)}>匹配素材</button>
          <button type="button" className="secondary" onClick={() => { setDrawerView("batch"); setRoughPreview(null); setDrawerOpen(true); }}>批量归集</button>
          <label className="review-actor-field compact-actor">
            <span>审核昵称</span>
            <input value={actor} placeholder="写入时必填" onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} />
          </label>
        </div>
      </header>

      <div className="script-episode-bar">
        <div className="episode-strip" aria-label="剧本集数">
          {model.episodes.map((episode) => (
            <button
              type="button"
              className={`${episode.episode === selectedEpisode?.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
              key={episode.episode}
              onClick={() => {
                setActiveEpisode(episode.episode);
                setSelectedScriptSegmentId(firstPlaceableBlock(episode)?.segment_id ?? null);
              }}
              onDragOver={(event) => {
                if (!draggingGroupId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const groupId = dragGroupId(event);
                if (groupId) void placeTake(groupId, [episode.episode], [], "drag", "desktop-script-episode");
              }}
            >
              {episodeLabel(episode.episode)}
            </button>
          ))}
        </div>
        {selectedTake ? (
          <div
            className="script-current-take"
            draggable
            onDragStart={(event) => beginDrag(event, selectedTake.group_id)}
            onDragEnd={() => setDraggingGroupId(null)}
            title="当前从其它工作区带入的 Take；可拖到集数或剧本段"
          >
            <span>当前 Take</span><strong>{takeDisplayLabel(selectedTake)}</strong>
          </div>
        ) : null}
      </div>

      <div className="script-coverage-summary" aria-label="当前集剧本归集摘要">
        <span><strong>{episodeStats.blocks}</strong>剧本段</span>
        <span><strong>{episodeStats.mapped}</strong>已归集</span>
        <span><strong>{episodeStats.candidate}</strong>有候选</span>
        <span className={episodeStats.attention ? "needs-attention" : ""}><strong>{episodeStats.attention}</strong>需处理</span>
        <small>“覆盖”只显示已观察 placement / candidate 状态，不把无证据解释为缺镜头。</small>
      </div>

      {writeMessage ? <div className={`write-status write-${writeState}`}>{writeMessage}</div> : null}

      <main className="script-primary-canvas">
        {visibleEpisode && visibleEpisode.scenes.length ? (
          <ScriptEpisodeView
            episode={visibleEpisode}
            model={model}
            selectedSegmentId={selectedScriptSegmentId}
            projectionMode={projectionMode}
            draggingGroupId={draggingGroupId}
            placementGroupId={selectedTake?.group_id ?? null}
            onSelectBlock={selectBlock}
            onOpenContext={openBlockContext}
            onShowTake={(groupId) => {
              const take = model.take_groups.find((item) => item.group_id === groupId);
              if (take) selectTake(take, true);
            }}
            onDropPlacement={(groupId, block) => {
              setSelectedScriptSegmentId(block.segment_id);
              void placeTake(groupId, block.episode > 0 ? [block.episode] : [], [block.segment_id], "drag", "desktop-script-segment");
            }}
            onClickPlacement={(block: ReviewScriptBlock) => {
              setSelectedScriptSegmentId(block.segment_id);
              if (!selectedTake) {
                openBlockContext(block);
                return;
              }
              void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "desktop-script-segment");
            }}
          />
        ) : <p className="empty-copy">当前搜索 / 显示模式下没有剧本段。</p>}
      </main>

      {drawerOpen ? (
        <div className="workspace-context-layer">
          <button type="button" className="workspace-context-backdrop" aria-label="关闭剧本上下文" onClick={() => setDrawerOpen(false)} />
          <aside className="workspace-context-drawer" aria-label="剧本上下文">
            <header className="workspace-context-heading">
              <div>
                <span>{drawerView === "batch" ? "批量归集" : drawerView === "detail" ? "Take 详情" : "当前剧本段"}</span>
                <strong>{drawerView === "batch" ? "Take 范围 → 集数" : drawerView === "detail" && selectedTake ? takeDisplayLabel(selectedTake) : selectedBlock ? (selectedBlock.speaker || selectedBlock.type || "剧本段") : "选择剧本段"}</strong>
              </div>
              <button type="button" className="secondary" onClick={() => setDrawerOpen(false)}>关闭</button>
            </header>

            {drawerView === "batch" ? (
              <section className="rough-placement-tool">
                <div className="rough-placement-copy">
                  <strong>按 Take 范围粗归集到集数</strong>
                  <p>例如：1-10 第1集；11-20 第2集。这里只写 episode-only placement；精确剧本段继续在正文里确认。</p>
                </div>
                <textarea
                  value={roughText}
                  onChange={(event) => {
                    setRoughText(event.target.value);
                    setRoughPreview(null);
                  }}
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
              </section>
            ) : drawerView === "segment" ? (
              <section className="script-segment-context">
                {selectedBlock ? (
                  <>
                    <div className="script-segment-summary">
                      <p>{selectedBlock.raw_text || selectedBlock.text || "—"}</p>
                      <div>
                        <span><strong>{selectedMappedTakeIds.length}</strong>已归集</span>
                        <span><strong>{selectedCandidateTakeIds.length}</strong>候选</span>
                        <span className={selectedBlock.issues.length ? "needs-attention" : ""}><strong>{selectedBlock.issues.length}</strong>问题</span>
                      </div>
                    </div>
                    <div className="workspace-context-tabs">
                      <button type="button" className={candidateScope === "context" ? "is-active" : ""} onClick={() => setCandidateScope("context")}>相关素材</button>
                      <button type="button" className={candidateScope === "all" ? "is-active" : ""} onClick={() => setCandidateScope("all")}>全部 Take</button>
                      {selectedTake ? <button type="button" onClick={() => setDrawerView("detail")}>当前 Take</button> : null}
                    </div>
                    {candidateScope === "all" ? (
                      <input className="script-candidate-search" type="search" value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="搜索 Take、对白或机位" aria-label="搜索全部 Take" />
                    ) : null}
                    <div className="script-context-take-list">
                      {candidateTakes.length ? candidateTakes.map((take) => {
                        const mappedHere = take.effective_mapping.script_segment_ids.includes(selectedBlock.segment_id);
                        const candidateHere = selectedCandidateTakeIds.includes(take.group_id);
                        return (
                          <TakeListRow
                            take={take}
                            detail={mappedHere ? `已归集此段 · ${mappingLabel(take)}` : candidateHere ? `候选 · ${mappingLabel(take)}` : mappingLabel(take)}
                            action={() => mappedHere ? selectTake(take, true) : void placeTakeOnSelectedBlock(take)}
                            actionLabel={mappedHere ? "查看" : "归集到此段"}
                            onSelect={() => selectTake(take, true)}
                            onDragStart={(event, rowTake) => beginDrag(event, rowTake.group_id)}
                            key={take.group_id}
                          />
                        );
                      }) : <div className="workspace-context-empty">当前剧本段没有已归集或候选 Take。可切到“全部 Take”搜索并人工归集。</div>}
                    </div>
                  </>
                ) : <div className="workspace-context-empty">先在剧本正文选择一个剧本段。</div>}
              </section>
            ) : selectedTake ? (
              <>
                <div className="workspace-context-tabs">
                  <button type="button" onClick={() => { setDrawerView("segment"); setCandidateScope("context"); }}>返回当前剧本段</button>
                  <button type="button" className="is-active">Take 详情</button>
                </div>
                {selectedBlock && !selectedTakeMappedHere ? (
                  <div className="script-detail-placement-action">
                    <span>当前 Take 尚未归集到所选剧本段。</span>
                    <button type="button" disabled={writeState === "saving"} onClick={() => void placeTakeOnSelectedBlock(selectedTake)}>归集到当前剧本段</button>
                  </div>
                ) : null}
                <TakeInspector
                  connection={connection}
                  projectId={project.project_id}
                  take={selectedTake}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  onClearPlacement={() => void clearPlacement()}
                  writeSaving={writeState === "saving"}
                />
              </>
            ) : <div className="workspace-context-empty">当前没有可查看的 Take。</div>}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
