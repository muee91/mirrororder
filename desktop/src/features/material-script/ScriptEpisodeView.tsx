import type { ReviewEpisode, ReviewModelPayload, ReviewScriptBlock } from "../../api/host";
import { candidateTakeIds, mappedTakeIds } from "./model";
import { ScriptBlock, type ScriptProjectionMode } from "./ScriptBlock";

export { dragGroupId, scriptDomId } from "./ScriptBlock";

export function ScriptEpisodeView({
  episode,
  model,
  selectedSegmentId,
  projectionMode,
  draggingGroupId,
  placementGroupId,
  onSelectBlock,
  onOpenContext,
  onShowTake,
  onDropPlacement,
  onClickPlacement,
}: {
  episode: ReviewEpisode;
  model: ReviewModelPayload;
  selectedSegmentId: string | null;
  projectionMode: ScriptProjectionMode;
  draggingGroupId: string | null;
  placementGroupId: string | null;
  onSelectBlock: (block: ReviewScriptBlock) => void;
  onOpenContext: (block: ReviewScriptBlock) => void;
  onShowTake: (groupId: string) => void;
  onDropPlacement: (groupId: string, block: ReviewScriptBlock) => void;
  onClickPlacement: (block: ReviewScriptBlock) => void;
}) {
  return (
    <div className="script-episode">
      {episode.scenes.map((scene) => {
        const placeable = scene.script_blocks.filter((block) => block.type !== "scene_heading");
        const mappedBlocks = placeable.filter((block) => mappedTakeIds(model, block.segment_id).length > 0).length;
        return (
          <section className="script-scene" key={scene.scene_id}>
            <header>
              <div>
                <h3>{scene.heading || "未命名场"}</h3>
                {projectionMode !== "script" ? <small>{mappedBlocks}/{placeable.length} 剧本段已有人工/有效归集</small> : null}
              </div>
              <span className="count-pill">{projectionMode === "script" ? `${scene.take_group_ids.length} Take` : `${mappedBlocks}/${placeable.length} 已归集`}</span>
            </header>
            <div className="script-block-list">
              {scene.script_blocks.map((block) => (
                <ScriptBlock
                  key={block.segment_id}
                  block={block}
                  mappedTakeIds={mappedTakeIds(model, block.segment_id)}
                  candidateTakeIds={candidateTakeIds(model, block.segment_id)}
                  selected={selectedSegmentId === block.segment_id}
                  projectionMode={projectionMode}
                  draggingGroupId={draggingGroupId}
                  placementGroupId={placementGroupId}
                  onSelect={onSelectBlock}
                  onOpenContext={onOpenContext}
                  onShowTake={onShowTake}
                  onDropPlacement={onDropPlacement}
                  onClickPlacement={onClickPlacement}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
