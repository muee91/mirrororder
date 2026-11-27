import { useState } from "react";
import type { ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { scriptLineText } from "./scriptSemantics";
import { confirmedOnTake } from "../material-script/actionDialogue";

interface Props {
  action: ReviewScriptBlock;
  dialogue: readonly ReviewScriptBlock[];
  take: ReviewTakeGroup;
  automaticBlocks: readonly ReviewScriptBlock[];
  saving: boolean;
  onConfirm: (blocks: ReviewScriptBlock[]) => void;
}

export function ActionDialoguePlacement({ action, dialogue, take, automaticBlocks, saving, onConfirm }: Props) {
  const [lineId, setLineId] = useState(dialogue[0].segment_id);
  const [included, setIncluded] = useState<string[]>([]);
  const line = dialogue.find(block => block.segment_id === lineId) ?? dialogue[0];
  const confirmed = [action, line].every(block => confirmedOnTake(take, block.segment_id));
  const otherAutomatic = automaticBlocks.filter(block => block.segment_id !== line.segment_id && block.segment_id !== action.segment_id);

  return <section className="script-action-dialogue" aria-label="动作与台词同拍">
    <h4>动作与台词同拍</h4>
    <p>{scriptLineText(action)}</p>
    <label className="script-action-dialogue-line"><span>同条台词</span>{dialogue.length > 1
      ? <select aria-label="同条台词" value={line.segment_id} onChange={event => setLineId(event.target.value)}>
        {dialogue.map(block => <option key={block.segment_id} value={block.segment_id}>{scriptLineText(block)}</option>)}
      </select>
      : <span>{scriptLineText(line)}</span>}</label>
    {otherAutomatic.length > 0 && <fieldset><legend>一并保留为人工归属的原有自动匹配</legend>
      <small>未勾选的段落保留在自动匹配记录中。</small>
      {otherAutomatic.map(block => <label key={block.segment_id}><input type="checkbox" checked={included.includes(block.segment_id)}
        onChange={event => setIncluded(event.target.checked ? [...included, block.segment_id] : included.filter(id => id !== block.segment_id))} />
        {scriptLineText(block)}</label>)}
    </fieldset>}
    {confirmed ? <span className="script-action-confirmed">已确认同拍</span> : <button type="button" disabled={saving}
      onClick={() => onConfirm([line, action, ...otherAutomatic.filter(block => included.includes(block.segment_id))])}>确认动作与台词同拍</button>}
  </section>;
}
