import type { DragEvent, KeyboardEvent } from "react";
import type { ReviewScriptBlock } from "../../api/host";
import { isPlaceableScriptBlock } from "../script/scriptSemantics";
import { DRAG_TAKE_MIME } from "./TakeCard";
import { actionCoverageLabel } from "./actionDialogue";
import "./script-block.css";

export type ScriptProjectionMode = "script" | "coverage" | "issues";

export function scriptDomId(segmentId: string): string {
  return `script-segment-${encodeURIComponent(segmentId)}`;
}

export function dragGroupId(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(DRAG_TAKE_MIME) || event.dataTransfer.getData("text/plain");
}

interface ScriptBlockProps {
  block: ReviewScriptBlock;
  mappedTakeIds: string[];
  candidateTakeIds: string[];
  adjacentTakeIds?: ReadonlyMap<string, readonly ReviewScriptBlock[]>;
  confirmedActionCount?: number;
  selected: boolean;
  projectionMode: ScriptProjectionMode;
  draggingGroupId: string | null;
  placementGroupId: string | null;
  onSelect: (block: ReviewScriptBlock) => void;
  onOpenContext: (block: ReviewScriptBlock) => void;
  onShowTake: (groupId: string) => void;
  onDropPlacement: (groupId: string, block: ReviewScriptBlock) => void;
  onClickPlacement: (block: ReviewScriptBlock) => void;
}

const BLOCK_TYPE_LABELS: Record<string, string> = {
  action: "动作",
  dialogue: "对白",
  scene_heading: "场头",
  transition: "转场",
  parenthetical: "旁注",
  character: "人物",
};

export function scriptBlockTypeLabel(block: ReviewScriptBlock): string {
  return BLOCK_TYPE_LABELS[block.type] || block.type || "剧本";
}

export function ScriptBlock({
  block,
  mappedTakeIds,
  candidateTakeIds,
  adjacentTakeIds,
  confirmedActionCount,
  selected,
  projectionMode,
  draggingGroupId,
  placementGroupId,
  onSelect,
  onOpenContext,
  onShowTake,
  onDropPlacement,
  onClickPlacement,
}: ScriptBlockProps) {
  const canPlace = isPlaceableScriptBlock(block);
  const relatedTakeIds = new Set([...mappedTakeIds, ...candidateTakeIds, ...(adjacentTakeIds?.keys() ?? [])]);
  const actionStatus = block.type === "action" && confirmedActionCount !== undefined && relatedTakeIds.size > 0
    ? actionCoverageLabel(confirmedActionCount, adjacentTakeIds?.size ?? 0, relatedTakeIds.size) : null;
  const showCoverage = canPlace && (projectionMode !== "script" || selected || relatedTakeIds.size > 0);

  function selectFromKeyboard(event: KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(block);
  }

  return (
    <article
      className={`script-block block-${block.type || "unknown"} ${selected ? "is-selected" : ""} ${draggingGroupId && canPlace ? "is-drop-target" : ""} ${mappedTakeIds.length ? "has-mapped-takes" : canPlace ? "is-unmapped" : ""}`}
      id={scriptDomId(block.segment_id)}
      data-script-projection={projectionMode}
      tabIndex={canPlace ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        onSelect(block);
      }}
      onKeyDown={canPlace ? selectFromKeyboard : undefined}
      onDragOver={canPlace ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      } : undefined}
      onDrop={canPlace ? (event) => {
        event.preventDefault();
        const groupId = dragGroupId(event);
        if (groupId) {
          onSelect(block);
          onDropPlacement(groupId, block);
        }
      } : undefined}
    >
      <div className="script-block-meta">
        <span>{block.speaker || scriptBlockTypeLabel(block)}</span>
        <div className="script-block-actions">
          {showCoverage ? (
            <div className="script-block-coverage" aria-label="当前剧本段素材状态">
              {actionStatus
                ? <span className={confirmedActionCount ? "is-mapped" : "has-candidate"}>{actionStatus}</span>
                : <>{mappedTakeIds.length ? <span className="is-mapped">已归集 {mappedTakeIds.length}</span> : <span className="is-unmapped">未归集</span>}
                  {candidateTakeIds.length ? <span className="has-candidate">候选 {candidateTakeIds.length}</span> : null}</>}
            </div>
          ) : null}
          {!canPlace && block.type !== "scene_heading" ? <span className="script-block-structural-status">无需归集</span> : null}
          {placementGroupId && selected && canPlace ? (
            <button type="button" className="place-current" onClick={() => onClickPlacement(block)}>
              归集当前 Take
            </button>
          ) : null}
          {canPlace ? (
            <button type="button" onClick={() => onOpenContext(block)}>
              {relatedTakeIds.size ? `素材 ${relatedTakeIds.size}` : "找素材"}
            </button>
          ) : null}
          {mappedTakeIds.length > 0 ? (
            <button type="button" className="script-open-mapped-take" onClick={() => onShowTake(mappedTakeIds[0])}>看 Take</button>
          ) : null}
        </div>
      </div>
      <p>{block.raw_text || block.text || "—"}</p>
      {draggingGroupId && canPlace ? <span className="drop-hint">放下：精确归集到此剧本段</span> : null}
      {canPlace && block.issues.length > 0 && (projectionMode !== "script" || block.issues.some((issue) => issue.severity === "error")) ? (
        <div className="issue-row">
          {block.issues.map((issue) => (
            projectionMode === "script" && issue.severity !== "error" ? null : (
              <span className={`issue-chip issue-${issue.severity}`} key={`${block.segment_id}-${issue.code}`}>
                {issue.label}
              </span>
            )
          ))}
        </div>
      ) : null}
    </article>
  );
}
