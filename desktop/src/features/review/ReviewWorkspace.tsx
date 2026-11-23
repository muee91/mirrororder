import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectSummary,
  ReviewScriptBlock,
  ReviewTakeGroup,
} from "../../api/host";
import {
  ProductionClient,
  type SlateBoard,
  type SlateRecord,
} from "../../api/production";
import { mappingLabel, takeDisplayLabel } from "../material-script/TakeCard";
import { buildScriptTakeProjection } from "../material-script/model";
import { TakeInspector } from "../material-script/TakeInspector";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import { isPlaceableScriptBlock } from "../script/scriptSemantics";
import type { ProductionSelectionContext } from "../production/productionNavigation";
import { cameraPresentation } from "../media/cameraPresentation";
import { ReviewDecisionPanel } from "./ReviewDecisionPanel";
import { reviewTakeAttention } from "./reviewAttention";
import "../material-script/material-script.css";
import "./review-workspace.css";

type ReviewQueueFilter =
  | "all"
  | "unreviewed"
  | "attention"
  | "best"
  | "keep"
  | "reject";
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
  onOpenTeamReview?: () => void;
  showRoughCut?: boolean;
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
  const editorial = take.editorial_state.editorial_decision as
    | EditorialProjection
    | null
    | undefined;
  const state = String(
    editorial?.group?.state || editorial?.state || "unreviewed",
  );
  return state === "best" || state === "keep" || state === "reject"
    ? state
    : "unreviewed";
}

function slateStatusLabel(status?: string): string {
  return ({
    usable: "可用",
    partial: "部分可用",
    ng: "NG",
    unmarked: "未标",
  } as Record<string, string>)[status || ""] ?? "未标";
}

export function scriptBlockBadge(block: ReviewScriptBlock): string {
  return block.speaker || (
    block.type === "action" ? "动作" : block.type === "narration" ? "旁白" : "对白"
  );
}

function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${
    String(minutes).padStart(2, "0")
  }:${String(total % 60).padStart(2, "0")}`;
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${
      String(Math.floor(seconds % 60)).padStart(2, "0")
    }`
    : `${seconds.toFixed(1)}s`;
}

function slateCoordinates(record: SlateRecord | null): string {
  if (!record) return "无场记坐标";
  return [
    record.scene ? `${record.scene}场` : "",
    record.shot ? `${record.shot}镜` : "",
    record.take_number ? `${record.take_number}次` : "",
  ].filter(Boolean).join(" · ") || "已录入场记";
}

function takeSearchText(
  take: ReviewTakeGroup,
  slate: SlateRecord | null,
  scriptText: string,
): string {
  return [
    take.transcript.text,
    slate?.scene,
    slate?.shot,
    slate?.note,
    scriptText,
    ...take.angles.flatMap((angle) => [angle.name, angle.camera]),
  ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function reviewTakeLabel(
  take: ReviewTakeGroup,
  hasDuplicateTakeIndex: boolean,
  takeSequenceByGroupId: Map<string, number>,
): string {
  if (!hasDuplicateTakeIndex) return takeDisplayLabel(take);
  const sequence = takeSequenceByGroupId.get(take.group_id) ?? 1;
  const clipStem = take.angles[0]?.name?.replace(/\.[^.]+$/, "").trim();
  return clipStem ? `#${sequence} · ${clipStem}` : `#${sequence}`;
}

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
  onOpenTeamReview,
  showRoughCut = false,
}: Props) {
  const { connection, loadState, message, model, refresh } =
    useReviewModelSnapshot(baseUrl, project.project_id);
  const [slateBoard, setSlateBoard] = useState<SlateBoard | null>(null);
  const [filter, setFilter] = useState<ReviewQueueFilter>("all");
  const [query, setQuery] = useState("");
  const [episode, setEpisode] = useState<number | null>(null);
  const [hideNg, setHideNg] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [unmappedActive, setUnmappedActive] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    initialGroupId,
  );
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    initialClipId,
  );
  const [copyState, setCopyState] = useState("");
  const [masterCopyState, setMasterCopyState] = useState("");
  const appliedFocusKey = useRef("");
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void new ProductionClient(baseUrl).scriptSupervisor(project.project_id)
      .then((board) => {
        if (active) setSlateBoard(board);
      }).catch(() => {
        if (active) setSlateBoard(null);
      });
    return () => {
      active = false;
    };
  }, [baseUrl, project.project_id]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const slateByGroup = useMemo(() => {
    const next = new Map<string, SlateRecord>();
    const records = Object.values(slateBoard?.records ?? {}).sort((left, right) =>
      String(right.updated_at || "").localeCompare(String(left.updated_at || ""))
    );
    for (const record of records) {
      if (record.source_group_id && !next.has(record.source_group_id)) {
        next.set(record.source_group_id, record);
      }
    }
    if (model) {
      for (const take of model.take_groups) {
        if (next.has(take.group_id)) continue;
        const clipIds = new Set(take.angles.map((angle) => angle.clip_id).filter(Boolean));
        const matched = records.find((record) =>
          record.attachments.some((attachment) => clipIds.has(attachment.clip_id))
        );
        if (matched) next.set(take.group_id, matched);
      }
    }
    return next;
  }, [model, slateBoard]);

  const projection = useMemo(
    () => model ? buildScriptTakeProjection(model) : null,
    [model],
  );
  const scriptTextByTake = useMemo(() => {
    const next = new Map<string, string>();
    if (!model) return next;
    const blocks = new Map<string, ReviewScriptBlock>();
    for (const ep of model.episodes) {
      for (const scene of ep.scenes) {
        for (const block of scene.script_blocks) {
          blocks.set(block.segment_id, block);
        }
      }
    }
    for (const take of model.take_groups) {
      const ids = [
        ...take.effective_mapping.script_segment_ids,
        ...take.context.script_segment_ids,
        ...take.candidates.flatMap((candidate) =>
          candidate.script_segment_ids ?? [candidate.script_segment_id]
        ),
      ];
      next.set(
        take.group_id,
        ids.map((id) => blocks.get(id)).filter(Boolean).map((block) =>
          `${block?.speaker || ""} ${block?.text || ""}`
        ).join(" "),
      );
    }
    return next;
  }, [model]);

  const { counts, attentionTiers } = useMemo(() => {
    const next: Record<ReviewQueueFilter, number> = {
      all: 0,
      unreviewed: 0,
      attention: 0,
      best: 0,
      keep: 0,
      reject: 0,
    };
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
    if (!model) return [];
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const segmentTakeIds = activeSegmentId && projection
      ? new Set(projection.relatedTakeIds.get(activeSegmentId) ?? [])
      : null;
    return model.take_groups.filter((take) => {
      const record = slateByGroup.get(take.group_id) ?? null;
      if (filter === "attention" && !reviewTakeAttention(take).hasAttention) {
        return false;
      }
      if (
        filter !== "all" && filter !== "attention" &&
        finalState(take) !== filter
      ) return false;
      if (
        !needle &&
        episode !== null &&
        !take.effective_mapping.episode_ids.includes(episode) &&
        !take.context.episode_ids.includes(episode) &&
        !take.candidates.some((candidate) =>
          candidate.episode_ids.includes(episode) ||
          candidate.context_episodes.includes(episode)
        )
      ) return false;
      if (
        unmappedActive && take.effective_mapping.script_segment_ids.length > 0
      ) return false;
      if (segmentTakeIds && !segmentTakeIds.has(take.group_id)) return false;
      if (
        hideNg && (record?.status === "ng" || finalState(take) === "reject")
      ) return false;
      if (
        needle &&
        !takeSearchText(take, record, scriptTextByTake.get(take.group_id) || "")
          .includes(needle)
      ) return false;
      return true;
    }).sort((left, right) =>
      filter === "attention"
        ? reviewTakeAttention(right).priority -
          reviewTakeAttention(left).priority
        : 0
    );
  }, [
    activeSegmentId,
    episode,
    filter,
    hideNg,
    model,
    projection,
    query,
    scriptTextByTake,
    slateByGroup,
    unmappedActive,
  ]);

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ??
      null
    : null;
  const selectedSlateRecord = selectedTake
    ? slateByGroup.get(selectedTake.group_id) ?? null
    : null;
  const selectedIndex = selectedTake
    ? filteredTakes.findIndex((take) => take.group_id === selectedTake.group_id)
    : -1;
  const selectedAttention = selectedTake
    ? reviewTakeAttention(selectedTake)
    : null;
  const activeAngle = selectedTake?.angles.find((item) => item.clip_id === selectedClipId) ?? selectedTake?.angles[0] ?? null;
  const masterTimecode = timecode(activeAngle?.timeline_start ?? selectedTake?.start ?? 0);
  const decidedCount = counts.best + counts.keep + counts.reject;
  const hasScript = Boolean(model?.episodes.length);
  const { hasDuplicateTakeIndex, takeSequenceByGroupId } = useMemo(() => {
    const countsByIndex = new Map<number, number>();
    const sequenceByGroupId = new Map<string, number>();
    for (const [index, take] of (model?.take_groups ?? []).entries()) {
      sequenceByGroupId.set(take.group_id, index + 1);
      if (take.take_index > 0) countsByIndex.set(take.take_index, (countsByIndex.get(take.take_index) ?? 0) + 1);
    }
    return {
      hasDuplicateTakeIndex: [...countsByIndex.values()].some((count) => count >= 2),
      takeSequenceByGroupId: sequenceByGroupId,
    };
  }, [model]);

  useEffect(() => {
    if (!model) return;
    const focusKey = `${project.project_id}:${initialGroupId ?? ""}:${
      initialClipId ?? ""
    }`;
    const focused = initialGroupId && appliedFocusKey.current !== focusKey
      ? model.take_groups.find((take) => take.group_id === initialGroupId) ??
        null
      : null;
    if (focused) {
      setSelectedGroupId(focused.group_id);
      setSelectedClipId(
        initialClipId &&
          focused.angles.some((angle) => angle.clip_id === initialClipId)
          ? initialClipId
          : focused.angles[0]?.clip_id ?? null,
      );
      appliedFocusKey.current = focusKey;
      return;
    }
    setSelectedGroupId((current) =>
      current && model.take_groups.some((take) => take.group_id === current)
        ? current
        : model.take_groups[0]?.group_id ?? null
    );
  }, [initialClipId, initialGroupId, model, project.project_id]);

  useEffect(() => {
    if (!selectedTake) {
      setSelectedClipId(null);
      return;
    }
    if (
      !selectedClipId ||
      !selectedTake.angles.some((item) => item.clip_id === selectedClipId)
    ) setSelectedClipId(selectedTake.angles[0]?.clip_id ?? null);
  }, [selectedClipId, selectedTake]);

  useEffect(() => {
    if (!filteredTakes.length) {
      setSelectedGroupId(null);
      return;
    }
    if (
      !selectedGroupId ||
      !filteredTakes.some((take) => take.group_id === selectedGroupId)
    ) setSelectedGroupId(filteredTakes[0].group_id);
  }, [filteredTakes, selectedGroupId]);

  useEffect(() => {
    if (!model) return;
    onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId);
  }, [model, onSelectionChange, selectedClipId, selectedTake?.group_id]);

  function selectTake(take: ReviewTakeGroup, clipId?: string): void {
    setSelectedGroupId(take.group_id);
    if (clipId) setSelectedClipId(clipId);
  }

  function selectRelative(delta: number): void {
    if (!filteredTakes.length) return;
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    const next = filteredTakes[
      Math.min(filteredTakes.length - 1, Math.max(0, current + delta))
    ];
    if (next) selectTake(next);
  }

  function chooseScriptBlock(block: ReviewScriptBlock): void {
    setActiveSegmentId(block.segment_id);
    setUnmappedActive(false);
    const firstId = projection?.relatedTakeIds.get(block.segment_id)?.[0];
    const first = model?.take_groups.find((take) => take.group_id === firstId);
    if (first) selectTake(first);
  }

  async function copyFilename(): Promise<void> {
    const angle =
      selectedTake?.angles.find((item) => item.clip_id === selectedClipId) ??
        selectedTake?.angles[0];
    if (!angle) return;
    const value = `${angle.name} @ ${
      timecode(angle.playback.source_start ?? angle.source_start ?? 0)
    }`;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("已复制");
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyState(""), 1600);
    } catch {
      setCopyState("复制失败");
    }
  }

  async function copyMasterTimecode(): Promise<void> {
    if (!selectedTake) return;
    const value = masterTimecode;
    try {
      await navigator.clipboard.writeText(value);
      setMasterCopyState("已复制时码");
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setMasterCopyState(""), 1600);
    } catch {
      setCopyState("复制失败");
    }
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="review-workspace">
        <div
          className={`projection-status ${
            loadState === "error" ? "is-error" : ""
          }`}
        >
          {message}
        </div>
      </section>
    );
  }

  return (
    <section className="review-workspace">
      <header className="workspace-toolbar review-workspace-toolbar">
        <div className="review-finder-controls">
          <div className="review-search-wrap">
            <input
              className="review-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜台词、临场改词、场记备注或文件名…"
              aria-label="搜索审阅素材"
            />
            {query
              ? (
                <button
                  type="button"
                  className="review-search-clear"
                  aria-label="清除搜索"
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              )
              : null}
          </div>
          <div className="status-filter" aria-label="看片筛选">
            {FILTERS.filter((option) =>
              !["best", "keep", "reject"].includes(option.value) ||
              counts[option.value] > 0 || filter === option.value
            ).map((option) => {
              const watchOnlyAttention = option.value === "attention" &&
                attentionTiers.blocking === 0 && attentionTiers.stale === 0 &&
                counts.attention > 0;
              return (
                <button
                  type="button"
                  className={`${filter === option.value ? "is-active" : ""}${
                    watchOnlyAttention ? " is-watch-only" : ""
                  }`}
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  title={watchOnlyAttention
                    ? "当前无阻断错误；均为待关联剧本的常规提示"
                    : undefined}
                  aria-label={option.value === "attention"
                    ? `需关注 ${counts.attention}：阻断 ${attentionTiers.blocking} · 证据过期 ${attentionTiers.stale} · 待关注 ${attentionTiers.watch}`
                    : undefined}
                >
                  {option.label} <span>{counts[option.value]}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={`review-hide-ng${hideNg ? " is-active" : ""}`}
            aria-pressed={hideNg}
            onClick={() => setHideNg((value) => !value)}
          >
            隐藏 NG
          </button>
        </div>
        <div className="review-queue-summary" aria-label="审阅进度">
          {attentionTiers.blocking
            ? (
              <span className="needs-attention">
                <strong>{attentionTiers.blocking}</strong> 阻断
              </span>
            )
            : null}
          {attentionTiers.stale
            ? (
              <span>
                <strong>{attentionTiers.stale}</strong> 证据过期
              </span>
            )
            : null}
          <span>
            <strong>{decidedCount}</strong> 已决定
          </span>
          <span>{filteredTakes.length} / {model.take_groups.length} Take</span>
          {onOpenTeamReview
            ? (
              <button
                type="button"
                className="secondary review-team-button"
                onClick={onOpenTeamReview}
              >
                局域网共享
              </button>
            )
            : null}
        </div>
      </header>

      {hasScript
        ? (
          <nav className="review-episode-strip" aria-label="按集筛选">
            <button
              type="button"
              className={episode === null ? "is-active" : ""}
              onClick={() => setEpisode(null)}
            >
              全部集 <span>{model.take_groups.length}</span>
            </button>
            {model.episodes.map((item) => (
              <button
                type="button"
                key={item.episode}
                className={episode === item.episode ? "is-active" : ""}
                onClick={() => setEpisode(item.episode)}
              >
                第 {item.episode} 集{" "}
                <span>
                  {model.take_groups.filter((take) =>
                    take.effective_mapping.episode_ids.includes(item.episode) ||
                    take.context.episode_ids.includes(item.episode) ||
                    take.candidates.some((candidate) =>
                      candidate.episode_ids.includes(item.episode) ||
                      candidate.context_episodes.includes(item.episode)
                    )
                  ).length}
                </span>
              </button>
            ))}
          </nav>
        )
        : null}

      <main
        className={`review-primary-canvas${
          hasScript ? " has-script-rail" : ""
        }${!hasScript && !model.take_groups.length ? " is-empty" : ""}`}
      >
        {hasScript
          ? (
            <aside className="review-script-rail" aria-label="按剧本找素材">
              <div className="review-rail-heading">
                <h3>按剧本找素材</h3>
                {activeSegmentId || unmappedActive
                  ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setActiveSegmentId(null);
                        setUnmappedActive(false);
                      }}
                    >
                      全部 Take
                    </button>
                  )
                  : null}
              </div>
              {model.take_groups.some((take) =>
                  take.effective_mapping.script_segment_ids.length === 0
                )
                ? (
                  <button
                    type="button"
                    className={`review-unmapped-pill${
                      unmappedActive ? " is-active" : ""
                    }`}
                    onClick={() => {
                      setUnmappedActive(true);
                      setActiveSegmentId(null);
                    }}
                  >
                    未归集{" "}
                    <span>
                      {model.take_groups.filter((take) =>
                        take.effective_mapping.script_segment_ids.length === 0
                      ).length}
                    </span>
                  </button>
                )
                : null}
              <div className="review-script-outline">
                {model.episodes
                  .filter((ep) => query.trim() || episode === null || ep.episode === episode)
                  .map((ep) => (
                  <div className="review-script-episode" key={ep.episode}>
                    <p className="review-script-episode-title">
                      第 {ep.episode} 集
                    </p>
                    {ep.scenes.map((scene) => (
                      <section
                        className="review-script-scene"
                        key={scene.scene_id}
                      >
                        <h4>{scene.heading || "未命名场"}</h4>
                        {scene.script_blocks.filter(isPlaceableScriptBlock).map(
                          (block) => {
                            const matched = projection?.relatedTakeIds.get(
                              block.segment_id,
                            ) ?? [];
                            return (
                              <button
                                type="button"
                                className={`review-script-block${
                                  activeSegmentId === block.segment_id
                                    ? " is-active"
                                    : ""
                                }`}
                                key={block.segment_id}
                                onClick={() => chooseScriptBlock(block)}
                              >
                                <span className="review-script-block-copy">
                                  <strong>{scriptBlockBadge(block)}</strong>
                                  <span>
                                    {block.text || block.raw_text ||
                                      "（空白剧本段）"}
                                  </span>
                                </span>
                                <span className="review-script-count">
                                  {matched.length}
                                </span>
                              </button>
                            );
                          },
                        )}
                      </section>
                    ))}
                  </div>
                ))}
              </div>
            </aside>
          )
          : null}

        <section className="review-queue" aria-label="候选 Take 队列">
          <div className="review-queue-heading">
            <h3>{query.trim() ? "跨集搜索结果" : "候选条次"}</h3>
            <span>{filteredTakes.length} 条</span>
          </div>
          {filteredTakes.length
            ? (
              <div className="review-take-card-list">
                {filteredTakes.map((take) => {
                  const record = slateByGroup.get(take.group_id) ?? null;
                  const state = finalState(take);
                  const dimmed = record?.status === "ng" || state === "reject";
                  return (
                    <article
                      className={`review-take-card${
                        selectedGroupId === take.group_id ? " is-selected" : ""
                      }${dimmed ? " is-ng" : ""}`}
                      key={take.group_id}
                      onClick={() => selectTake(take)}
                    >
                      <header className="review-take-card-heading">
                        <div>
                          <strong>{reviewTakeLabel(take, hasDuplicateTakeIndex, takeSequenceByGroupId)}</strong>
                          <span>{slateCoordinates(record)} · 母版 {timecode(take.angles[0]?.timeline_start ?? take.start)}</span>
                        </div>
                        <div className="review-take-badges">
                          <span
                            className={`review-slate-status status-${
                              record?.status || "unmarked"
                            }`}
                          >
                            {slateStatusLabel(record?.status)}
                          </span>
                          <span className={`review-final-state state-${state}`}>
                            {FINAL_LABELS[state]}
                          </span>
                        </div>
                      </header>
                      <div className="review-take-camera-chips">
                        {take.angles.map((angle) => {
                          const camera = cameraPresentation(angle.camera);
                          return (
                            <button
                              type="button"
                              className={`review-take-camera-chip${
                                selectedClipId === angle.clip_id &&
                                  selectedGroupId === take.group_id
                                  ? " is-active"
                                  : ""
                              }`}
                              data-camera-tone={camera.tone}
                              key={angle.clip_id}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectTake(take, angle.clip_id);
                              }}
                            >
                              <strong>{camera.label}</strong>
                              <span title={angle.name}>{angle.name}</span>
                              <small>{duration(angle.duration)}</small>
                            </button>
                          );
                        })}
                      </div>
                      <p className="review-take-dialogue">
                        {take.transcript.text || record?.note ||
                          "暂无对白或场记备注"}
                      </p>
                      <small className="review-take-mapping">
                        {mappingLabel(take)}
                      </small>
                    </article>
                  );
                })}
              </div>
            )
            : (
              <div className="review-empty-state" role="status">
                <strong>
                  {model.take_groups.length
                    ? "当前筛选没有 Take"
                    : "当前项目没有 Take"}
                </strong>
                <p>
                  {model.take_groups.length
                    ? "换一个筛选条件即可继续看片。"
                    : "完成素材分析并建立 Take 后，这里会出现看片队列。"}
                </p>
                {model.take_groups.length &&
                    (filter !== "all" || query.trim() || activeSegmentId ||
                      unmappedActive || hideNg || episode !== null)
                  ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setFilter("all");
                        setQuery("");
                        setActiveSegmentId(null);
                        setUnmappedActive(false);
                        setHideNg(false);
                        setEpisode(null);
                      }}
                    >
                      显示全部
                    </button>
                  )
                  : null}
              </div>
            )}
        </section>

        <section className="review-viewer-pane" aria-label="看片与人工决定">
          {selectedTake
            ? (
              <div className="review-viewer-toolbar">
                <div className="review-transport-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={selectedIndex <= 0}
                    onClick={() => selectRelative(-1)}
                  >
                    上一个
                  </button>
                  <span>
                    {selectedIndex >= 0 ? selectedIndex + 1 : 0} /{" "}
                    {filteredTakes.length}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={selectedIndex < 0 ||
                      selectedIndex >= filteredTakes.length - 1}
                    onClick={() => selectRelative(1)}
                  >
                    下一个
                  </button>
                </div>
                <div className="review-cross-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copyFilename()}
                  >
                    {copyState || "复制文件名"}
                  </button>
                  <button
                    type="button"
                    className="secondary review-master-timecode"
                    onClick={() => void copyMasterTimecode()}
                  >
                    {masterCopyState || `母版 ${masterTimecode}`}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      onOpenMaterial?.(selectedTake.group_id, selectedClipId)}
                  >
                    定位素材
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      onOpenScript?.(selectedTake.group_id, selectedClipId)}
                  >
                    校准剧本
                  </button>
                  {showRoughCut
                    ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          onOpenTimeline?.(
                            selectedTake.group_id,
                            selectedClipId,
                          )}
                      >
                        到时间线
                      </button>
                    )
                    : null}
                </div>
              </div>
            )
            : null}
          <TakeInspector
            connection={connection}
            projectId={project.project_id}
            take={selectedTake}
            selectedClipId={selectedClipId}
            playbackFocus={playbackFocus}
            onSelectClip={setSelectedClipId}
            writeSaving={false}
            hideHeader
            afterPlayback={selectedTake
              ? (
                <div className="review-decision-stack">
                  <ReviewDecisionPanel
                    baseUrl={baseUrl}
                    projectId={project.project_id}
                    groupId={selectedTake.group_id}
                    onDecisionChange={async () => { await refresh().catch(() => { /* The decision write succeeded. A read-back failure keeps the panel stable. */ }); }}
                  />
                  {selectedSlateRecord
                    ? (
                      <div
                        className="review-slate-bridge"
                        aria-label="现场场记参考"
                      >
                        <strong>现场场记参考</strong>
                        <span
                          data-slate-status={selectedSlateRecord.status ||
                            "unmarked"}
                        >
                          {slateStatusLabel(selectedSlateRecord.status)}
                        </span>
                        <small>
                          {[
                            selectedSlateRecord.episode
                              ? `第 ${selectedSlateRecord.episode} 集`
                              : "",
                            slateCoordinates(selectedSlateRecord),
                            selectedSlateRecord.note || "",
                          ].filter(Boolean).join(" · ")}
                        </small>
                      </div>
                    )
                    : null}
                  {selectedAttention?.hasAttention
                    ? selectedAttention.tier === "watch"
                      ? (
                        <details className="take-attention-summary">
                          <summary>
                            <strong>需关注</strong>
                            <span>{selectedAttention.labels.length} 项</span>
                          </summary>
                          <div className="take-attention-labels">
                            {selectedAttention.labels.slice(0, 4).map((
                              label,
                            ) => <span key={label}>{label}</span>)}
                          </div>
                          {selectedAttention.context
                            ? <p>{selectedAttention.context}</p>
                            : null}
                        </details>
                      )
                      : (
                        <section
                          className="take-attention-summary"
                          aria-label={`${
                            reviewTakeLabel(selectedTake, hasDuplicateTakeIndex, takeSequenceByGroupId)
                          } 需关注`}
                        >
                          <div className="take-attention-heading">
                            <strong>需关注</strong>
                            <span>{selectedAttention.labels.length} 项</span>
                          </div>
                          <div className="take-attention-labels">
                            {selectedAttention.labels.slice(0, 4).map((
                              label,
                            ) => <span key={label}>{label}</span>)}
                          </div>
                          {selectedAttention.context
                            ? <p>{selectedAttention.context}</p>
                            : null}
                        </section>
                      )
                    : null}
                </div>
              )
              : null}
          />
        </section>
      </main>
    </section>
  );
}
