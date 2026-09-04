import type { DragEvent } from "react";
import type { ReviewScriptBlock } from "../../api/host";
import { DRAG_TAKE_MIME } from "./TakeCard";

export function scriptDomId(segmentId: string): string {
  return `script-segment-${encodeURIComponent(segmentId)}`;
}

export function dragGroupId(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(DRAG_TAKE_MIME) || event.dataTransfer.getData("text/plain");
}

interface ScriptBlockProps {
  block: ReviewScriptBlock;
  linkedTakeIds: string[];
  selected: boolean;
  draggingGroupId: string | null;
  placementGroupId: string | null;
  onShowTake: (groupId: string) => void;
  onDropPlacement: (groupId: string, block: ReviewScriptBlock) => void;
  onClickPlacement: (block: ReviewScriptBlock) => void;
}

export function ScriptBlock({
  block,
  linkedTakeIds,
  selected,
  draggingGroupId,
  placementGroupId,
  onShowTake,
  onDropPlacement,
  onClickPlacement,
}: ScriptBlockProps) {
  const canPlace = block.type !== "scene_heading";

  return (
    <article
      className={`script-block block-${block.type || "unknown"} ${selected ? "is-selected" : ""} ${draggingGroupId && canPlace ? "is-drop-target" : ""}`}
      id={scriptDomId(block.segment_id)}
      onDragOver={canPlace ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      } : undefined}
      onDrop={canPlace ? (event) => {
        event.preventDefault();
        const groupId = dragGroupId(event);
        if (groupId) onDropPlacement(groupId, block);
      } : undefined}
    >
      <div className="script-block-meta">
        <span>{block.speaker || block.type || "剧本"}</span>
        <div className="script-block-actions">
          {placementGroupId && canPlace ? (
            <button type="button" className="place-current" onClick={() => onClickPlacement(block)}>
              归集 {placementGroupId}
            </button>
          ) : null}
          {linkedTakeIds.length > 0 ? (
            <button type="button" onClick={() => onShowTake(linkedTakeIds[0])}>素材 {linkedTakeIds.length}</button>
          ) : null}
          <code>{block.segment_id}</code>
        </div>
      </div>
      <p>{block.raw_text || block.text || "—"}</p>
      {draggingGroupId && canPlace ? <span className="drop-hint">放下：精确归集到此剧本段</span> : null}
      {block.issues.length > 0 ? (
        <div className="issue-row">
          {block.issues.map((issue) => (
            <span className={`issue-chip issue-${issue.severity}`} key={`${block.segment_id}-${issue.code}`}>
              {issue.label}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
