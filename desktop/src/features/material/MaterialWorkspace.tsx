import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, ReviewTakeGroup } from "../../api/host";
import { TakeInspector } from "../material-script/TakeInspector";
import { takeDisplayLabel } from "../material-script/TakeCard";
import { VirtualTakeList, episodeLabel } from "../material-script/VirtualTakeList";
import {
  takeMatchesFilters,
  takeStatus,
  type TakeStatusFilter,
} from "../material-script/model";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import "../material-script/material-script.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  onOpenScript?: (groupId: string) => void;
}

const STATUS_OPTIONS: Array<{ value: Exclude<TakeStatusFilter, "attention">; label: string }> = [
  { value: "all", label: "全部" },
  { value: "candidate", label: "AI候选" },
  { value: "pending", label: "待归集" },
  { value: "placed", label: "已归集" },
  { value: "rejected", label: "已排除" },
];

export function MaterialWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  onOpenScript,
}: Props) {
  const { connection, loadState, message, model } = useReviewModelSnapshot(baseUrl, project.project_id);
  const [episodeFilter, setEpisodeFilter] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<Exclude<TakeStatusFilter, "attention">>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialGroupId));

  const filteredTakes = useMemo(
    () => model?.take_groups.filter((take) => takeMatchesFilters(take, statusFilter, episodeFilter)) ?? [],
    [episodeFilter, model, statusFilter],
  );

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;

  const statusCounts = useMemo(() => {
    const counts = { candidate: 0, pending: 0, placed: 0, rejected: 0 };
    for (const take of model?.take_groups ?? []) counts[takeStatus(take)] += 1;
    return counts;
  }, [model]);

  useEffect(() => {
    if (!model) return;
    const focused = initialGroupId ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null : null;
    const first = focused ?? model.take_groups[0] ?? null;
    setSelectedGroupId(first?.group_id ?? null);
    setSelectedClipId(first?.angles[0]?.clip_id ?? null);
    setDrawerOpen(Boolean(focused));
  }, [initialGroupId, model]);

  useEffect(() => {
    if (!model) return;
    if (filteredTakes.length === 0) {
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

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    setDrawerOpen(true);
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="material-workspace">
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>
      </section>
    );
  }

  return (
    <section className="material-workspace">
      <header className="workspace-toolbar material-workspace-toolbar">
        <div className="status-filter" aria-label="Take 筛选">
          {STATUS_OPTIONS.map((option) => (
            <button
              type="button"
              className={statusFilter === option.value ? "is-active" : ""}
              key={option.value}
              onClick={() => setStatusFilter(option.value)}
            >
              {option.label} <span>{option.value === "all" ? model.take_groups.length : statusCounts[option.value]}</span>
            </button>
          ))}
        </div>
        <span className="workspace-count">{filteredTakes.length} / {model.take_groups.length} Take</span>
      </header>

      <div className="workspace-filter-strip" aria-label="集数筛选">
        <button type="button" className={episodeFilter === null ? "is-active" : ""} onClick={() => setEpisodeFilter(null)}>全部集</button>
        {model.episodes.map((episode) => (
          <button
            type="button"
            className={episodeFilter === episode.episode ? "is-active" : ""}
            key={episode.episode}
            onClick={() => setEpisodeFilter(episode.episode)}
          >
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
              <TakeInspector
                connection={connection}
                projectId={project.project_id}
                take={selectedTake}
                selectedClipId={selectedClipId}
                onSelectClip={setSelectedClipId}
                onShowScript={() => onOpenScript?.(selectedTake.group_id)}
                writeSaving={false}
              />
            ) : <div className="workspace-context-empty">当前没有可查看的 Take。</div>}
          </aside>
        </div>
      ) : null}
    </section>
  );
}
