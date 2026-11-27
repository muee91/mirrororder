import { useLayoutEffect, useMemo, useRef } from "react";
import type { ReviewEpisode, ReviewScriptBlock } from "../../api/host";
import { StudioIcon } from "../../components/StudioIcons";
import type { ScriptTakeProjection } from "../material-script/model";
import { actionCoverageLabel } from "../material-script/actionDialogue";
import { isPlaceableScriptBlock } from "../script/scriptSemantics";

interface Props {
  episodes: ReviewEpisode[];
  projection: ScriptTakeProjection;
  selected?: ReviewScriptBlock;
  episode: number | null;
  query: string;
  onlyMissing: boolean;
  onEpisode: (episode: number) => void;
  onQuery: (query: string) => void;
  onMissing: (onlyMissing: boolean) => void;
  onChoose: (block: ReviewScriptBlock) => void;
}

export function ReviewScriptOutline({ episodes, projection, selected, episode, query, onlyMissing,
  onEpisode, onQuery, onMissing, onChoose }: Props) {
  const currentLine = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { currentLine.current?.scrollIntoView?.({ block: "nearest" }); }, [selected?.segment_id, episode, query, onlyMissing]);
  const needle = query.trim().toLocaleLowerCase();
  const catalog = useMemo(() => episodes.map((entry) => ({
    episode: entry.episode,
    scenes: entry.scenes.map((scene) => ({
      ...scene,
      blocks: scene.script_blocks.filter(isPlaceableScriptBlock).map((block) => {
        const id = block.segment_id;
        const mapped = projection.mappedTakeIds.get(id)?.length ?? 0;
        const candidates = projection.candidateTakeIds.get(id)?.length ?? 0;
        const related = projection.relatedTakeIds.get(id)?.length ?? 0;
        const adjacent = projection.dialogueByActionTake.get(id)?.size ?? 0;
        const confirmed = projection.confirmedActionTakeIds.get(id)?.length ?? 0;
        return { block, mapped, candidates, related, adjacent, confirmed };
      }),
    })).filter((scene) => scene.blocks.length),
  })).filter((entry) => entry.scenes.length), [episodes, projection]);
  const current = catalog.find((entry) => entry.episode === (episode ?? selected?.episode)) ?? catalog[0];
  const visible = (needle ? catalog : current ? [current] : []).flatMap((entry) => {
    const scenes = entry.scenes.map((scene) => ({
      ...scene,
      blocks: scene.blocks.filter(({ block }) => !needle || [block.speaker, block.text, block.raw_text, scene.heading]
        .some((part) => part?.toLocaleLowerCase().includes(needle))),
    })).filter((scene) => scene.blocks.length);
    return scenes.length ? [{ ...entry, scenes }] : [];
  });
  const blocks = visible.flatMap((entry) => entry.scenes.flatMap((scene) => scene.blocks));
  const covered = blocks.filter((row) => row.mapped > 0).length;
  const missing = blocks.filter((row) => !row.related).length;
  const count = onlyMissing ? missing : blocks.length;
  return (
    <aside className="review-outline-panel" aria-label="剧本逐段核对">
      <header className="review-outline-tools">
        <div className="review-outline-title"><h2>剧本</h2>
          <select className="mo-select" aria-label="浏览剧本集数" value={current?.episode ?? ""} disabled={Boolean(needle)}
            onChange={(event) => onEpisode(Number(event.target.value))}>
            {catalog.map((entry) => <option key={entry.episode} value={entry.episode}>第 {entry.episode} 集</option>)}
          </select>
        </div>
        <label className="review-outline-search"><StudioIcon name="search" size={15} />
          <input type="search" aria-label="搜索全剧原句或角色" placeholder="全剧搜索原句或角色" value={query}
            onChange={(event) => onQuery(event.target.value)} />
        </label>
        <div className="review-outline-coverage">
          <span>{needle ? "搜索结果" : "本集"} {covered} / {blocks.length} 段有归属</span>
          <button type="button" aria-pressed={onlyMissing} onClick={() => onMissing(!onlyMissing)}>
            待找素材 {missing}
          </button>
        </div>
      </header>
      <div className="review-outline-pages">
        {visible.map((entry) => entry.scenes.map((scene) => {
          const rows = onlyMissing ? scene.blocks.filter((row) => !row.related) : scene.blocks;
          if (!rows.length) return null;
          return <section key={entry.episode + "/" + scene.scene_id} className="review-outline-scene">
            <h3>{needle && <span>第 {entry.episode} 集 · </span>}{scene.heading || scene.scene_id}</h3>
            {rows.map(({ block, mapped, candidates, related, adjacent, confirmed }) => <button className="review-outline-line" type="button"
              key={block.segment_id} data-kind={block.type} ref={selected?.segment_id === block.segment_id ? currentLine : undefined} aria-pressed={selected?.segment_id === block.segment_id} onClick={() => onChoose(block)}>
              <span className="review-outline-byline"><strong>{block.speaker || (block.type === "action" ? "动作" : block.type === "narration" ? "旁白" : "对白")}</strong>
                <span className="review-outline-state" data-state={(block.type === "action" ? confirmed : mapped) ? "mapped" : related ? "candidate" : "missing"}>
                  {block.type === "action" && related ? actionCoverageLabel(confirmed, adjacent, related)
                    : mapped ? mapped + " 组有归属" : candidates ? candidates + " 组候选" : related ? related + " 组线索" : "待找素材"}
                </span>
              </span>
              <span className="review-outline-text">{block.text || block.raw_text || "（空白剧本段）"}</span>
            </button>)}
          </section>;
        }))}
        {!count && <p role="status" className="review-outline-empty">{onlyMissing && blocks.length ? "这些剧本段都已有相关素材或候选。" : "没有找到对应的剧本段。"}
          {onlyMissing && <button type="button" className="secondary" onClick={() => onMissing(false)}>显示全部段落</button>}
          {needle && <button type="button" className="secondary" onClick={() => onQuery("")}>清除剧本搜索</button>}
        </p>}
      </div>
    </aside>
  );
}
