import type { ReviewEpisode, ReviewModelPayload, ReviewScriptBlock } from "../../api/host";
import { relatedTakeIds } from "./model";
import { ScriptBlock } from "./ScriptBlock";

export { dragGroupId, scriptDomId } from "./ScriptBlock";

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
            <h3>{scene.heading || "未命名场"}</h3>
            <span className="count-pill">{scene.take_group_ids.length} Take</span>
          </header>
          <div className="script-block-list">
            {scene.script_blocks.map((block) => (
              <ScriptBlock
                key={block.segment_id}
                block={block}
                linkedTakeIds={relatedTakeIds(model, block.segment_id)}
                selected={selectedSegmentId === block.segment_id}
                draggingGroupId={draggingGroupId}
                placementGroupId={placementGroupId}
                onShowTake={onShowTake}
                onDropPlacement={onDropPlacement}
                onClickPlacement={onClickPlacement}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
