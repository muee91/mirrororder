import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, ReviewTakeGroup } from "../../api/host";
import { ProductionClient, type SlateBoard, type SlateRecord } from "../../api/production";
import { mappingLabel, takeDisplayLabel } from "../material-script/TakeCard";
import { TakeInspector } from "../material-script/TakeInspector";
import { VirtualTakeList } from "../material-script/VirtualTakeList";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import type { ProductionSelectionContext } from "../production/productionNavigation";
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
  playbackFocus?: ProductionSelectionContext;
  onSelectionChange?: (groupId: string | null, clipId: string | null) => void;
  onOpenMaterial?: (groupId: string, clipId?: string | null) => void;
  onOpenScript?: (groupId: string, clipId?: string | null) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null) => void;
}

const FILTERS: Array<{ value: ReviewQueueFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unreviewed", label: "未决定" },
  { value: "attention", label: "需关注" },
  { value: "best", label: "首选" },
  { value: "keep", label: "保留" },
  { value: "reject", label: "废弃" },
];

const FINAL_LABELS: Record<ReviewFinalState, string> = {
  unreviewed: "未决定",
  best: "首选",
  keep: "保留",
  reject: "废弃",
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

const SLATE_STATUS_LABELS: Record<string, string> = {
  usable: "可用",
  partial: "部分可用",
  ng: "NG",
  unmarked: "未标",
};

export function ReviewWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  initialClipId = null,
  playbackFocus,
  onSelectionChange,
  onOpenMaterial,
  onOpenScript,
  onOpenTimeline,
}: Props) {
  const { connection, loadState, message, model, refresh } = useReviewModelSnapshot(baseUrl, project.project_id);
  const [slateBoard, setSlateBoard] = useState<SlateBoard | null>(null);
  const [filter, setFilter] = useState<ReviewQueueFilter>("all");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(initialClipId);
  const appliedFocusKey = useRef("");

  useEffect(() => {
    let active = true;
    void new ProductionClient(baseUrl)
      .scriptSupervisor(project.project_id)
      .then((board) => { if (active) setSlateBoard(board); })
      .catch(() => { if (active) setSlateBoard(null); });
    return () => { active = false; };
  }, [baseUrl, project.project_id]);

  const { counts, attentionTiers } = useMemo(() => {
    const next: Record<ReviewQueueFilter, number> = { all: 0, unreviewed: 0, attention: 0, best: 0, keep: 0, reject: 0 };
    const tiers = { blocking: 0, stale: 0, watch: 0 };
    for (const take of model?.take_groups ?? []) {
      next.all += 1;
      next[finalState(take)] += 1;
      const attention = reviewTakeAttention(take);
      if (attention.hasAttention) {
        next.attention += 1;
        tiers[attention.tier] += 1;
      }
    }
    return { counts: next, attentionTiers: tiers };
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
  const selectedSlateRecord: SlateRecord | null = useMemo(() => {
    if (!selectedTake || !slateBoard?.records) return null;
    const matches = Object.values(slateBoard.records).filter((item) => item.source_group_id === selectedTake.group_id);
    if (!matches.length) return null;
    return matches.sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))[0] ?? null;
  }, [selectedTake, slateBoard]);
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
    if (!model) return;
    if (!selectedTake) {
      setSelectedClipId(null);
      return;
    }
    if (!selectedClipId || !selectedTake.angles.some((angle) => angle.clip_id === selectedClipId)) {
      setSelectedClipId(selectedTake.angles[0]?.clip_id ?? null);
    }
  }, [model, selectedClipId, selectedTake]);

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
    if (!model) return;
    onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId);
  }, [model, selectedTake?.group_id, selectedClipId]);

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
          {FILTERS
            .filter((option) => !["best", "keep", "reject"].includes(option.value) || counts[option.value] > 0 || filter === option.value)
            .map((option) => {
              const watchOnlyAttention = option.value === "attention"
                && attentionTiers.blocking === 0
                && attentionTiers.stale === 0
                && counts.attention > 0;
              return (
                <button
                  type="button"
                  className={`${filter === option.value ? "is-active" : ""}${watchOnlyAttention ? " is-watch-only" : ""}`}
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  title={watchOnlyAttention
                    ? "当前无阻断错误；均为待关联剧本的常规提示"
                    : option.value === "attention" ? "只形成看片队列；问题仍回到所属工作区处理" : undefined}
                  aria-label={option.value === "attention" ? `需关注 ${counts.attention}：阻断 ${attentionTiers.blocking} · 证据过期 ${attentionTiers.stale} · 待关注 ${attentionTiers.watch}` : undefined}
                >
                  {option.label} <span>{counts[option.value]}</span>
                </button>
              );
            })}
        </div>
        <div className="review-queue-summary" aria-label="审阅进度">
          {attentionTiers.blocking ? <span className="needs-attention"><strong>{attentionTiers.blocking}</strong> 阻断</span> : null}
          {attentionTiers.stale ? <span><strong>{attentionTiers.stale}</strong> 证据过期</span> : null}
          <span><strong>{decidedCount}</strong> 已决定</span>
          <span>{filteredTakes.length} / {model.take_groups.length} Take</span>
        </div>
      </header>

      <main className={`review-primary-canvas${filteredTakes.length ? "" : " is-empty"}`}>
        {filteredTakes.length ? (
          <>
            <aside className="review-queue" aria-label="看片队列">
              <VirtualTakeList
                variant="compact"
                takes={filteredTakes}
                selectedGroupId={selectedGroupId}
                onSelect={selectTake}
                allowDrag={false}
                detailForTake={queueDetail}
              />
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
                playbackFocus={playbackFocus}
                onSelectClip={setSelectedClipId}
                writeSaving={false}
                afterPlayback={selectedTake ? (
                  <div className="review-decision-stack">
                    {selectedSlateRecord ? (
                      <div className="review-slate-bridge" aria-label="现场场记参考">
                        <strong>现场场记参考</strong>
                        <span data-slate-status={selectedSlateRecord.status || "unmarked"}>
                          {SLATE_STATUS_LABELS[selectedSlateRecord.status] ?? selectedSlateRecord.status}
                        </span>
                        <small>
                          {[
                            selectedSlateRecord.episode ? `第 ${selectedSlateRecord.episode} 集` : "",
                            selectedSlateRecord.scene ? `${selectedSlateRecord.scene} 场` : "",
                            selectedSlateRecord.shot ? `${selectedSlateRecord.shot} 镜` : "",
                            selectedSlateRecord.take_number ? `${selectedSlateRecord.take_number} 次` : "",
                            selectedSlateRecord.note ? selectedSlateRecord.note : "",
                          ].filter(Boolean).join(" · ") || "已录入场记"}
                        </small>
                      </div>
                    ) : null}
                    <ReviewDecisionPanel
                      baseUrl={baseUrl}
                      projectId={project.project_id}
                      groupId={selectedTake.group_id}
                      onDecisionChange={async () => {
                        await refresh().catch(() => {
                          // The decision write already succeeded. The panel owns
                          // the write result; a read-back failure must not create
                          // an unhandled rejection or roll the UI back to stale data.
                        });
                      }}
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
          </>
        ) : (
          <div className="review-empty-state" role="status">
            <strong>{model.take_groups.length ? "当前筛选没有 Take" : "当前项目没有 Take"}</strong>
            <p>{model.take_groups.length ? "换一个筛选条件即可继续看片。" : "完成素材分析并建立 Take 后，这里会出现看片队列。"}</p>
            {model.take_groups.length && filter !== "all" ? <button type="button" className="secondary" onClick={() => setFilter("all")}>显示全部</button> : null}
          </div>
        )}
      </main>
    </section>
  );
}
