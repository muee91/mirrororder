import type { DragEvent } from "react";
import type { ReviewEpisode, ReviewModelPayload, ReviewScriptBlock } from "../../api/host";
import { relatedTakeIds } from "./model";
import { DRAG_TAKE_MIME } from "./VirtualTakeList";

export function scriptDomId(segmentId: string): string {
  return `script-segment-${encodeURIComponent(segmentId)}`;
}

export function dragGroupId(event: DragEvent<HTMLElement>): string {
  return event.dataTransfer.getData(DRAG_TAKE_MIME) || event.dataTransfer.getData("text/plain");
}

export function ScriptEpisodeView({
  episode,
  model,
  selectedSegmentId,
  draggingGroupId,
  placementGroupId,
  onShowTake,
  onDropPlacement,
  onClickPlacement,
}: {
  episode: ReviewEpisode;
  model: ReviewModelPayload;
  selectedSegmentId: string | null;
  draggingGroupId: string | null;
  placementGroupId: string | null;
  onShowTake: (groupId: string) => void;
  onDropPlacement: (groupId: string, block: ReviewScriptBlock) => void;
  onClickPlacement: (block: ReviewScriptBlock) => void;
}) {
  return (
    <div className="script-episode">
      {episode.scenes.map((scene) => (
        <section className="script-scene" key={scene.scene_id}>
          <header>
            <div>
              <p className="eyebrow">{scene.scene_id}</p>
              <h3>{scene.heading || "未命名场"}</h3>
            </div>
            <span className="count-pill">{scene.take_group_ids.length} Take</span>
          </header>
          <div className="script-block-list">
            {scene.script_blocks.map((block) => {
              const linked = relatedTakeIds(model, block.segment_id);
              const canPlace = block.type !== "scene_heading";
              return (
                <article
                  className={`script-block block-${block.type || "unknown"} ${selectedSegmentId === block.segment_id ? "is-selected" : ""} ${draggingGroupId && canPlace ? "is-drop-target" : ""}`}
                  id={scriptDomId(block.segment_id)}
                  key={block.segment_id}
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
                      {linked.length > 0 ? (
                        <button type="button" onClick={() => onShowTake(linked[0])}>素材 {linked.length}</button>
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
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
