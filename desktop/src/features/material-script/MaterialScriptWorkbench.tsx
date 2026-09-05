import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  HostConnection,
  HostConnectionError,
  type ProjectSummary,
  type ReviewModelPayload,
  type ReviewScriptBlock,
  type ReviewTakeGroup,
} from "../../api/host";
import { reviewTakeAttention } from "../review/reviewAttention";
import { ScriptEpisodeView, dragGroupId, scriptDomId } from "./ScriptEpisodeView";
import { takeDisplayLabel } from "./TakeCard";
import { TakeInspector } from "./TakeInspector";
import { DRAG_TAKE_MIME, VirtualTakeList, episodeLabel } from "./VirtualTakeList";
import {
  preferredScriptSegmentId,
  takeEpisodeIds,
  takeMatchesFilters,
  takeStatus,
  type TakeStatusFilter,
} from "./model";

type WorkbenchTab = "material" | "script";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  initialTab?: WorkbenchTab;
  showEditorial?: boolean;
}

type LoadState = "loading" | "ready" | "error";
type WriteState = "idle" | "saving" | "error";

const ACTOR_STORAGE_KEY = "mirrororder.desktop-v2.review-actor";
const STATUS_OPTIONS: Array<{ value: TakeStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需关注" },
  { value: "candidate", label: "AI/算法候选" },
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

export function MaterialScriptWorkbench({
  baseUrl,
  project,
  initialGroupId = null,
  initialTab = "material",
  showEditorial = false,
}: Props) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [tab, setTab] = useState<WorkbenchTab>(initialTab);
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

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, project.project_id]);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setMessage("正在读取审阅状态…");
    setWriteMessage("");
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
      setMessage(`已载入 ${next.take_groups.length} Take · ${next.episodes.length} 集`);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadState("error");
      setMessage(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [connection, initialGroupId, project.project_id]);

  useEffect(() => {
    if (tab !== "script" || !selectedScriptSegmentId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(scriptDomId(selectedScriptSegmentId))?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [activeEpisode, selectedScriptSegmentId, tab]);

  // Episode controls are horizontally scrollable in material-script.css, so
  // every episode stays reachable even for 100+ episode productions. Never
  // truncate this authority-bearing navigation for presentation convenience.
  const episodeButtons = model?.episodes ?? [];
  const selectedEpisode = model?.episodes.find((item) => item.episode === activeEpisode) ?? model?.episodes[0] ?? null;
  const statusOptions = showEditorial ? STATUS_OPTIONS : STATUS_OPTIONS.filter((option) => option.value !== "attention");
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

  useEffect(() => {
    if (!model) return;
    if (filteredTakes.length === 0) {
      setSelectedGroupId(null);
      setSelectedClipId(null);
      return;
    }
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      setSelectedGroupId(filteredTakes[0].group_id);
      setSelectedClipId(filteredTakes[0].angles[0]?.clip_id ?? null);
    }
  }, [filteredTakes, model, selectedGroupId]);

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
  }

  function showTakeInScript(take: ReviewTakeGroup): void {
    const episode = take.effective_mapping.episode_ids[0] ?? takeEpisodeIds(take)[0] ?? null;
    if (episode !== null) setActiveEpisode(episode);
    setSelectedScriptSegmentId(preferredScriptSegmentId(take));
    setTab("script");
  }

  function showScriptTake(groupId: string): void {
    const take = model?.take_groups.find((item) => item.group_id === groupId);
    if (!take) return;
    setStatusFilter("all");
    setMaterialEpisode(null);
    selectTake(take);
    setTab("material");
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
    setMessage(`已更新 · ${next.take_groups.length} Take · ${next.episodes.length} 集`);
    setWriteState("idle");
    setWriteMessage(summary);
  }

  async function placeTake(groupId: string, episodeIds: number[], segmentIds: string[], interaction: "drag" | "click", surface: string): Promise<void> {
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
        sourceSurface: surface,
        sourceClipId: groupId === selectedGroupId ? selectedClipId ?? undefined : undefined,
      });
      const label = displayGroup(groupId);
      const summary = segmentIds.length
        ? `已人工归集 ${label} → ${segmentIds.join(", ")}`
        : `已人工粗归集 ${label} → ${episodeIds.map(episodeLabel).join(" / ")}`;
      await refreshAfterWrite(groupId, summary);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          const latest = await connection.reviewModel(project.project_id);
          setModel(latest);
          setWriteMessage("审阅状态已变化并刷新；请重新拖放。");
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
        sourceSurface: "desktop-v2-material",
      });
      await refreshAfterWrite(selectedTake.group_id, `已清除 ${takeDisplayLabel(selectedTake)} 的人工归集；自动状态未改动。`);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          const latest = await connection.reviewModel(project.project_id);
          setModel(latest);
          setWriteMessage("审阅状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(errorMessage(error));
        }
      } else {
        setWriteMessage(errorMessage(error));
      }
    }
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="material-script-workbench">
        <div className="workbench-heading"><h2>{project.name || project.project_id}</h2></div>
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>
      </section>
    );
  }

  return (
    <section className="material-script-workbench">
      <div className="workbench-heading phase2-heading">
        <div><p className="eyebrow">项目</p><h2>{project.name || project.project_id}</h2></div>
        <div className="workbench-revision"><span>{model.take_groups.length} Take · {model.episodes.length} 集</span></div>
      </div>
      <nav className="workbench-tabs" aria-label="素材剧本工作台">
        <button type="button" className={tab === "material" ? "is-active" : ""} onClick={() => setTab("material")}>素材</button>
        <button type="button" className={tab === "script" ? "is-active" : ""} onClick={() => setTab("script")}>剧本</button>
      </nav>
      <div className="projection-status"><span className="status-dot status-dot-ready" />{message}</div>

      {tab === "material" ? (
        <div className="take-workbench">
          <div className="material-controls">
            <div className="status-filter">
              {statusOptions.map((option) => (
                <button type="button" className={statusFilter === option.value ? "is-active" : ""} key={option.value} onClick={() => setStatusFilter(option.value)}>
                  {option.label} <span>{option.value === "all" ? model.take_groups.length : statusCounts[option.value]}</span>
                </button>
              ))}
            </div>
            <label className="review-actor-field"><span>审核昵称</span><input value={actor} placeholder="写入人工归集时必填" onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} /></label>
          </div>
          <div className="episode-filter">
            <button type="button" className={materialEpisode === null ? "is-active" : ""} onClick={() => setMaterialEpisode(null)}>全部集</button>
            {episodeButtons.map((episode) => (
              <button
                type="button"
                className={`${materialEpisode === episode.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
                key={episode.episode}
                onClick={() => setMaterialEpisode(episode.episode)}
                onDragOver={(event) => { if (draggingGroupId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                onDrop={(event) => { event.preventDefault(); const groupId = dragGroupId(event); if (groupId) void placeTake(groupId, [episode.episode], [], "drag", "desktop-v2-material-episode"); }}
                title="拖入 Take：只归集到该集（episode-only）"
              >{episodeLabel(episode.episode)}</button>
            ))}
          </div>
          <div className={`write-status write-${writeState}`}>{writeMessage || (showEditorial ? "“需关注”汇总问题、过期证据、未归集与尚待裁决的团队意见；筛选本身不会修改任何人工决定。" : "拖到集数=粗归集；剧本页可精确归集。")}</div>
          <div className="material-layout">
            <div className="take-list-column">
              {filteredTakes.length ? (
                <VirtualTakeList takes={filteredTakes} selectedGroupId={selectedGroupId} onSelect={selectTake} onDragBegin={setDraggingGroupId} onDragFinish={() => setDraggingGroupId(null)} />
              ) : <div className="phase-placeholder compact-placeholder">当前筛选没有 Take。</div>}
            </div>
            <TakeInspector
              connection={connection}
              projectId={project.project_id}
              take={selectedTake}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onShowScript={() => selectedTake && showTakeInScript(selectedTake)}
              onClearPlacement={() => void clearPlacement()}
              writeSaving={writeState === "saving"}
              showEditorial={showEditorial}
            />
          </div>
        </div>
      ) : (
        <div className="script-workbench">
          <div className="script-toolbar">
            <div className="episode-strip">
              {episodeButtons.map((episode) => (
                <button
                  type="button"
                  className={`${episode.episode === selectedEpisode?.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
                  key={episode.episode}
                  onClick={() => setActiveEpisode(episode.episode)}
                  onDragOver={(event) => { if (draggingGroupId) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
                  onDrop={(event) => { event.preventDefault(); const groupId = dragGroupId(event); if (groupId) void placeTake(groupId, [episode.episode], [], "drag", "desktop-v2-script-episode"); }}
                >{episodeLabel(episode.episode)}</button>
              ))}
            </div>
            <label className="review-actor-field compact-actor"><span>审核昵称</span><input value={actor} placeholder="写入时必填" onChange={(event) => setActor(event.target.value)} /></label>
          </div>
          <div className="script-placement-tray">
            {selectedTake ? (
              <div className="selected-take-drag" draggable onDragStart={(event) => beginDrag(event, selectedTake.group_id)} onDragEnd={() => setDraggingGroupId(null)}>
                当前 Take · <strong>{takeDisplayLabel(selectedTake)}</strong> <span>拖到集数或剧本段</span>
              </div>
            ) : <span>先在素材页选择一个 Take。</span>}
          </div>
          <div className={`write-status write-${writeState}`}>{writeMessage || "放到集数=episode-only；放到非场景标题剧本段=精确 placement。"}</div>
          {selectedEpisode ? (
            <ScriptEpisodeView
              episode={selectedEpisode}
              model={model}
              selectedSegmentId={selectedScriptSegmentId}
              draggingGroupId={draggingGroupId}
              placementGroupId={selectedTake?.group_id ?? null}
              onShowTake={showScriptTake}
              onDropPlacement={(groupId, block) => { setSelectedScriptSegmentId(block.segment_id); void placeTake(groupId, block.episode > 0 ? [block.episode] : [], [block.segment_id], "drag", "desktop-v2-script-segment"); }}
              onClickPlacement={(block: ReviewScriptBlock) => { if (!selectedTake) return; setSelectedScriptSegmentId(block.segment_id); void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "desktop-v2-script-segment"); }}
            />
          ) : <p className="empty-copy">当前项目没有剧本段。</p>}
        </div>
      )}
    </section>
  );
}
