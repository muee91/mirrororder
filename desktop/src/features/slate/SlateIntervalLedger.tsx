import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ElectronicSourceSelection } from "../../api/paperSourceContext";
import type { SourceTriage, SourceTriageCell } from "../../api/slateIntervalBoard";
import { EMPTY_SOURCE_TRIAGE_FILTER, matchesSourceCell, SlateSourceTriage, SlateSourceTriageBadges, sourceTriagePriority, type SourceTriageFilter } from "./SlateSourceTriage";
import "./slate-interval-ledger.css";

export type SceneChoice = { episode: number; scene_id: string; label?: string };
export type SelectedEvidence = { evidence_id: string; expected_evidence_version: number; expected_evidence_sha256: string };
export type StageCorrection = SceneChoice & {
  mode: "script_scene" | "local_correction";
  expected_revision: number;
  expected_draft_revision: number;
  selected: SelectedEvidence[];
};
export type PaperLocation = { document: string; page: number; line: number; raw: string };
export type LedgerRow = {
  id: string;
  paper: PaperLocation;
  paperRowId?: string;
  paperRowDigest?: string;
  paperSourceCamera?: ElectronicSourceSelection["camera"];
  sheetCameraExplicit?: ElectronicSourceSelection["camera"];
  legacyScene?: string;
  cameraChoices?: (ElectronicSourceSelection & {status:"literal"|"needs_review"})[];
  paperHint?: SceneChoice;
  interval?: {
    evidence: SelectedEvidence;
    clipLabel: string;
    sourceIdentity?: {clipId:string;mediaId:string;assetRevision:string};
    start: number;
    endExclusive: number;
    fps: string;
    current: boolean;
  };
  verified?: SceneChoice;
  draft?: SceneChoice & { draft_id: string; targets: SelectedEvidence[]; status: "review_draft" };
  pendingReason?: string;
};
export type LedgerSnapshot = { revision: number; draftRevision: number; rows: LedgerRow[] };
export type ApproveCorrection = { draft_id: string; expected_revision: number; expected_draft_revision: number };
type Filter = "pending" | "grouped" | "all";
type PendingLane = "all" | "sources" | "classify" | "drafts";
export type SlateIntervalLedgerProps = {
  snapshot: LedgerSnapshot;
  catalog: SceneChoice[];
  stageCorrection: (input: StageCorrection) => Promise<{ revision: number; draft_revision: number; draft: { status: "review_draft"; editorial_authority: false } }>;
  approveCorrection?: (input: ApproveCorrection) => Promise<{ revision: number; draft_revision: number; approved: string[]; export_ready: false }>;
  refresh: () => Promise<void>;
  paperEvidence?: (row: LedgerRow) => ReactNode;
  onOpenMediaBinding?: (trigger: HTMLButtonElement) => void;
  rangeEvidence?: (row: LedgerRow, startOpen?:boolean) => ReactNode;
  sourceTriage?: SourceTriage;
  focusEvidenceId?: string;
  inspectionOnly?: boolean;
};

const groupKey = (pair?: SceneChoice) => pair ? JSON.stringify([pair.episode,pair.scene_id]) : "";
const good = (pair?: SceneChoice): pair is SceneChoice => !!pair && Number.isSafeInteger(pair.episode) && pair.episode > 0 && !!pair.scene_id.trim() && pair.scene_id.trim().toUpperCase() !== "UNKNOWN";
const verified = (row: LedgerRow) => !!(row.interval?.current && good(row.verified));
const editable = (row: LedgerRow) => !!(row.interval?.current && row.interval.evidence.evidence_id && Number.isSafeInteger(row.interval.evidence.expected_evidence_version) && /^[a-f0-9]{64}$/.test(row.interval.evidence.expected_evidence_sha256));
function pendingLane(row:LedgerRow):Exclude<PendingLane,"all">|null {
  if (!row.interval?.current) return "sources";
  if (row.draft) return "drafts";
  return verified(row)?null:"classify";
}
function compare(a: LedgerRow, b: LedgerRow) {
  if (verified(a)!==verified(b)) return verified(a)?1:-1;
  if (verified(a) && verified(b)) {
    const p = a.verified!, q = b.verified!;
    const grouped = p.episode - q.episode || p.scene_id.localeCompare(q.scene_id, "zh", { numeric: true });
    if (grouped) return grouped;
  }
  return a.paper.document.localeCompare(b.paper.document) || a.paper.page-b.paper.page || a.paper.line-b.paper.line || a.id.localeCompare(b.id);
}
function pairLabel(pair: SceneChoice) { return `第 ${pair.episode} 集 · ${pair.label || pair.scene_id} 场`; }
function compatible(rows: LedgerRow[]) {
  if (!rows.length || rows.length>24 || rows.some((r)=>!editable(r))) return false;
  const first=rows[0].paper;
  if(rows.length>1&&(!first.document||first.page<=0||new Set(rows.map(r=>r.legacyScene).filter(Boolean)).size>1))return false;
  if(new Set(rows.map((r)=>r.interval!.evidence.evidence_id)).size !== rows.length) return false;
  const bases = new Set(rows.map((r)=>groupKey(r.draft ?? r.verified ?? r.paperHint)).filter(Boolean));
  return rows.every((r)=>r.paper.document===first.document && r.paper.page===first.page) && bases.size <= 1;
}

export function SlateIntervalLedger({ snapshot, catalog, stageCorrection, approveCorrection, refresh, paperEvidence, onOpenMediaBinding, rangeEvidence, focusEvidenceId, sourceTriage, inspectionOnly=false }: SlateIntervalLedgerProps) {
  const [tab,setTab] = useState<Filter>("pending");
  const [lane,setLane]=useState<PendingLane>("all");
  const [triageFilter,setTriageFilter] = useState<SourceTriageFilter>(EMPTY_SOURCE_TRIAGE_FILTER);
  const [query,setQuery] = useState("");
  const [focused,setFocused] = useState("");
  const [selection,setSelection] = useState<{revision:number;ids:string[]}>({revision:snapshot.revision,ids:[]});
  const [form,setForm] = useState({choice:"",episode:"",scene:"",target:"",mode:"script_scene" as StageCorrection["mode"]});
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [stale,setStale] = useState(false);
  const locked=useRef(false);
  const rowNodes=useRef(new Map<string,HTMLButtonElement>());
  const choices=useMemo(()=>[...new Map(catalog.filter(good).map((pair)=>[groupKey(pair),pair])).values()], [catalog]);
  const picked = selection.revision===snapshot.revision ? selection.ids : [];
  const pendingCounts=useMemo(()=>{
    const result={all:0,sources:0,classify:0,drafts:0};
    for(const row of snapshot.rows){const lane=pendingLane(row);if(lane){result.all++;result[lane]++;}}
    return result;
  },[snapshot.rows]);
  const triageEnabled=!!(tab==="pending"&&lane==="sources"&&sourceTriage);
  const triageByRow=useMemo(()=>{
    const exact=new Map<string,SourceTriageCell[]>(),byPaper=new Map(sourceTriage?.rows.map(row=>[row.paper_row_id,row])??[]);
    for(const row of snapshot.rows){
      const triage=row.paperRowId?byPaper.get(row.paperRowId):undefined;
      if(triage && row.paperRowDigest===triage.row_digest && pendingLane(row)==="sources")exact.set(row.id,triage.cells);
    }
    return exact;
  },[snapshot.rows,sourceTriage]);
  // Count electronic cells once even if a paper row has historic intervals.
  const triageCells=useMemo(()=>{
    const seen=new Set<string>();return snapshot.rows.flatMap(row=>{
      if(!row.paperRowId||seen.has(row.paperRowId)||!triageByRow.has(row.id))return [];
      seen.add(row.paperRowId);return triageByRow.get(row.id)??[];
    });
  },[snapshot.rows,triageByRow]);
  const safeTriageFilter=useMemo(()=>({
    ...triageFilter,
    card:triageCells.some(c=>(!triageFilter.camera||triageFilter.camera===c.camera)&&c.cards.some(card=>card.card===triageFilter.card))?triageFilter.card:"",
  }),[triageFilter,triageCells]);
  const q=query.trim().toLocaleLowerCase();
  const shown=useMemo(()=>snapshot.rows.filter((r)=>{
    if(inspectionOnly)return true;
    if (tab==="pending" && (!pendingLane(r)||(lane!=="all"&&pendingLane(r)!==lane))) return false;
    if (tab==="grouped" && !verified(r)) return false;
    if (triageEnabled&&(safeTriageFilter.camera||safeTriageFilter.card||safeTriageFilter.tier)&&!(triageByRow.get(r.id)??[]).some(c=>matchesSourceCell(c,safeTriageFilter)))return false;
    return !q || [r.interval?.clipLabel,r.paper.raw,r.pendingReason,r.verified && pairLabel(r.verified),r.draft && pairLabel(r.draft),`第 ${r.paper.page} 页第 ${r.paper.line} 行`].some((v)=>v?.toLocaleLowerCase().includes(q));
  }).sort((a,b)=>{
    const priority={classify:0,drafts:1,sources:2};
    if(tab==="pending"){const first=pendingLane(a),second=pendingLane(b);if(first&&second&&first!==second)return priority[first]-priority[second];}
    if(triageEnabled){const order=(row:LedgerRow)=>sourceTriagePriority((triageByRow.get(row.id)??[]).filter(c=>matchesSourceCell(c,safeTriageFilter)));const n=order(a)-order(b);if(n)return n;}
    return compare(a,b);
  }),[snapshot.rows,tab,lane,q,triageEnabled,triageByRow,safeTriageFilter,inspectionOnly]);
  useEffect(()=>{
    if(!focusEvidenceId)return;
    const target=snapshot.rows.find(row=>row.interval?.evidence.evidence_id===focusEvidenceId && pendingLane(row)==="classify");
    if(target){setFocused(target.id);setTab("pending");setLane("classify");setQuery("");setSelection({revision:snapshot.revision,ids:[]});}
  },[focusEvidenceId]);
  const active=shown.find((row)=>row.id===focused)??shown[0];
  const bulk=shown.filter((row)=>picked.includes(row.id));
  const targets=picked.length ? bulk : active ? [active] : [];
  const targetKey=JSON.stringify([snapshot.revision,snapshot.draftRevision,targets.map((r)=>r.id)]);
  const draft=active?.draft;
  const draftTargets=draft?.targets.map((item)=>item.evidence_id)??[];
  const selectors=targets.map((target)=>target.interval?.evidence.evidence_id).filter(Boolean).sort();
  const canApprove=!!(approveCorrection && draft && draft.status==="review_draft" && draftTargets.length > 0 && new Set(draftTargets).size===draftTargets.length && JSON.stringify([...draftTargets].sort())===JSON.stringify(selectors) && compatible(targets)
    && targets.every((target)=>target.draft?.draft_id===draft.draft_id));
  const allowed=compatible(targets) && (!picked.length || (picked.length===bulk.length));
  const validLocalEpisode=/^[1-9]\d{0,4}$/.test(form.episode);
  const validLocalScene=!!form.scene.trim() && form.scene.trim().length<=80 && !/^(?:UNKNOWN|同上|ditto)$/i.test(form.scene.trim()) &&
    /^[\p{L}\p{N}]+(?:[ ./_-][\p{L}\p{N}]+)*$/u.test(form.scene.trim());
  const pair=form.mode==="script_scene"?choices.find((x)=>groupKey(x)===form.choice):validLocalEpisode&&validLocalScene?{episode:Number(form.episode),scene_id:form.scene.trim()}:undefined;
  const clearSelection=()=>setSelection({revision:snapshot.revision,ids:[]});
  const changeTab=(next:Filter)=>{setTab(next);clearSelection();};
  const activeMissing=active&&pendingLane(active)==="sources";
  function toggle(id:string) {
    setSelection({revision:snapshot.revision,ids:picked.includes(id)?picked.filter((x)=>x!==id):[...picked,id]});
  }
  async function save() {
    if(locked.current || stale || !pair || !allowed || form.target!==targetKey) return;
    locked.current=true;setBusy(true);setMessage("");
    try {
      const result=await stageCorrection({mode:form.mode,episode:pair.episode,scene_id:pair.scene_id,expected_revision:snapshot.revision,expected_draft_revision:snapshot.draftRevision,selected:targets.map((r)=>r.interval!.evidence)});
      if(!Number.isSafeInteger(result.revision) || result.revision !== snapshot.revision || !Number.isSafeInteger(result.draft_revision) || result.draft_revision <= snapshot.draftRevision || result.draft.status!=="review_draft" || result.draft.editorial_authority!==false) throw new Error("无有效的修正草稿回执");
      setSelection({revision:result.revision,ids:[]});
      setForm((value)=>({...value,target:""}));
      setMessage("已存修正草稿；原片和帧位未改，不代表已确认归场。");
      try { await refresh(); }
      catch { setStale(true);setMessage("修正草稿已保存；列表刷新失败，请重读后继续。"); }
    } catch {
      setStale(true);setMessage("未能验证修正回执。已保留输入，重读后再提交。");
    } finally {setBusy(false);locked.current=false;}
  }
  async function approve() {
    if(locked.current || stale || !canApprove || !draft || !approveCorrection) return;
    locked.current=true;setBusy(true);setMessage("");
    try {
      const result=await approveCorrection({draft_id:draft.draft_id,expected_revision:snapshot.revision,expected_draft_revision:snapshot.draftRevision});
      if(!Number.isSafeInteger(result.revision) || result.revision<=snapshot.revision || !Number.isSafeInteger(result.draft_revision) || result.draft_revision<=snapshot.draftRevision ||
        result.export_ready!==false || JSON.stringify([...result.approved].sort())!==JSON.stringify([...draftTargets].sort())) throw new Error("无有效的审核回执");
      setSelection({revision:result.revision,ids:[]});
      setForm((value)=>({...value,target:""}));
      setMessage("已确认集场；原片与帧位未改。");
      try { await refresh(); }
      catch {setStale(true);setMessage("集场已确认；列表刷新失败，请重读后继续。");}
    } catch {
      setStale(true);setMessage("未能验证审核回执。请重读列表再核对。");
    } finally {setBusy(false);locked.current=false;}
  }
  async function reload() {
    if (locked.current) return;
    locked.current=true;setBusy(true);
    try { await refresh();setStale(false);setSelection({revision:snapshot.revision,ids:[]});setMessage("已重读列表，请重新核对目标。"); }
    catch {setMessage("未能刷新，输入已保留。");}
    finally {setBusy(false);locked.current=false;}
  }

  return <section className="slate-interval-ledger" aria-label="区间场记">
    {!inspectionOnly&&<header className="sil-toolbar">
      <nav aria-label="区间筛选">
        {([["pending","待复核"],["grouped","已归场"],["all","全部"]] as const).map(([id,label])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>changeTab(id)}>{label}</button>)}
      </nav>
      <input aria-label="搜索场记" placeholder="搜集场、原片、原文" value={query} onChange={(e)=>{setQuery(e.target.value);setSelection({revision:snapshot.revision,ids:[]});}}/>
      <span>{shown.length} / {snapshot.rows.length} 条</span>
    </header>}
    {!inspectionOnly&&tab==="pending" && <div className="sil-priority" aria-label="待复核工作">
      {([["all","全部待核"],["classify","补集场"],["drafts","待确认"],["sources","待匹配原片"]] as const).map(([key,label])=><button key={key} type="button" aria-pressed={lane===key} onClick={()=>{setLane(key);clearSelection();}}>{label} <strong>{pendingCounts[key]}</strong></button>)}
    </div>}
    {!inspectionOnly&&triageEnabled&&<SlateSourceTriage cells={triageCells} visibleRows={shown.length} filter={safeTriageFilter} change={(filter)=>{setTriageFilter(filter);clearSelection();}}/>}
    <div className={inspectionOnly?"sil-single-inspection":"sil-workspace"}>
      {!inspectionOnly&&<div className="sil-table-wrap">
        {shown.length? <table className="sil-table"><thead><tr><th scope="col">选</th><th scope="col">行位</th><th scope="col">原片与区间</th><th scope="col">复核</th></tr></thead>
        <tbody>{shown.map((row,index)=>{
          const listGroup=verified(row)?groupKey(row.verified):"pending";
          const previous=shown[index-1];const previousGroup=previous?(verified(previous)?groupKey(previous.verified):"pending"):"";
          return <LedgerLine key={row.id} row={row} active={active?.id===row.id} picked={picked.includes(row.id)} triage={triageEnabled?triageByRow.get(row.id):undefined}
            heading={tab!=="pending"&&listGroup!==previousGroup?(verified(row)?pairLabel(row.verified!):"未归场"):undefined}
            select={()=>setFocused(row.id)} toggle={()=>toggle(row.id)} bind={(button)=>{if(button)rowNodes.current.set(row.id,button);else rowNodes.current.delete(row.id);}}
            move={(delta)=>{const next=shown[index+delta];if(next){setFocused(next.id);rowNodes.current.get(next.id)?.focus();}}}/>;
        })}</tbody></table>:<p className="sil-empty">{snapshot.rows.length?"没有符合筛选条件的场记。":"暂无可读场记。导入电子表后，待核记录会列在这里。"}</p>}
      </div>}
      {active && <aside className="sil-inspector" aria-label="查看电子记录与区间">
        <div className="sil-evidence">
          <section aria-label="电子记录"><h3>电子记录 · {active.paper.page>0&&active.paper.line>0?`第 ${active.paper.page} 页第 ${active.paper.line} 行`:"未标位置"}</h3><p>{active.paper.raw || "未读到原文，不沿用上一行。"}</p>{paperEvidence?.(active)}</section>
          <section aria-label="原片区间证据"><h3>原片区间</h3>
          {active.interval?<><p>{active.interval.clipLabel}</p><p>源帧 {active.interval.start}–{active.interval.endExclusive-1} · {active.interval.fps} fps</p>{!active.interval.current&&<p>当前设备不能验证这条原片；先恢复本机连接。</p>}{rangeEvidence?.(active,inspectionOnly&&!!active.paperSourceCamera)}</>:<p>{active.pendingReason || "未匹配原片；先核对来源。"}</p>}
          {activeMissing&&onOpenMediaBinding&&<button type="button" onClick={(e)=>onOpenMediaBinding(e.currentTarget)}>连接原片…</button>}
          {activeMissing&&<small>素材已在本机？在电子记录中选择对应机位。</small>}</section>
        </div>
        {editable(active)?<form className="sil-form" onSubmit={(e)=>{e.preventDefault();void save();}}>
          <h3>{picked.length>1?`修正选中的 ${picked.length} 条`:"修正集场"}</h3>
          {active.verified && <p>当前归场：{pairLabel(active.verified)}</p>}
          {!active.verified&&active.legacyScene&&<p>已有场号：{active.legacyScene}（待核集场）</p>}
          {draft && <section aria-label="待确认草稿">
            <p>待确认草稿：{pairLabel(draft)} · {draftTargets.length} 条</p>
            {approveCorrection && draftTargets.length>1 && !canApprove && <p>请先选中此草稿的全部区间，再确认，避免改到未看过的区间。</p>}
            {approveCorrection && <button type="button" disabled={busy||stale||!canApprove} onClick={()=>void approve()}>确认这 {draftTargets.length} 条集场</button>}
          </section>}
          {!active.verified && active.paperHint && <p>电子表提示：{pairLabel(active.paperHint)}（未确认）</p>}
          {targets.length>1 && !allowed && <p>一次最多 24 条，须为同页、同组且有明确原片区间。</p>}
          <label>来源<select value={form.mode} onChange={(e)=>setForm({...form,mode:e.target.value as StageCorrection["mode"]})}><option value="script_scene">从剧本选</option><option value="local_correction">手动补填</option></select></label>
          {form.mode==="script_scene"? <label>集场<select value={form.choice} onChange={(e)=>setForm({...form,choice:e.target.value,target:targetKey})}><option value="">选择集与场</option>{choices.map((x)=><option key={groupKey(x)} value={groupKey(x)}>{pairLabel(x)}</option>)}</select></label> :
            <div className="sil-manual"><label>集<input inputMode="numeric" value={form.episode} onChange={(e)=>setForm({...form,episode:e.target.value,target:targetKey})}/></label><label>场<input value={form.scene} maxLength={80} onChange={(e)=>setForm({...form,scene:e.target.value,target:targetKey})}/></label></div>}
          {pair && form.target!==targetKey && <p>目标已变化，请重新选择集场。</p>}
          <button type="submit" disabled={busy || stale || !allowed || !pair || form.target!==targetKey}>存为修正草稿</button>
          {stale && <button type="button" disabled={busy} onClick={()=>void reload()}>重读列表</button>}
        </form>:<p className="sil-empty sil-action-hint">先匹配原片，再补集场。不需要重填电子记录。</p>}
      </aside>}
    </div>
    <p className="sil-status" role="status">{message}</p>
  </section>;
}

type LineProps={row:LedgerRow;active:boolean;picked:boolean;triage?:SourceTriageCell[];heading?:string;select:()=>void;toggle:()=>void;bind:(button:HTMLButtonElement|null)=>void;move:(delta:number)=>void};
function LedgerLine({row,active,picked,triage,heading,select,toggle,bind,move}:LineProps) {
  return <>{heading&&<tr className="sil-group" aria-label={heading}><th scope="rowgroup" colSpan={4}>{heading}</th></tr>}<tr data-active={active}>
    <td><input type="checkbox" tabIndex={active?0:-1} aria-label={`选第 ${row.paper.page} 页第 ${row.paper.line} 行`} checked={picked} disabled={!editable(row)} onChange={toggle}/></td>
    <td><button type="button" className="sil-row" tabIndex={active?0:-1} aria-current={active||undefined} ref={bind} onClick={select} onKeyDown={(e)=>{if(e.key==="ArrowUp"||e.key==="ArrowDown"){e.preventDefault();move(e.key==="ArrowUp"?-1:1);}}}>{row.paper.page>0&&row.paper.line>0?`${row.paper.page}:${row.paper.line}`:"未标"}</button></td>
    <td>{triage?.some(cell=>cell.tier!=="empty")?<SlateSourceTriageBadges cells={triage}/>:row.interval ? <><b>{row.interval.clipLabel}</b><small> {row.interval.start}–{row.interval.endExclusive-1}</small></> : "—"}</td>
    <td>{row.draft ? "有草稿" : verified(row) ? "已归场" : row.interval ? row.interval.current ? "待补集场" : "原片待重核" : "待对原片"}</td>
  </tr></>;
}
