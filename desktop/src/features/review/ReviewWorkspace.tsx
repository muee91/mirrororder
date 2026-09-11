import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, ReviewTakeGroup } from "../../api/host";
import { mappingLabel, takeDisplayLabel } from "../material-script/TakeCard";
import { TakeInspector } from "../material-script/TakeInspector";
import { VirtualTakeList } from "../material-script/VirtualTakeList";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import { ReviewDecisionPanel } from "./ReviewDecisionPanel";
import { reviewTakeAttention } from "./reviewAttention";
import "../material-script/material-script.css";
import "./review-workspace.css";

type ReviewQueueFilter = "all" | "unreviewed" | "attention" | "best" | "keep" | "reject";
type ReviewFinalState = Exclude<ReviewQueueFilter, "all" | "attention">;

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  initialClipId?: string | null;
  onSelectionChange?: (groupId: string | null, clipId: string | null) => void;
  onOpenMaterial?: (groupId: string, clipId?: string | null) => void;
  onOpenScript?: (groupId: string, clipId?: string | null) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null) => void;
}

const FILTERS: Array<{ value: ReviewQueueFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unreviewed", label: "未决定" },
  { value: "attention", label: "需关注" },
  { value: "best", label: "Best" },
  { value: "keep", label: "Keep" },
  { value: "reject", label: "Reject" },
];

const FINAL_LABELS: Record<ReviewFinalState, string> = {
  unreviewed: "未决定",
  best: "Best",
  keep: "Keep",
  reject: "Reject",
};

type EditorialProjection = {
  group?: { state?: string } | null;
  state?: string;
};

function finalState(take: ReviewTakeGroup): ReviewFinalState {
  const editorial = take.editorial_state.editorial_decision as EditorialProjection | null | undefined;
  const state = String(editorial?.group?.state || editorial?.state || "unreviewed");
  if (state === "best" || state === "keep" || state === "reject") return state;
  return "unreviewed";
}

function queueDetail(take: ReviewTakeGroup): string {
  const state = finalState(take);
  const attention = reviewTakeAttention(take);
  return [
    `最终 ${FINAL_LABELS[state]}`,
    attention.hasAttention ? `需关注 ${attention.labels.length}` : "",
    mappingLabel(take),
  ].filter(Boolean).join(" · ");
}

export function ReviewWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  initialClipId = null,
  onSelectionChange,
  onOpenMaterial,
  onOpenScript,
  onOpenTimeline,
}: Props) {
  const { connection, loadState, message, model, refresh } = useReviewModelSnapshot(baseUrl, project.project_id);
  const [filter, setFilter] = useState<ReviewQueueFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(initialClipId);
  const appliedFocusKey = useRef("");

  const counts = useMemo(() => {
    const next: Record<ReviewQueueFilter, number> = { all: 0, unreviewed: 0, attention: 0, best: 0, keep: 0, reject: 0 };
    for (const take of model?.take_groups ?? []) {
      next.all += 1;
      next[finalState(take)] += 1;
      if (reviewTakeAttention(take).hasAttention) next.attention += 1;
    }
    return next;
  }, [model]);

  const filteredTakes = useMemo(() => {
    const rows = (model?.take_groups ?? []).filter((take) => {
      if (filter === "all") return true;
      if (filter === "attention") return reviewTakeAttention(take).hasAttention;
      return finalState(take) === filter;
    });
    if (filter === "attention") {
      rows.sort((left, right) => reviewTakeAttention(right).priority - reviewTakeAttention(left).priority);
    }
    return rows;
  }, [filter, model]);

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;
  const selectedIndex = selectedGroupId ? filteredTakes.findIndex((take) => take.group_id === selectedGroupId) : -1;
  const selectedAttention = selectedTake ? reviewTakeAttention(selectedTake) : null;
  const decidedCount = counts.best + counts.keep + counts.reject;

  useEffect(() => {
    if (!model) return;
    const focusKey = `${project.project_id}:${initialGroupId ?? ""}:${initialClipId ?? ""}`;
    const shouldApplyFocus = Boolean(initialGroupId) && appliedFocusKey.current !== focusKey;
    const focused = shouldApplyFocus ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null : null;
    if (focused) {
      setSelectedGroupId(focused.group_id);
      setSelectedClipId(
        initialClipId && focused.angles.some((angle) => angle.clip_id === initialClipId)
          ? initialClipId
          : focused.angles[0]?.clip_id ?? null,
      );
      appliedFocusKey.current = focusKey;
      return;
    }
    setSelectedGroupId((current) => current && model.take_groups.some((take) => take.group_id === current)
      ? current
      : model.take_groups[0]?.group_id ?? null);
  }, [initialClipId, initialGroupId, model, project.project_id]);

  useEffect(() => {
    if (!selectedTake) {
      setSelectedClipId(null);
      return;
    }
    if (!selectedClipId || !selectedTake.angles.some((angle) => angle.clip_id === selectedClipId)) {
      setSelectedClipId(selectedTake.angles[0]?.clip_id ?? null);
    }
  }, [selectedClipId, selectedTake]);

  useEffect(() => {
    if (!model) return;
    if (filteredTakes.length === 0) {
      setSelectedGroupId(null);
      setSelectedClipId(null);
      return;
    }
    if (!selectedGroupId || !filteredTakes.some((take) => take.group_id === selectedGroupId)) {
      setSelectedGroupId(filteredTakes[0].group_id);
    }
  }, [filteredTakes, model, selectedGroupId]);

  useEffect(() => {
    onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId);
  }, [selectedTake?.group_id, selectedClipId]);

  function selectTake(take: ReviewTakeGroup): void {
    setSelectedGroupId(take.group_id);
  }

  function selectRelative(delta: number): void {
    if (!filteredTakes.length) return;
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.min(filteredTakes.length - 1, Math.max(0, current + delta));
    selectTake(filteredTakes[nextIndex]);
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
          {FILTERS.map((option) => (
            <button
              type="button"
              className={filter === option.value ? "is-active" : ""}
              key={option.value}
              onClick={() => setFilter(option.value)}
              title={option.value === "attention" ? "只形成看片队列；问题仍回到所属工作区处理" : undefined}
            >
              {option.label} <span>{counts[option.value]}</span>
            </button>
          ))}
        </div>
        <div className="review-queue-summary" aria-label="审阅进度">
          <span><strong>{decidedCount}</strong> 已决定</span>
          <span>{filteredTakes.length} / {model.take_groups.length} Take</span>
        </div>
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
              detailForTake={queueDetail}
            />
          ) : <div className="phase-placeholder compact-placeholder">当前筛选没有 Take。</div>}
        </aside>

        <section className="review-viewer-pane" aria-label="看片与人工决定">
          {selectedTake ? (
            <div className="review-viewer-toolbar">
              <div className="review-transport-actions" aria-label="看片队列导航">
                <button type="button" className="secondary" disabled={selectedIndex <= 0} onClick={() => selectRelative(-1)}>上一个</button>
                <span>{selectedIndex >= 0 ? selectedIndex + 1 : 0} / {filteredTakes.length}</span>
                <button type="button" className="secondary" disabled={selectedIndex < 0 || selectedIndex >= filteredTakes.length - 1} onClick={() => selectRelative(1)}>下一个</button>
              </div>
              <div className="review-cross-actions" aria-label="继续处理当前 Take">
                <span className={`review-final-state state-${finalState(selectedTake)}`}>最终 {FINAL_LABELS[finalState(selectedTake)]}</span>
                <button type="button" className="secondary" onClick={() => onOpenMaterial?.(selectedTake.group_id, selectedClipId)}>在素材中打开</button>
                <button type="button" className="secondary" onClick={() => onOpenScript?.(selectedTake.group_id, selectedClipId)}>在剧本中打开</button>
                <button type="button" className="secondary" onClick={() => onOpenTimeline?.(selectedTake.group_id, selectedClipId)}>到时间线</button>
              </div>
            </div>
          ) : null}

          <TakeInspector
            connection={connection}
            projectId={project.project_id}
            take={selectedTake}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            writeSaving={false}
            afterPlayback={selectedTake ? (
              <div className="review-decision-stack">
                <ReviewDecisionPanel
                  baseUrl={baseUrl}
                  projectId={project.project_id}
                  groupId={selectedTake.group_id}
                  onDecisionChange={() => refresh().then(() => undefined)}
                />
                {selectedAttention?.hasAttention ? (
                  <section className="take-attention-summary" aria-label={`${takeDisplayLabel(selectedTake)} 需关注`}>
                    <div className="take-attention-heading"><strong>需关注</strong><span>{selectedAttention.labels.length} 项</span></div>
                    <div className="take-attention-labels">
                      {selectedAttention.labels.slice(0, 4).map((label) => <span key={label}>{label}</span>)}
                    </div>
                    {selectedAttention.context ? <p>{selectedAttention.context}</p> : null}
                  </section>
                ) : null}
              </div>
            ) : null}
          />
        </section>
      </main>
    </section>
  );
}
