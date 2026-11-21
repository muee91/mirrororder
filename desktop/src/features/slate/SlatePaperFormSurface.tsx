import "./slate-form-drawer.css";

import {useEffect,useMemo,useRef,useState} from "react";
import {thumbKey,useSlateThumbnails,type ThumbCell} from "./useSlateThumbnails";
import type {SlateThumbnailTarget,PaperAnnotationField,PaperAnnotationReading,PaperAnnotationRequest,SlateFramingModel,SlateFramingSet,SheetFirstModel,SheetManualEdit,SyncAngleFields,SyncAngleIdentity,SyncAngleReceipt} from "../../api/slateIntervalBoard";
import {SyncAngleAnnotationPanel} from "./SyncAngleAnnotationPanel";
import {SlateOriginalPlayback} from "./SlateOriginalPlayback";
import {SlateFramingPicker} from "./SlateFramingPicker";
import type {PaperRow,PaperDocument} from "../../api/paperIntake";
import type {SlateRecord} from "../../api/production";
import {SlateIntervalLedger,type SlateIntervalLedgerProps} from "./SlateIntervalLedger";
import {SlateOriginalFormSheet,type SlateFormCellAction,type SlateFormRow,type SlateFormMedia} from "./SlateOriginalFormSheet";
import {selectPaperFormTargets,toPaperFormRow} from "./slatePaperFormState";

import {browseUniverse,browseRows,cameras,codeParts,pdfAnchor,sourceField,type BrowseMode,type BrowseRow,type SortKind} from "./slateBrowseModel";

export type SheetFirstController={model:SheetFirstModel;add(fields:Record<string,string>,requestId:string):Promise<SheetFirstModel>;edit?(change:SheetManualEdit):Promise<SheetFirstModel>;thumbnail?(target:SlateThumbnailTarget,signal:AbortSignal):Promise<Blob>;annotate?(request:PaperAnnotationRequest):Promise<PaperAnnotationReading>;angle?(target:SyncAngleIdentity,mutation?:{receipt:SyncAngleReceipt;fields:SyncAngleFields}):Promise<SyncAngleReceipt>};
const TARGET_FIELDS={scene_raw:"scene",shot_raw:"shot",take_raw:"take"} as const;
const FIELD_NAMES={scene:"场号",shot:"镜号",take:"次数"};
const getTargetField=(f:string):PaperAnnotationField|undefined=>Object.prototype.hasOwnProperty.call(TARGET_FIELDS,f)?TARGET_FIELDS[f as keyof typeof TARGET_FIELDS]:undefined;
const MANUAL_FIELDS=[
 ["scene_raw","场号"],["shot_raw","镜号"],["take_raw","次数"],
 ["cameras.A.clip_raw","A 机文件号"],["cameras.B.clip_raw","B 机文件号"],["cameras.C.clip_raw","C 机文件号"],
 ["content_raw","拍摄内容"],["notes_raw","备注"],
] as const;

export type SheetFramingController={model:SlateFramingModel;set(request:SlateFramingSet):Promise<void>};
export type ProductionSlateTarget={groupId:string;field?:"scene"|"shot"|"take";clipId?:string;mediaId?:string;sourceTime?:number};
export type ProductionSlateRows=ReadonlyMap<string,Pick<SlateRecord,"episode"|"scene"|"shot"|"take_number"|"note">&{derived:boolean}>;

export function SlatePaperFormSurface({formRows,formDocuments,onReview,ledger,title,framingControl,sheetFirst,baseUrl,projectId,productionRows,onOpenProduction}:{title?:string;baseUrl?:string;projectId?:string;sheetFirst?:SheetFirstController;framingControl?:SheetFramingController;formRows:readonly PaperRow[];formDocuments?:readonly PaperDocument[];onReview:()=>void;ledger:SlateIntervalLedgerProps;productionRows?:ProductionSlateRows;onOpenProduction?:(target:ProductionSlateTarget)=>void}){
 const manualRequest=useRef("");
 const [manualFields,setManualFields]=useState<Record<string,string>>();
 const [saving,setSaving]=useState(false);
 const [manualError,setManualError]=useState("");
 const [mode,setMode]=useState<BrowseMode>("continuous");
 const [sort,setSort]=useState<SortKind>("source");
 const [descending,setDescending]=useState(false);
 const [query,setQuery]=useState("");
 const [pdfPage,setPdfPage]=useState("");
 const [pdfJump,setPdfJump]=useState("");
 const [paperLocated,setPaperLocated]=useState<string>();
 const [pdfJumpMessage,setPdfJumpMessage]=useState("");
 const [active,setActive]=useState<SlateFormCellAction>();
 const [manualCell,setManualCell]=useState("");
 const [editError,setEditError]=useState("");
 const [framing,setFraming]=useState<SlateFormCellAction>();
 const [intervalId,chooseInterval]=useState("");
 const activeAnchor=useRef<HTMLButtonElement|null>(null);
 const detail=useRef<HTMLElement|null>(null);
 const sheet=useRef<HTMLElement|null>(null);
 const projection=sheetFirst?.model;
 const preferenceKey=projection?.workspace_scope&&projectId?`mirrororder:slate-browse:${projection.workspace_scope}:${projectId}`:"";
 const preferred=useRef("");
 useEffect(()=>{
   if(!preferenceKey||preferred.current===preferenceKey)return;
   preferred.current=preferenceKey;
   try{const saved=localStorage.getItem(preferenceKey);if(saved==="continuous"||saved==="scene"||saved==="pdf"||saved==="transcript")setMode(saved);}catch{/* optional local preference */}
 },[preferenceKey]);
 function chooseMode(value:BrowseMode){setMode(value);try{if(preferenceKey)localStorage.setItem(preferenceKey,value);}catch{/* optional local preference */}}

 const sourceLookup=useMemo(()=>new Map(projection?.sync_groups.map(g=>[g.group_id,g])),[projection]);
 const allRows=useMemo(()=>{
   const indexDigest=projection?.index_sha256??"";
   const triage=new Map(ledger.sourceTriage?.rows.map(row=>[row.paper_row_id,row]));
   const docs=new Map(formDocuments?.map(d=>[d.document_id,d]));
   const byRow=new Map<string,typeof ledger.snapshot.rows>();
   for(const r of ledger.snapshot.rows){if(!r.paperRowId)continue;const v=byRow.get(r.paperRowId);if(v)v.push(r);else byRow.set(r.paperRowId,[r]);}
   const tagRows=new Map<string,NonNullable<typeof framingControl>["model"]["tags"]>();
   for(const tag of framingControl?.model.tags??[]){const v=tagRows.get(tag.paper_row_id);if(v)v.push(tag);else tagRows.set(tag.paper_row_id,[tag]);}
   const ranks=new Map<string,Set<string>>();
   for(const g of projection?.sync_groups??[])for(const c of g.sources){const {card,code}=codeParts(c.file_name??c.label);
     if(card){const key=c.camera+":"+code;const set=ranks.get(key);if(set)set.add(card);else ranks.set(key,new Set([card]));}}
   const sync:BrowseRow[]=(projection?.sync_groups??[]).map((g,i)=>{
      const cells:SlateFormRow["cells"]={},media:NonNullable<SlateFormRow["media"]>={};
      for(const cam of cameras){
         const c=g.sources.find(r=>r.camera===cam);
         if(!c){media[cam]={state:"absent"};continue;}
         const full=c.file_name??c.label,{card,code}=codeParts(full);
         cells[sourceField(cam)]=full;
         media[cam]={state:c.connection??"unknown",fileName:full,card,showCard:(ranks.get(cam+":"+code)?.size??0)>1};
      }
      const hint=projection?.paper_suggestions?.groups[g.group_id];
      const source=hint?.source;
      const fields:NonNullable<SlateFormRow["paperHint"]>["fields"]={};
      if(source&&hint.human_confirmed===false&&projection?.paper_suggestions?.editorial_authority===false){
         for(const field of ["scene","shot","take"] as const){
           const value=hint.fields[field];if(value)fields[`${field}_raw`]=value.state==="conflict"?{value:value.paper_value,conflict:true}:{value:value.value,conflict:false};
         }
      }
      return {id:g.group_id,digest:indexDigest,line:i+1,sequence:i,kind:"sync",cells,media,paperHint:source?{page:source.pdf_page,row:source.row_index,fields}:undefined};
   });
   const orig:BrowseRow[]=formRows.flatMap((r,i)=>{
      if(!r.row_digest)return [];
      const history=(byRow.get(r.paper_row_id)??[]).filter(row=>row.paperRowDigest===r.row_digest);
      const form=toPaperFormRow(r,history), proof=triage.get(r.paper_row_id);
      form.framing={};
      for(const tag of tagRows.get(form.id)??[])if(tag.row_digest===form.digest)form.framing[tag.camera]=tag.tag;
      form.media={};
      for(const camera of cameras){
        const raw=form.cells[sourceField(camera)];
        const exact=history.find(row=>row.paperSourceCamera===camera&&row.interval?.current);
        const read=proof?.row_digest===form.digest?proof.cells.find(c=>c.camera===camera):undefined;
        const state:SlateFormMedia["state"]=!raw?.trim()?"absent":exact?"linked":
           read?.tier==="multi_card"||read?.tier==="same_card_collision"?"ambiguous":
           read?.cards.length&&!read.cards.some(c=>c.registered_count>0)?"not_connected":"unknown";
        form.media[camera]={state};
      }
      const confirmed=[...new Map(history.filter(h=>h.verified).map(h=>[JSON.stringify([h.verified!.episode,h.verified!.scene_id]),{episode:h.verified!.episode,scene:h.verified!.scene_id}])).values()];
      return [{...form,kind:"paper",sequence:sync.length+i,confirmed:confirmed.length===1?confirmed[0]:undefined,pdf:pdfAnchor(r,docs.get(r.document_id))}];
   });
   const manual:BrowseRow[]=(projection?.manual_rows??[]).map((r,i)=>({id:r.row_id,digest:indexDigest,line:r.sequence,
      sequence:sync.length+orig.length+i,kind:"manual",cells:r.fields}));
   const originals=new Map(orig.map(r=>[r.id,r]));
   for(const row of sync){
     const production=productionRows?.get(row.id);
     if(production&&!production.derived){
       row.cells={...row.cells,scene_raw:production.scene,shot_raw:production.shot,take_raw:production.take_number?.toString()??"",notes_raw:production.note};
       if(production.episode&&production.scene.trim())row.confirmed={episode:production.episode,scene:production.scene};
     }
     const source=projection?.paper_suggestions?.groups[row.id]?.source;
     const original=source&&originals.get(source.paper_row_id);

     if(!original||original.digest!==source?.row_digest||original.pdf?.key!==JSON.stringify([source.pdf_sha256,source.pdf_page]))row.paperHint=undefined;
     if(sheetFirst?.annotate){
       row.fieldReview={};
       for(const field of ["scene","shot","take"] as const){
          const status=projection?.paper_field_annotations?.[row.id]?.[field];
          if(!status)continue;
          if(status.state==="needs_review"||!row.paperHint){
             row.fieldReview[`${field}_raw`]={label:"待复核",editable:false};continue;
          }
          const label=status.state==="adopt"?`已确认 ${status.value}`:status.state==="manual"?`手工 ${status.value}`:status.state==="clear"?"已清空":`建议 ${status.suggestion}`;
          row.fieldReview[`${field}_raw`]={label,editable:true};
       }
     }
     if(onOpenProduction&&production){
       row.fieldReview??={};
       for(const field of ["scene","shot","take"] as const){
         const key=`${field}_raw` as const;
         if(!row.fieldReview[key])row.fieldReview[key]={label:row.cells[key]?`手工 ${row.cells[key]}`:"待标记",editable:true};
       }
     }
   }
   return [...sync,...orig,...manual];
 },[formRows,formDocuments,projection,ledger.snapshot.rows,ledger.sourceTriage,framingControl?.model.tags,sheetFirst?.annotate,productionRows,onOpenProduction]);
 const pdfPages=useMemo(()=>[...new Map(allRows.flatMap(r=>r.pdf?[[r.pdf.key,r.pdf] as const]:[])).values()].sort((a,b)=>a.page-b.page||a.key.localeCompare(b.key)),[allRows]);
 const genericPaper=allRows.some(row=>row.kind==="paper"&&!row.pdf);
 const hasDaily=allRows.some(row=>row.kind!=="paper");
 const showTranscript=genericPaper&&(hasDaily||pdfPages.length>0);
 const visibleMode=(mode==="pdf"&&!pdfPages.length)||(mode==="transcript"&&!showTranscript)?"continuous":mode;
 const pageKey=pdfPages.some(p=>p.key===pdfPage)?pdfPage:pdfPages[0]?.key??"";
 const rows=useMemo(()=>browseRows(browseUniverse(allRows,visibleMode,pdfPages.length>0),visibleMode,sort,descending,query,pageKey),[allRows,visibleMode,sort,descending,query,pageKey,pdfPages.length]);
 const thumbTargets=useMemo(()=>{
   const map=new Map<string,ThumbCell>(),digest=projection?.index_sha256;
   if(!digest)return map;
   for(const g of projection.sync_groups)for(const c of g.sources){
     if(c.connection!=="linked")continue;
     map.set(thumbKey(g.group_id,c.camera),{rowId:g.group_id,digest,identity:{group_id:g.group_id,camera:c.camera,clip_id:c.clip_id,media_id:c.media_id}});
   }
   return map;
 },[projection?.sync_groups,projection?.index_sha256]);
 const thumbs=useSlateThumbnails(sheet,thumbTargets,JSON.stringify([visibleMode,pageKey,sort,descending,query]),sheetFirst?.thumbnail);
 const withThumbnails=useMemo(()=>{
   if(!thumbs.size)return rows;
   return rows.map(row=>{
     if(!row.media)return row;
     const images=cameras.flatMap(camera=>{
       const url=thumbs.get(thumbKey(row.id,camera)), item=row.media?.[camera];
       return url&&item?.state==="linked"?[[camera,{...item,thumbnailUrl:url}] as const]:[];
     });
     return images.length?{...row,media:{...row.media,...Object.fromEntries(images)}}:row;
   });
 },[rows,thumbs]);
 function jumpPaperHint(groupId:string){
   const sync=allRows.find(r=>r.id===groupId);
   const source=projection?.paper_suggestions?.groups[groupId]?.source;
   if(!sync?.paperHint||!source)return;
   const exact=allRows.find(r=>r.id===source.paper_row_id&&r.digest===source.row_digest&&r.pdf?.key===JSON.stringify([source.pdf_sha256,source.pdf_page]));
   if(!exact?.pdf)return;
   setPdfPage(exact.pdf.key);setQuery("");chooseMode("pdf");setPaperLocated(exact.id);
 }
 useEffect(()=>{
   if(!paperLocated||visibleMode!=="pdf")return;
   const exact=[...(sheet.current?.querySelectorAll<HTMLTableRowElement>("tr[data-slate-row]")??[])].find(r=>r.dataset.slateRow===paperLocated);
   exact?.querySelector<HTMLButtonElement>("button")?.focus({preventScroll:true});
   exact?.scrollIntoView?.({block:"nearest"});
 },[paperLocated,visibleMode,pageKey]);
 const currentRow=active&&allRows.find(r=>r.id===active.rowId&&r.digest===active.digest);
 const current=currentRow?active:undefined;
 const selectedField=current&&currentRow?.kind==="sync"?getTargetField(current.field):undefined;
 const fieldReading=selectedField&&currentRow&&currentRow.fieldReview?.[current!.field]?.editable?projection?.paper_field_annotations?.[currentRow.id]?.[selectedField]:undefined;
 const validAnnotatedValue=selectedField==="scene"?/^[1-9][0-9]{0,5}-[1-9][0-9]{0,5}$/.test(manualCell.trim()):/^[0-9]{1,9}$/.test(manualCell.trim());
 const selectedHidden=!!current&&!rows.some(r=>r.id===current.rowId&&r.digest===current.digest);
 useEffect(()=>{
   if(!current||selectedHidden)return;
   const id=requestAnimationFrame(()=>{
      const row=[...(sheet.current?.querySelectorAll<HTMLTableRowElement>("tr[data-slate-row]")??[])].find(item=>item.dataset.slateRow===current.rowId);
      row?.scrollIntoView?.({block:"nearest",inline:"nearest"});
   });
   return ()=>cancelAnimationFrame(id);
 },[visibleMode,sort,descending,pageKey]);
 const framingRow=framing&&allRows.find(r=>r.id===framing.rowId&&r.digest===framing.digest);
 const framingCamera=framing?.camera;
 const framingAvailable=!!(framingCamera&&framing&&framingRow&&framing.field===`cameras.${framingCamera}.framing_raw`&&
   selectPaperFormTargets({rowId:framing.rowId,digest:framing.digest,camera:framingCamera},ledger.snapshot.rows)
     .source?.cameraChoices?.some(c=>c.status==="literal"));
 const commitFraming=async(tag:string,add_custom:boolean)=>{
   if(!framingControl||!framingAvailable||!framing||!framingCamera)throw Error("请选择有效机位");
   return framingControl.set({paper_row_id:framing.rowId,row_digest:framing.digest,camera:framingCamera,tag,add_custom});
 };
 function closeFraming(){setFraming(undefined);if(framing?.anchor.isConnected)framing.anchor.focus();}

 const sourceMode=current?.mode==="source";
 const editableScene=current?.field==="scene_raw";
 const syncSource=sourceMode&&currentRow?.kind==="sync"&&current?.camera
   ? sourceLookup.get(current.rowId)?.sources.find(cam=>cam.camera===current.camera) : undefined;
 const resolve=current&&currentRow?.kind==="paper"&&(sourceMode||editableScene)?selectPaperFormTargets({
   rowId:current.rowId,digest:current.digest,camera:sourceMode?current.camera:undefined,
 },ledger.snapshot.rows):undefined;
 const intervals=resolve?.intervals??[];
 const prepared=intervals.find(r=>r.interval?.evidence.evidence_id===ledger.focusEvidenceId);
 const selected=intervals.find(r=>r.id===intervalId)??(intervalId==="$source"?undefined:intervals.length===1?intervals[0]:undefined);
 useEffect(()=>{
   if(prepared&&intervalId==="$source")chooseInterval(prepared.id);
 },[prepared?.id]);
 useEffect(()=>{if(current)detail.current?.focus()},[current]);
 function close(){
   setActive(undefined);chooseInterval("");
   if(activeAnchor.current?.isConnected)activeAnchor.current.focus();
 }
 function reveal(){
   setQuery("");
   if(currentRow?.pdf){setPdfPage(currentRow.pdf.key);chooseMode("pdf");}
   else if(currentRow?.kind==="paper"&&showTranscript)chooseMode("transcript");
   else chooseMode("continuous");
   requestAnimationFrame(()=>{
      const exact=[...(sheet.current?.querySelectorAll<HTMLTableRowElement>("tr[data-slate-row]")??[])].find(r=>r.dataset.slateRow===active?.rowId);
      const anchor=exact?.querySelector<HTMLButtonElement>('button[aria-current="true"]')??exact?.querySelector<HTMLButtonElement>("button");
      if(anchor){activeAnchor.current=anchor;anchor.focus({preventScroll:true});anchor.scrollIntoView?.({block:"nearest",inline:"nearest"});}
   });
 }
 async function addManual(){
   if(!sheetFirst||saving||!manualFields)return;
   const fields=Object.fromEntries(Object.entries(manualFields).map(([k,v])=>[k,v.trim()]).filter(([,v])=>v));
   if(!Object.keys(fields).length)return;
   setSaving(true);setManualError("");
   try{await sheetFirst.add(fields,manualRequest.current);setManualFields(undefined);setActive(undefined);setMode("continuous");setQuery("");
   }catch{setManualError("新增未确认，请重读后再试；输入已保留。");}
   finally{setSaving(false);}
 }
 async function writeManualCell(){
   if(!sheetFirst?.edit||currentRow?.kind!=="manual"||!current||saving)return;
   setSaving(true);setEditError("");
   try{await sheetFirst.edit({row_id:current.rowId,field:current.field,value:manualCell.trim()});close();}
   catch{setEditError("编辑未确认，请重读后再试；输入已保留。");}
   finally{setSaving(false);}
 }
 async function saveAnnotatedField(mode:PaperAnnotationRequest["mode"]){
   if(mode==="manual"&&!validAnnotatedValue)return;
   if(!sheetFirst?.annotate||!current||!selectedField||!fieldReading||fieldReading.state==="needs_review"||saving)return;
   setSaving(true);setEditError("");
   try{
     const reading=await sheetFirst.annotate({group_id:current.rowId,field:selectedField,expected_token:fieldReading.token,
         expected_revision:fieldReading.revision,mode,value:mode==="manual"?manualCell.trim():null});
     if(reading.state==="needs_review")setEditError("同步结果已变化。此前操作保留为历史，当前表没有填值。");
     else setManualCell(reading.value??"");
   }catch{setEditError("记录或同步结果已变化，未确认写入。请重新核对这格。");}
   finally{setSaving(false);}
 }
 const none=intervals.length===0 || intervalId==="$source";
 return <section ref={sheet} aria-label="原场记表">
   <div className="slate-browse-tools" role="group" aria-label="场记浏览、排序与查找">
    <span className="slate-browse-label">浏览与查找</span>
    <label>浏览<select value={visibleMode} onChange={e=>chooseMode(e.target.value as BrowseMode)}>
      <option value="continuous">连续</option><option value="scene">按集场</option>{pdfPages.length>0&&<option value="pdf">PDF 原页</option>}{showTranscript&&<option value="transcript">未标原页的转录</option>}
    </select></label>
    {visibleMode==="pdf"?<>
      <label>原页<select value={pageKey} onChange={e=>{setPdfJumpMessage("");setPdfPage(e.target.value);}}>
        {pdfPages.map((page,i)=><option value={page.key} key={page.key}>PDF 第 {page.page} 页{pdfPages.some(p=>p.key!==page.key&&p.page===page.page)?` · 来源 ${i+1}`:""}</option>)}
      </select></label>
      <form className="slate-pdf-jump" onSubmit={e=>{
        e.preventDefault();
        const target=/^[0-9]{1,3}$/.test(pdfJump.trim())?Number(pdfJump):0;
        const candidates=pdfPages.filter(p=>p.page===target);
        const origin=(key:string)=>key.slice(0,key.lastIndexOf(","));
        const next=candidates.find(p=>origin(p.key)===origin(pageKey))??(candidates.length===1?candidates[0]:undefined);
        if(next){setPdfPage(next.key);setQuery("");setPdfJump("");setPdfJumpMessage("");}
        else setPdfJumpMessage(candidates.length?"有多个来源，请在原页列表选择。":"没有这页的转录。");
      }}>
        <label>跳到 PDF 页<input inputMode="numeric" size={4} value={pdfJump} onChange={e=>setPdfJump(e.target.value)} /></label>
        <button type="submit">跳转</button>
        {pdfJumpMessage&&<small role="status">{pdfJumpMessage}</small>}
      </form>
    </>:<>
    <label>排序<select value={sort} onChange={e=>setSort(e.target.value as SortKind)}>
      <option value="source">素材顺序</option><option value="clip">片号</option><option value="scene">集场镜次</option>
      <option value="A">A 机片号</option><option value="B">B 机片号</option><option value="C">C 机片号</option>
    </select></label>
    <button type="button" aria-label="切换升降序" onClick={()=>setDescending(value=>!value)}>{descending?"降序 ↓":"升序 ↑"}</button>
    <button type="button" onClick={()=>{setSort("source");setDescending(false);}}>还原</button>
    </>}
    <label>查找片号<input type="search" placeholder="短片号、卡号或完整文件名" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    <small>{rows.length} / {browseUniverse(allRows,visibleMode,pdfPages.length>0).length} 行</small>
   </div>
   {selectedHidden&&<p role="status">所选行不在当前视图，当前选择未变。 <button type="button" onClick={reveal}>显示所选行</button></p>}
   {visibleMode!=="pdf"&&pdfPages.length>0&&<p className="slate-sheet-sync-caption">已核 PDF 来源：{pdfPages.length} 页、{allRows.filter(row=>row.pdf).length} 条原页记录。
      <button type="button" onClick={()=>{setQuery("");chooseMode("pdf");}}>按 PDF 原页复核</button></p>}
   {visibleMode==="pdf"&&<p className="slate-sheet-sync-caption">按 PDF 物理页和原始行序浏览。未关联的纸行仍在，不自动写入场、镜或次数。</p>}
   {query.trim()&&!rows.length&&<p role="status">没有匹配的片号。</p>}
   {projection?.sync_groups.length? <p className="slate-sheet-sync-caption">同步素材 {projection.sync_groups.length} 组{projection.sync_group_count>projection.sync_groups.length?"（部分）":""}；场次和镜次未确认时留空。</p>:null}
   {projection?.sync_groups.some(g=>g.sources.some(c=>c.connection==="not_connected"))&&ledger.onOpenMediaBinding&&
     <button type="button" className="slate-sheet-connect" onClick={event=>ledger.onOpenMediaBinding?.(event.currentTarget)}>连接本机素材</button>}
   {manualFields&&<form aria-label="新增手工场记行" className="slate-manual-entry" onSubmit={e=>{e.preventDefault();void addManual();}}>
     <div>{MANUAL_FIELDS.map(([key,label])=><label key={key}>{label}<input value={manualFields[key]??""} maxLength={240} onChange={e=>setManualFields({...manualFields,[key]:e.target.value})}/></label>)}</div>
     <button type="submit" disabled={saving||!Object.values(manualFields).some(v=>v.trim())}>保存这行</button>
     <button type="button" disabled={saving} onClick={()=>{setManualFields(undefined);setManualError("");}}>取消</button>
     {manualError&&<p role="alert">{manualError}</p>}
   </form>}
   <div className="slate-form-stage" data-inspecting={!!current||undefined}><div className="slate-form-paper-area"><SlateOriginalFormSheet page={{day:"",date:"",printedPage:visibleMode==="pdf"?String(pdfPages.find(p=>p.key===pageKey)?.page??""):"",title:title?.trim()||""}} rows={withThumbnails} onReview={onReview} onPaperHint={jumpPaperHint} highlightRow={visibleMode==="pdf"?paperLocated:undefined}
     pendingCount={ledger.snapshot.rows.filter(r=>!r.interval?.current||!r.verified).length}
     canEditFraming={!!framingControl} activeSource={current?.camera&&sourceMode?{rowId:current.rowId,digest:current.digest,camera:current.camera}:undefined} onAddRow={sheetFirst?()=>{manualRequest.current=crypto.randomUUID().replaceAll("-","");setManualFields({});}:undefined} addRowBusy={saving}
     onCellAction={action=>{if(action.mode==="framing"&&allRows.find(row=>row.id===action.rowId)?.kind==="paper"){setFraming(action);return;}setFraming(undefined);activeAnchor.current=action.anchor;chooseInterval("");const target=getTargetField(action.field);
       if(target&&onOpenProduction&&allRows.some(row=>row.id===action.rowId&&row.digest===action.digest&&row.kind==="sync")&&productionRows?.has(action.rowId)&&!projection?.paper_field_annotations?.[action.rowId]?.[target]){
         onOpenProduction({groupId:action.rowId,field:target});return;
       }
       const prior=target?projection?.paper_field_annotations?.[action.rowId]?.[target]:undefined;
       setManualCell(prior&&prior.state!=="needs_review"?prior.value??"":action.raw);setEditError("");setActive(action);}}/>
     {framing&&framingControl&&framingRow&&<div className="slate-framing-sheet-slot">
      {framingAvailable&&framingCamera?<SlateFramingPicker key={JSON.stringify([framing.rowId,framing.digest,framingCamera])}
        label={`第 ${framing.line} 行 · ${framingCamera} 机景别`} original={framing.raw} currentId={framingRow.framing?.[framingCamera]}
        catalog={framingControl.model.catalog.map((tag,index)=>({id:tag,label:tag,custom:index>=5}))}
        onApply={tag=>commitFraming(tag,false)} onAddCustom={tag=>commitFraming(tag,true)} onClose={closeFraming}/>:
        <div role="status">这格没有明确的机位文件号，先核实来源。<button type="button" onClick={closeFraming}>返回表格</button></div>}
     </div>}</div>
   {current&&<section className="slate-form-detail" aria-label="当前场记格" tabIndex={-1} ref={detail} onKeyDown={e=>{if(e.key==="Escape"&&!e.defaultPrevented)close();}}>
      <header className="slate-form-pagination"><strong>第 {current.line} 行{sourceMode&&current.camera?` · ${current.camera} 机`:""}</strong><button type="button" onClick={close}>返回表格</button></header>
      <p>{currentRow?.kind==="manual"?"手工录入":currentRow?.kind==="sync"?"已同步素材":"原始转录"}：{current.raw||"空白"}</p>
      {currentRow?.pdf&&visibleMode!=="pdf"&&<button type="button" onClick={()=>{setQuery("");setPdfPage(currentRow.pdf!.key);chooseMode("pdf");}}>
         去 PDF 第 {currentRow.pdf.page} 页</button>}
      {selectedField&&fieldReading&&fieldReading.state!=="needs_review"&&sheetFirst?.annotate?<form aria-label="核对当前场记字段" onSubmit={e=>{e.preventDefault();void saveAnnotatedField("manual");}}>
         <p>{FIELD_NAMES[selectedField]} · {fieldReading.state==="suggested"?"未确认":fieldReading.state==="adopt"?"已确认纸记":fieldReading.state==="manual"?"人工更正":"已清空"}</p>
         <button type="button" onClick={()=>jumpPaperHint(current.rowId)}>查看 PDF 第 {fieldReading.source.pdf_page} 页 · 第 {fieldReading.source.row_index} 行</button>
         {fieldReading.state==="suggested"&&<button type="button" disabled={saving} onClick={()=>void saveAnnotatedField("adopt")}>采用这格的建议：{fieldReading.suggestion}</button>}
         <label>人工更正<input value={manualCell} maxLength={selectedField==="scene"?13:9} onChange={e=>setManualCell(e.target.value)} placeholder={selectedField==="scene"?"如 19-1":"输入数字"}/></label>
         <button type="submit" disabled={saving||!validAnnotatedValue}>保存更正</button>
         {fieldReading.state!=="clear"&&<button type="button" disabled={saving} onClick={()=>void saveAnnotatedField("clear")}>清空这格</button>}
         <small>只保存这格场记，不改纸记、素材或交付。</small>
         {editError&&<p role="alert">{editError}</p>}
      </form>:selectedField&&currentRow?.fieldReview?.[current.field]?.label==="待复核"?<p role="status">{editError||"同步结果或原页证据已变化，旧值保留为历史，未用于当前场记。"}</p>:
      currentRow?.kind==="manual"&&sheetFirst?.edit?<form aria-label="编辑手工场记格" onSubmit={e=>{e.preventDefault();void writeManualCell();}}>
        <label>手工录入<input value={manualCell} maxLength={240} onChange={e=>setManualCell(e.target.value)}/></label>
        <button type="submit" disabled={saving||manualCell.trim()===current.raw}>保存这格</button>
        {editError&&<p role="alert">{editError}</p>}
      </form>:syncSource&&baseUrl&&projectId?<><section className="slate-source-pane" aria-label="原片预览">
        <h3>原片预览</h3>
        {syncSource.connection==="linked"?<SlateOriginalPlayback key={JSON.stringify([current.rowId,syncSource.camera,syncSource.clip_id,syncSource.media_id])}
          baseUrl={baseUrl} projectId={projectId} startOpen playOnSelect registeredOnly source={{clipId:syncSource.clip_id,mediaId:syncSource.media_id,selectionKey:current.digest}}/>:
          <p role="status">这一机位尚未连接本机原片。</p>}
      </section>
      <section className="slate-source-pane" aria-label="素材详情">
        <h3>素材详情</h3><p>{syncSource.file_name??syncSource.label}</p>
        {syncSource.connection==="linked"&&productionRows?.has(current.rowId)&&onOpenProduction&&<button type="button" onClick={()=>{
          const video=detail.current?.querySelector<HTMLVideoElement>(".sil-original-playback video");
          const sourceTime=video&&video.readyState>=1&&Number.isFinite(video.currentTime)&&video.currentTime>=0?video.currentTime:undefined;
          video?.pause();
          onOpenProduction({groupId:current.rowId,clipId:syncSource.clip_id,mediaId:syncSource.media_id,sourceTime});
        }}>在生产场记中标记</button>}
        <details><summary>技术信息</summary><small>片段 ID：{syncSource.clip_id}<br/>素材 ID：{syncSource.media_id}</small></details>
        {sheetFirst?.angle&&<SyncAngleAnnotationPanel key={JSON.stringify([current.rowId,syncSource.clip_id,syncSource.media_id,syncSource.camera,current.digest,syncSource.connection])}
          target={{group_id:current.rowId,clip_id:syncSource.clip_id,media_id:syncSource.media_id,camera:syncSource.camera}} run={sheetFirst.angle}/>}
        <small>标注只写这一机位，不填写场号、镜号或次数。</small>
      </section>

      </>:resolve?<>
       {(intervals.length>1||sourceMode&&intervals.length>0)&&<label>核对区间 <select value={selected?.id??intervalId} onChange={e=>chooseInterval(e.target.value)}>
         <option value="" disabled>选择区间</option>
         {intervals.map(r=><option key={r.id} value={r.id}>{r.paperSourceCamera?`${r.paperSourceCamera} 机 · `:""}{r.interval?.clipLabel} · {r.interval?.start}–{r.interval?.endExclusive? r.interval.endExclusive-1:0}</option>)}
         {sourceMode&&<option value="$source">匹配本机位原片</option>}
       </select></label>}
       {selected?<SlateIntervalLedger key={selected.id} {...ledger} inspectionOnly snapshot={{...ledger.snapshot,rows:[selected]}}/>:
        none&&resolve.source?<SlateIntervalLedger key={resolve.source.id} {...ledger} inspectionOnly snapshot={{...ledger.snapshot,rows:[resolve.source]}}/>:null}
       {!resolve.source&&!intervals.length&&<p>未读到对应记录，重读表格后再试。</p>}
       {intervals.length>1&&!selected&&!none&&<p>这行已记录多个原片区间。请明确选中一个，不会自动套到其它机位。</p>}
      </>:<p>这格没有已确认的原片关联；同步格只看片，未同步的手工记录不会自动匹配。</p>}
   </section>}</div>
 </section>;
}
