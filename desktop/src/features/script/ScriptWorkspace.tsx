import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type {
  ProjectSummary,
  ReviewScriptBlock,
  ReviewTakeGroup,
} from "../../api/host";
import { RoughPlacementClient, type RoughPlacementPayload } from "../../api/roughPlacement";
import { ScriptEpisodeView, dragGroupId, scriptDomId } from "../material-script/ScriptEpisodeView";
import { mappingLabel, TakeListRow, takeDisplayLabel } from "../material-script/TakeCard";
import { TakeInspector } from "../material-script/TakeInspector";
import { DRAG_TAKE_MIME, episodeLabel } from "../material-script/VirtualTakeList";
import {
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

type DrawerView = "candidates" | "detail" | "batch";
type CandidateScope = "context" | "all";
type WriteState = "idle" | "saving" | "error";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  onOpenCoverage?: () => void;
}

const ACTOR_STORAGE_KEY = "mirrororder.desktop-v2.review-actor";

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

export function ScriptWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  onOpenCoverage,
}: Props) {
  const { connection, loadState, message, model, refresh } = useReviewModelSnapshot(baseUrl, project.project_id);
  const roughPlacement = useMemo(() => new RoughPlacementClient(baseUrl), [baseUrl]);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [selectedScriptSegmentId, setSelectedScriptSegmentId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialGroupId));
  const [drawerView, setDrawerView] = useState<DrawerView>(initialGroupId ? "detail" : "candidates");
  const [candidateScope, setCandidateScope] = useState<CandidateScope>("context");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [writeMessage, setWriteMessage] = useState("");
  const [roughText, setRoughText] = useState("");
  const [roughPreview, setRoughPreview] = useState<RoughPlacementPayload | null>(null);
  const appliedFocusKey = useRef("");

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;
  const selectedEpisode = model?.episodes.find((episode) => episode.episode === activeEpisode) ?? model?.episodes[0] ?? null;

  useEffect(() => {
    if (!model) return;
    const focusKey = `${project.project_id}:${initialGroupId ?? ""}`;
    const shouldApplyFocus = Boolean(initialGroupId) && appliedFocusKey.current !== focusKey;
    const focused = shouldApplyFocus
      ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null
      : null;
    const current = selectedGroupId ? model.take_groups.find((take) => take.group_id === selectedGroupId) ?? null : null;
    const next = focused ?? current ?? model.take_groups[0] ?? null;

    setSelectedGroupId(next?.group_id ?? null);
    setSelectedClipId((clipId) => next?.angles.some((angle) => angle.clip_id === clipId) ? clipId : next?.angles[0]?.clip_id ?? null);

    if (activeEpisode === null) {
      const episode = focused?.effective_mapping.episode_ids[0] ?? (focused ? takeEpisodeIds(focused)[0] : null) ?? model.episodes[0]?.episode ?? null;
      setActiveEpisode(episode);
    }
    if (focused) {
      appliedFocusKey.current = focusKey;
      setSelectedScriptSegmentId(preferredScriptSegmentId(focused));
      setDrawerView("detail");
      setDrawerOpen(true);
    }
  }, [activeEpisode, initialGroupId, model, project.project_id, selectedGroupId]);

  useEffect(() => {
    if (!selectedScriptSegmentId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(scriptDomId(selectedScriptSegmentId))?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [activeEpisode, selectedScriptSegmentId]);

  const contextualTakes = useMemo(() => {
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

  const candidateTakes = candidateScope === "context" ? contextualTakes : model?.take_groups ?? [];

  function selectTake(take: ReviewTakeGroup, openDetail = false): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    if (openDetail) {
      setDrawerView("detail");
      setDrawerOpen(true);
    }
  }

  function focusTakeOnScript(take: ReviewTakeGroup): void {
    const episode = take.effective_mapping.episode_ids[0] ?? takeEpisodeIds(take)[0] ?? null;
    if (episode !== null) setActiveEpisode(episode);
    setSelectedScriptSegmentId(preferredScriptSegmentId(take));
    setDrawerOpen(false);
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
        ? `已人工归集 ${label} → ${segmentIds.length} 个剧本段`
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
      <header className="workspace-toolbar script-workspace-toolbar">
        <div className="episode-strip" aria-label="剧本集数">
          {model.episodes.map((episode) => (
            <button
              type="button"
              className={`${episode.episode === selectedEpisode?.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
              key={episode.episode}
              onClick={() => {
                setActiveEpisode(episode.episode);
                setSelectedScriptSegmentId(null);
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
        <div className="workspace-toolbar-actions">
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
          <button type="button" className="secondary" onClick={() => { setDrawerView("candidates"); setDrawerOpen(true); }}>选择素材</button>
          <button type="button" className="secondary" onClick={() => { setDrawerView("batch"); setRoughPreview(null); setDrawerOpen(true); }}>批量归集</button>
          <label className="review-actor-field compact-actor">
            <span>审核昵称</span>
            <input value={actor} placeholder="写入时必填" onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} />
          </label>
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
                setDrawerView("candidates");
                setDrawerOpen(true);
                return;
              }
              void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "desktop-script-segment");
            }}
          />
        ) : <p className="empty-copy">当前项目没有剧本段。</p>}
      </main>

      {drawerOpen ? (
        <div className="workspace-context-layer">
          <button type="button" className="workspace-context-backdrop" aria-label="关闭剧本上下文" onClick={() => setDrawerOpen(false)} />
          <aside className="workspace-context-drawer" aria-label="剧本上下文">
            <header className="workspace-context-heading">
              <div>
                <span>{drawerView === "batch" ? "批量归集" : drawerView === "detail" ? "Take 详情" : "匹配素材"}</span>
                <strong>{drawerView === "batch" ? "Take 范围 → 集数" : selectedTake ? takeDisplayLabel(selectedTake) : "选择 Take"}</strong>
              </div>
              <button type="button" className="secondary" onClick={() => setDrawerOpen(false)}>关闭</button>
            </header>

            {drawerView === "batch" ? (
              <section className="rough-placement-tool">
                <div className="rough-placement-copy">
                  <strong>按 Take 范围归集到集数</strong>
                  <p>例如：1-10 第1集；11-20 第2集。先预览，再确认写入。</p>
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
            ) : drawerView === "candidates" ? (
              <div className="script-candidate-browser">
                <div className="workspace-context-tabs">
                  <button type="button" className={candidateScope === "context" ? "is-active" : ""} onClick={() => setCandidateScope("context")}>当前上下文</button>
                  <button type="button" className={candidateScope === "all" ? "is-active" : ""} onClick={() => setCandidateScope("all")}>全部素材</button>
                  {selectedTake ? <button type="button" onClick={() => setDrawerView("detail")}>当前详情</button> : null}
                </div>
                <div className="script-context-take-list">
                  {candidateTakes.length ? candidateTakes.map((take) => (
                    <TakeListRow
                      take={take}
                      detail={take.group_id === selectedGroupId ? `当前选择 · ${mappingLabel(take)}` : mappingLabel(take)}
                      action={() => {
                        selectTake(take, false);
                        setDrawerOpen(false);
                      }}
                      actionLabel={take.group_id === selectedGroupId ? "已选" : "使用"}
                      onSelect={() => selectTake(take, true)}
                      onDragStart={(event, rowTake) => beginDrag(event, rowTake.group_id)}
                      key={take.group_id}
                    />
                  )) : <div className="workspace-context-empty">当前上下文没有候选 Take；切到“全部素材”可手动选择。</div>}
                </div>
              </div>
            ) : selectedTake ? (
              <>
                <div className="workspace-context-tabs">
                  <button type="button" onClick={() => setDrawerView("candidates")}>素材列表</button>
                  <button type="button" className="is-active">当前详情</button>
                </div>
                <TakeInspector
                  connection={connection}
                  projectId={project.project_id}
                  take={selectedTake}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  onShowScript={() => focusTakeOnScript(selectedTake)}
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
