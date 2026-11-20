import type {SourceTriageCell,SourceTriageTier} from "../../api/slateIntervalBoard";
import type {PaperCamera} from "../../api/paperCellReview";

export type SourceTriageFilter={camera: PaperCamera | ""; card: string; tier:SourceTriageTier | ""};
export const EMPTY_SOURCE_TRIAGE_FILTER:SourceTriageFilter={camera:"",card:"",tier:""};
const priorities:Record<SourceTriageTier,number>={uncertain:0,same_card_collision:1,multi_card:2,not_indexed:3,single_indexed:4,empty:5};
const label:Record<SourceTriageTier,string>={uncertain:"编号需复核",same_card_collision:"同卡同号",multi_card:"多卡同号",not_indexed:"索引未找到",single_indexed:"索引仅一候选",empty:"未填写"};

export function matchesSourceCell(cell:SourceTriageCell,f:SourceTriageFilter) {
  return (!f.camera||cell.camera===f.camera)&&(!f.tier||cell.tier===f.tier)&&(!f.card||cell.cards.some(c=>c.card===f.card));
}
export function sourceTriagePriority(cells:SourceTriageCell[]) {
  return cells.reduce((best,cell)=>Math.min(best,priorities[cell.tier]),6);
}
export function SlateSourceTriage({cells,filter,change,visibleRows}:{cells:SourceTriageCell[];filter:SourceTriageFilter;change:(value:SourceTriageFilter)=>void;visibleRows?:number}) {
  const eligible=cells.filter(c=>!filter.camera||c.camera===filter.camera);
  const cards=[...new Set(eligible.flatMap(c=>c.cards.map(item=>item.card)))].sort();
  const count=(tier:SourceTriageTier)=>eligible.filter(c=>c.tier===tier).length;
  if(!cells.length)return null;
  return <div className="sil-source-triage" aria-label="来源速览">
    <strong>来源速览</strong>
    <label>机位<select value={filter.camera} onChange={e=>change({...filter,camera:e.target.value as SourceTriageFilter["camera"],card:""})}>
      <option value="">全部机位</option>{(["A","B","C"] as const).map(cam=><option key={cam} value={cam}>{cam} 机 · {cells.filter(c=>c.camera===cam).length} 格</option>)}
    </select></label>
    <label>卡号<select value={filter.card} onChange={e=>change({...filter,card:e.target.value})}>
      <option value="">全部卡号</option>{cards.map(card=><option key={card} value={card}>{card} · {eligible.filter(c=>c.cards.some(item=>item.card===card)).length} 格</option>)}
    </select></label>
    <label>优先<select value={filter.tier} onChange={e=>change({...filter,tier:e.target.value as SourceTriageFilter["tier"]})}>
      <option value="">全部状态</option>{(Object.keys(priorities) as SourceTriageTier[]).map(t=><option key={t} value={t}>{label[t]} · {count(t)} 格</option>)}
    </select></label>
    <small>{visibleRows!==undefined&&`显示 ${visibleRows} 行 · `}索引提示，已登记不等于可播放。</small>
  </div>;
}
export function SlateSourceTriageBadges({cells}:{cells:SourceTriageCell[]}) {
  return <span className="sil-triage-badges">{cells.filter(c=>c.tier!=="empty").map(c=><small key={c.camera} title={c.cards.map(card=>`${card.card} ${card.occurrence_count} 条 · 已登记 ${card.registered_count}`).join("；")}>
    {c.camera}机 {label[c.tier]}{c.cards.length>0&&!c.cards.some(card=>card.registered_count>0)&&" · 未连接"}
  </small>)}</span>;
}
