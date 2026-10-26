import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectSummary, ReviewTakeGroup } from "../../api/host";
import {
  ProductionClient,
  type SlateBoard,
  type SlateEntry,
  type SlateRecord,
  type SlateStatus,
} from "../../api/production";
import { TakeInspector } from "../material-script/TakeInspector";
import { mappingLabel, takeDisplayLabel } from "../material-script/TakeCard";
import { VirtualTakeList, episodeLabel } from "../material-script/VirtualTakeList";
import { takeEpisodeIds } from "../material-script/model";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import "../material-script/material-script.css";

type MaterialTakeFilter = "all" | "unmapped" | "candidate" | "mapped" | "offline";

type SlateFact = {
  episode: number | null;
  scene: string;
  shot: string;
  takeNumber: number | null;
  status: SlateStatus;
  note: string;
};

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  initialClipId?: string | null;
  onSelectionChange?: (groupId: string | null, clipId: string | null) => void;
  onOpenScript?: (groupId: string, clipId?: string | null) => void;
  onOpenReview?: (groupId: string, clipId?: string | null) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null) => void;
  onOpenRepair?: () => void;
}

const FILTERS: Array<{ value: MaterialTakeFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unmapped", label: "待归集" },
  { value: "candidate", label: "有候选" },
  { value: "mapped", label: "已归集" },
  { value: "offline", label: "素材离线" },
];

const SLATE_STATUS_LABELS: Record<SlateStatus, string> = {
  unmarked: "未标记",
  usable: "可用",
  partial: "部分可用",
  ng: "NG",
};

function factFromEntry(entry: SlateEntry): SlateFact {
  return {
    episode: entry.episode,
    scene: entry.scene,
    shot: entry.shot,
    takeNumber: entry.take_number,
    status: entry.status,
    note: entry.note,
  };
}

function factFromRecord(record: SlateRecord): SlateFact {
  return {
    episode: record.episode,
    scene: record.scene,
    shot: record.shot,
    takeNumber: record.take_number,
    status: record.status,
    note: record.note,
  };
}

function slateFactIndex(board: SlateBoard | null): Map<string, SlateFact> {
  const facts = new Map<string, SlateFact>();
  if (!board) return facts;
  for (const entry of Object.values(board.entries)) {
    if (entry.group_id) facts.set(entry.group_id, factFromEntry(entry));
  }
  for (const record of Object.values(board.records)) {
    if (record.source_group_id) facts.set(record.source_group_id, factFromRecord(record));
  }
  return facts;
}

function isMapped(take: ReviewTakeGroup): boolean {
  const mapping = take.effective_mapping;
  return mapping.source !== "none" && (mapping.episode_ids.length > 0 || mapping.script_segment_ids.length > 0);
}

function hasCandidate(take: ReviewTakeGroup): boolean {
  return take.candidates.length > 0 || take.automatic_state.status === "needs_review";
}

function hasOfflineMedia(take: ReviewTakeGroup): boolean {
  return take.angles.length === 0 || take.angles.some((angle) => angle.playback.state === "missing" || angle.playback.available === false);
}

function mediaAvailabilityLabel(take: ReviewTakeGroup): string {
  if (!take.angles.length) return "无机位素材";
  const available = take.angles.filter((angle) => angle.playback.state !== "missing" && angle.playback.available !== false).length;
  if (available === take.angles.length) return `${available} 机位可用`;
  if (available === 0) return `${take.angles.length} 机位离线`;
  return `${available}/${take.angles.length} 机位可用`;
}

function slateFactLabel(fact: SlateFact | undefined): string {
  if (!fact) return "未关联场记";
  const parts = [
    fact.episode ? episodeLabel(fact.episode) : "",
    fact.scene ? `场 ${fact.scene}` : "",
    fact.shot ? `镜 ${fact.shot}` : "",
    fact.takeNumber ? `T${fact.takeNumber}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "场记未编号";
}

function takeSearchText(take: ReviewTakeGroup, fact: SlateFact | undefined): string {
  return [
    takeDisplayLabel(take),
    take.transcript.text,
    mappingLabel(take),
    fact?.scene,
    fact?.shot,
    fact?.takeNumber ? String(fact.takeNumber) : "",
    fact?.note,
    ...take.angles.flatMap((angle) => [angle.name, angle.camera, angle.shot_type || ""]),
    ...take.issues.map((issue) => issue.label),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

export function MaterialTakeView({
  baseUrl,
  project,
  initialGroupId = null,
  initialClipId = null,
  onSelectionChange,
  onOpenScript,
  onOpenReview,
  onOpenTimeline,
  onOpenRepair,
}: Props) {
  const { connection, loadState, message, model } = useReviewModelSnapshot(baseUrl, project.project_id);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [slateBoard, setSlateBoard] = useState<SlateBoard | null>(null);
  const [slateAvailable, setSlateAvailable] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MaterialTakeFilter>("all");
  const [episodeFilter, setEpisodeFilter] = useState<number | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(initialClipId);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialGroupId));
  const [playbackFailedClips, setPlaybackFailedClips] = useState<ReadonlySet<string>>(() => new Set());
  // 服务端声明“可用”只代表绑定证据存在；真实加载失败（404/解码失败）发生在本机，
  // 由 Take 详情上抛到这里聚合成独立计数，与“素材离线”（服务端口径）分开呈现。
  const handlePlaybackResult = useCallback((clipId: string, failed: boolean) => {
    setPlaybackFailedClips((current) => {
      if (current.has(clipId) === failed) return current;
      const next = new Set(current);
      if (failed) next.add(clipId); else next.delete(clipId);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSlateAvailable(true);
    void production.scriptSupervisor(project.project_id).then((board) => {
      if (cancelled) return;
      setSlateBoard(board);
    }).catch(() => {
      if (cancelled) return;
      setSlateBoard(null);
      setSlateAvailable(false);
    });
    return () => { cancelled = true; };
  }, [production, project.project_id]);

  const slateFacts = useMemo(() => slateFactIndex(slateBoard), [slateBoard]);
  const runtimeFailedCount = useMemo(
    () => (model?.take_groups ?? []).filter((take) => take.angles.some((angle) => playbackFailedClips.has(angle.clip_id))).length,
    [model, playbackFailedClips],
  );

  const counts = useMemo(() => {
    const next = { all: 0, unmapped: 0, candidate: 0, mapped: 0, offline: 0 };
    for (const take of model?.take_groups ?? []) {
      next.all += 1;
      if (!isMapped(take)) next.unmapped += 1;
      if (hasCandidate(take)) next.candidate += 1;
      if (isMapped(take)) next.mapped += 1;
      if (hasOfflineMedia(take)) next.offline += 1;
    }
    return next;
  }, [model]);

  const filteredTakes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (model?.take_groups ?? []).filter((take) => {
      const fact = slateFacts.get(take.group_id);
      if (filter === "unmapped" && isMapped(take)) return false;
      if (filter === "candidate" && !hasCandidate(take)) return false;
      if (filter === "mapped" && !isMapped(take)) return false;
      if (filter === "offline" && !hasOfflineMedia(take)) return false;
      if (episodeFilter !== null) {
        const episodes = new Set(takeEpisodeIds(take));
        if (fact?.episode) episodes.add(fact.episode);
        if (!episodes.has(episodeFilter)) return false;
      }
      if (needle && !takeSearchText(take, fact).includes(needle)) return false;
      return true;
    });
  }, [episodeFilter, filter, model, query, slateFacts]);

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;
  const selectedFact = selectedTake ? slateFacts.get(selectedTake.group_id) : undefined;

  useEffect(() => {
    if (!model) return;
    const focused = initialGroupId ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null : null;
    const first = focused ?? model.take_groups[0] ?? null;
    const requestedClip = first && initialClipId && first.angles.some((angle) => angle.clip_id === initialClipId)
      ? initialClipId
      : first?.angles[0]?.clip_id ?? null;
    setSelectedGroupId(first?.group_id ?? null);
    setSelectedClipId(requestedClip);
    setDrawerOpen(Boolean(focused));
  }, [initialClipId, initialGroupId, model]);

  useEffect(() => {
    if (!model) return;
    if (!filteredTakes.length) {
      setSelectedGroupId(null);
      setSelectedClipId(null);
      setDrawerOpen(false);
      return;
    }
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      const first = filteredTakes[0];
      setSelectedGroupId(first.group_id);
      setSelectedClipId(first.angles[0]?.clip_id ?? null);
      setDrawerOpen(false);
    }
  }, [filteredTakes, model, selectedGroupId]);

  useEffect(() => {
    onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId);
  }, [selectedTake?.group_id, selectedClipId]);

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    setDrawerOpen(true);
  }

  if (loadState !== "ready" || !model) {
    return <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>;
  }

  return (
    <section className="material-take-view">
      <header className="workspace-toolbar material-take-toolbar">
        <input
          className="material-take-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 Take、场镜次、机位、对白或备注"
          aria-label="搜索 Take"
        />
        <div className="material-take-filters" aria-label="Take 状态筛选">
          {FILTERS.map((item) => (
            <button type="button" className={filter === item.value ? "is-active" : ""} key={item.value} onClick={() => setFilter(item.value)}>
              {item.label} <span>{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <span className="workspace-count">{filteredTakes.length} / {model.take_groups.length} Take</span>
      </header>

      <div className="material-take-summary" aria-label="素材 Take 摘要">
        <span><strong>{model.take_groups.length}</strong> Take</span>
        <span><strong>{slateFacts.size}</strong> 有场记</span>
        <span className={counts.unmapped ? "needs-attention" : ""}><strong>{counts.unmapped}</strong> 待归集</span>
        <span className={counts.offline ? "needs-attention" : ""} title="服务端判定不可用的机位素材"><strong>{counts.offline}</strong> 素材离线</span>
        {runtimeFailedCount ? <span className="needs-attention" title="服务端声明可用、但本机加载失败的素材；多为素材盘未挂载或绑定变化，重新挂载后在详情里重试"><strong>{runtimeFailedCount}</strong> 本机播放失败</span> : null}
        {!slateAvailable ? <span className="needs-attention">场记关联暂不可用</span> : null}
      </div>

      <div className="workspace-filter-strip" aria-label="按集数查看 Take">
        <button type="button" className={episodeFilter === null ? "is-active" : ""} onClick={() => setEpisodeFilter(null)}>全部集</button>
        {model.episodes.map((episode) => (
          <button type="button" className={episodeFilter === episode.episode ? "is-active" : ""} key={episode.episode} onClick={() => setEpisodeFilter(episode.episode)}>
            {episodeLabel(episode.episode)}
          </button>
        ))}
      </div>

      <main className="material-primary-canvas">
        {filteredTakes.length ? (
          <VirtualTakeList
            variant="compact"
            takes={filteredTakes}
            selectedGroupId={selectedGroupId}
            onSelect={selectTake}
            allowDrag={false}
            detailForTake={(take) => `${slateFactLabel(slateFacts.get(take.group_id))} · ${mappingLabel(take)} · ${mediaAvailabilityLabel(take)}`}
          />
        ) : <div className="phase-placeholder compact-placeholder">当前筛选没有 Take。</div>}
      </main>

      {drawerOpen ? (
        <div className="workspace-context-layer">
          <button type="button" className="workspace-context-backdrop" aria-label="关闭 Take 详情" onClick={() => setDrawerOpen(false)} />
          <aside className="workspace-context-drawer" aria-label="Take 详情">
            <header className="workspace-context-heading">
              <div><span>Take 详情</span><strong>{selectedTake ? takeDisplayLabel(selectedTake) : "选择 Take"}</strong></div>
              <button type="button" className="secondary" onClick={() => setDrawerOpen(false)}>关闭</button>
            </header>
            {selectedTake ? (
              <>
                <div className="material-take-cross-actions" aria-label="继续处理当前 Take">
                  <button type="button" onClick={() => onOpenScript?.(selectedTake.group_id, selectedClipId)}>在剧本中打开</button>
                  <button type="button" className="secondary" onClick={() => onOpenReview?.(selectedTake.group_id, selectedClipId)}>在审阅中打开</button>
                  <button type="button" className="secondary" onClick={() => onOpenTimeline?.(selectedTake.group_id, selectedClipId)}>到时间线</button>
                  {hasOfflineMedia(selectedTake) && onOpenRepair ? <button type="button" className="secondary" onClick={onOpenRepair}>修复本机素材</button> : null}
                </div>

                <section className="material-take-facts" aria-label="当前 Take 拍摄事实">
                  <div className="material-take-facts-heading"><span>拍摄事实</span><strong>{slateFactLabel(selectedFact)}</strong></div>
                  {selectedFact ? (
                    <>
                      <dl>
                        <div><dt>场</dt><dd>{selectedFact.scene || "—"}</dd></div>
                        <div><dt>镜</dt><dd>{selectedFact.shot || "—"}</dd></div>
                        <div><dt>Take</dt><dd>{selectedFact.takeNumber ?? "—"}</dd></div>
                        <div><dt>场记状态</dt><dd>{SLATE_STATUS_LABELS[selectedFact.status]}</dd></div>
                        <div><dt>媒体</dt><dd>{mediaAvailabilityLabel(selectedTake)}</dd></div>
                        <div><dt>剧本归属</dt><dd>{mappingLabel(selectedTake)}</dd></div>
                      </dl>
                      {selectedFact.note ? <p>{selectedFact.note}</p> : null}
                    </>
                  ) : (
                    <p>当前 Take 尚未关联电子场记；可以先查看机位与媒体，再回到“场记”补充拍摄事实。</p>
                  )}
                </section>

                <TakeInspector
                  connection={connection}
                  projectId={project.project_id}
                  take={selectedTake}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  onPlaybackResult={handlePlaybackResult}
                  writeSaving={false}
                />
              </>
            ) : <div className="workspace-context-empty">当前没有可查看的 Take。</div>}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
