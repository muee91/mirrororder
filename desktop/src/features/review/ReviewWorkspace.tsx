import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary, ReviewTakeGroup } from "../../api/host";
import { TakeInspector } from "../material-script/TakeInspector";
import { VirtualTakeList } from "../material-script/VirtualTakeList";
import {
  takeMatchesFilters,
  takeStatus,
  type TakeStatusFilter,
} from "../material-script/model";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import { reviewTakeAttention } from "./reviewAttention";
import "../material-script/material-script.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  onOpenScript?: (groupId: string) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null) => void;
}

const STATUS_OPTIONS: Array<{ value: TakeStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "attention", label: "需关注" },
  { value: "candidate", label: "AI候选" },
  { value: "pending", label: "待归集" },
  { value: "placed", label: "已归集" },
  { value: "rejected", label: "已排除" },
];

export function ReviewWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  onOpenScript,
  onOpenTimeline,
}: Props) {
  const { connection, loadState, message, model } = useReviewModelSnapshot(baseUrl, project.project_id);
  const [statusFilter, setStatusFilter] = useState<TakeStatusFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const filteredTakes = useMemo(
    () => model?.take_groups.filter((take) => takeMatchesFilters(take, statusFilter, null)) ?? [],
    [model, statusFilter],
  );
  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
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
    const focused = initialGroupId ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null : null;
    const first = focused ?? model.take_groups[0] ?? null;
    setSelectedGroupId(first?.group_id ?? null);
    setSelectedClipId(first?.angles[0]?.clip_id ?? null);
  }, [initialGroupId, model]);

  useEffect(() => {
    if (!model) return;
    if (filteredTakes.length === 0) {
      setSelectedGroupId(null);
      setSelectedClipId(null);
      return;
    }
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      const first = filteredTakes[0];
      setSelectedGroupId(first.group_id);
      setSelectedClipId(first.angles[0]?.clip_id ?? null);
    }
  }, [filteredTakes, model, selectedGroupId]);

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="review-workspace">
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`}>{message}</div>
      </section>
    );
  }

  return (
    <section className="review-workspace">
      <header className="workspace-toolbar review-workspace-toolbar">
        <div className="status-filter" aria-label="看片筛选">
          {STATUS_OPTIONS.map((option) => (
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
        <span className="workspace-count">{filteredTakes.length} / {model.take_groups.length} Take</span>
      </header>

      <main className="review-primary-canvas">
        <aside className="review-queue" aria-label="看片队列">
          {filteredTakes.length ? (
            <VirtualTakeList
              variant="compact"
              takes={filteredTakes}
              selectedGroupId={selectedGroupId}
              onSelect={selectTake}
              allowDrag={false}
            />
          ) : <div className="phase-placeholder compact-placeholder">当前筛选没有 Take。</div>}
        </aside>
        <section className="review-viewer-pane" aria-label="看片与人工决定">
          {selectedTake ? (
            <div className="review-cross-actions" aria-label="继续处理当前 Take">
              <button type="button" className="secondary" onClick={() => onOpenScript?.(selectedTake.group_id)}>在剧本中打开</button>
              <button type="button" className="secondary" onClick={() => onOpenTimeline?.(selectedTake.group_id, selectedClipId)}>到时间线</button>
            </div>
          ) : null}
          <TakeInspector
            connection={connection}
            projectId={project.project_id}
            take={selectedTake}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            onShowScript={() => selectedTake && onOpenScript?.(selectedTake.group_id)}
            writeSaving={false}
            showEditorial
          />
        </section>
      </main>
    </section>
  );
}
