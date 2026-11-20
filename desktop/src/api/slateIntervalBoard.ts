import { invoke, isTauri } from "@tauri-apps/api/core";
import { isPaperCamera } from "./paperCellReview";
import type { ElectronicSourceSelection, SourceCandidates, SourceCandidate } from "./paperSourceContext";
import type { PaperModel } from "./paperIntake";
import type { ApproveCorrection, LedgerRow, LedgerSnapshot, SceneChoice, StageCorrection, SelectedEvidence } from "../features/slate/SlateIntervalLedger";

type IntegerPage = number|string|null;
type BoardRow = { kind:"interval"|"paper_only"; evidence_id?:string; paper_row_id?:string|null; document_digest?:string|null; page?:IntegerPage; row?:IntegerPage; existing_scene?:string; filename?:string; camera?:string; review_reasons?:string[];
 camera_cells?:unknown; paper_source_camera?:unknown; paper_row_digest?:string|null; descriptor_state?:"prepared"|"missing_or_stale"; assignment?:SceneChoice|null; draft?:LedgerRow["draft"]|null; clip_id?:string; media_id?:string; asset_revision?:string; expected_evidence_version?:number; expected_evidence_sha256?:string;
 source_fps?:{numerator:number;denominator:number}; source_start_frame?:number; source_end_frame?:number; classification_pending?:boolean; review_state?:"proposal"|"human_verified"};
type BoardPage={workspace_scope?:string;revision:number;draft_revision:number;paper_revision:number;index_sha256:string;rows:BoardRow[];total:number;next_offset:number|null};
type Request = Record<string,unknown>;
type Response<T>={ok:boolean;data?:T;error?:{code:string;message:string}};
type NativeBridge = <T>(request:Request)=>Promise<Response<T>>;
const nativeBridge:NativeBridge=async (request)=>{if(!isTauri())throw new Error("电子场记板仅在桌面本机可用");return invoke("scene_interval_review",{request});};
export const nativeManagedBoardBridge=(baseUrl:string):NativeBridge=>async request=>{
   const host=baseUrl.replace(/\/+$/,"");
   if(!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(host)) throw new Error("电子场记板只能使用当前受管的本机工作区");
   return nativeBridge({...request,expected_managed_base:host});
};
const nonnegative=(n:unknown):n is number => Number.isSafeInteger(n) && (n as number)>=0;
const ordinal=(n:IntegerPage|undefined)=>{
 const v=typeof n==="string"&&/^\d+$/.test(n)?Number(n):n;
 return typeof v==="number"&&nonnegative(v)?v:0;
};
const digest=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{64}$/.test(v);
function cameraChoices(row:BoardRow):LedgerRow["cameraChoices"]{
 if(!Array.isArray(row.camera_cells)||!digest(row.paper_row_digest))return [];
 const seen=new Set<string>();
 return row.camera_cells.flatMap((c)=>{
   if(!c || !isPaperCamera(c.camera) || seen.has(c.camera) || c.raw_cell!==`/cameras/${c.camera}/clip_raw` || typeof c.raw_code!=="string" ||
      !["literal","needs_review"].includes(c.status))return [];
   seen.add(c.camera);
   return [{camera:c.camera,rawCell:c.raw_cell,rawCode:c.raw_code,rowDigest:row.paper_row_digest!,status:c.status}];
 });
}
function locator(row:BoardRow){return row.kind==="interval"?typeof row.evidence_id==="string"?`interval:${row.evidence_id}`:"":typeof row.paper_row_id==="string"?`paper:${row.paper_row_id}`:"";}
function choice(pair?:SceneChoice|null): SceneChoice|undefined {return pair && nonnegative(pair.episode)&&pair.episode>0&&typeof pair.scene_id==="string"&&pair.scene_id.trim() ? pair : undefined;}
function selection(input:Partial<SelectedEvidence>):SelectedEvidence|undefined {
 const {evidence_id,expected_evidence_version,expected_evidence_sha256}=input;
 return typeof evidence_id==="string"&&evidence_id.length>0&&nonnegative(expected_evidence_version)&&digest(expected_evidence_sha256)?{evidence_id,expected_evidence_version,expected_evidence_sha256}:undefined;
}

export type SyncAngleIdentity={group_id:string;clip_id:string;media_id:string;camera:"A"|"B"|"C"};
export type SyncAngleFields={shot_type?:string;note?:string};
export type SyncAngleReceipt={contract:"mirrororder.sync_angle_annotations.v1";workspace_scope:string;index_sha256:string;
 target:SyncAngleIdentity;revision:number|null;anchor:string|null;editable:boolean;reason:string|null;
 annotation:{annotation_id:string;shot_type:string;note:string;annotation_state:"saved"|"cleared"}|null;
 editorial_authority:false;checks_current_original_bytes:boolean};
export type SheetManualEdit={row_id:string;field:string;value:string};
export type PaperFieldSuggestion={state:"paper_suggestion"|"source_only";fields:Partial<Record<"scene"|"shot"|"take",{state:"suggested";value:string}|{state:"conflict";paper_value:string}>>;source:{pdf_sha256:string;pdf_page:number;row_index:number;paper_row_id:string;row_digest:string};human_confirmed:false;source_interval_verified:false};
export type PaperAnnotationField="scene"|"shot"|"take";
export type PaperAnnotationReading={state:"needs_review"}|{state:"suggested"|"adopt"|"manual"|"clear";token:string;revision:number;value?:string|null;suggestion:string;source:PaperFieldSuggestion["source"]};
export type PaperAnnotationRequest={group_id:string;field:PaperAnnotationField;expected_token:string;expected_revision:number;mode:"adopt"|"manual"|"clear";value:string|null};
export type SlateThumbnailTarget={group_id:string;clip_id:string;media_id:string;camera:"A"|"B"|"C"};
type SlateThumbnailReceipt={contract:"mirrororder.slate_thumbnail.v1";workspace_scope:string;request_id:string;policy:string;target:SlateThumbnailTarget;mime:string;jpeg:string;cache_hit:boolean};
export type SheetFirstModel={contract:"mirrororder.sheet_first.v1";workspace_scope:string;index_sha256:string;revision:number;
 manual_rows:{row_id:string;sequence:number;fields:Record<string,string>}[];
 sync_groups:{group_id:string;sources:{camera:"A"|"B"|"C";clip_id:string;media_id:string;label:string;connection?:"linked"|"not_connected";file_name?:string}[]}[];
 sync_group_count:number;paper_field_annotations?:Record<string,Partial<Record<PaperAnnotationField,PaperAnnotationReading>>>;paper_suggestions?:{contract:"mirrororder.paper_field_suggestions.v1";editorial_authority:false;paper_revision:number;groups:Record<string,PaperFieldSuggestion>};sync_angle_edit?:{contract:"mirrororder.sync_angle_annotations.v1";available:boolean;max_note_length:number}};
export type SlateFramingModel={contract:"mirrororder.framing_tags.v1";workspace_scope:string;paper_revision:number;revision:number;catalog:string[];tags:{paper_row_id:string;row_digest:string;camera:ElectronicSourceSelection["camera"];tag:string}[]};
export type SlateFramingSet={paper_row_id:string;row_digest:string;camera:ElectronicSourceSelection["camera"];tag:string;add_custom:boolean};
export type BoardSourceFence = { expected_scope:string; paper_row_id:string; row_digest:string; expected_paper_revision:number; nested_camera:ElectronicSourceSelection["camera"] };
export type BoardSourceCandidates = SourceCandidates & {status:string;camera_conflict?:boolean;original_document_verified:false};
export type BoardSourceLink = {binding_id:string;revision:number;source_context_revision:number;expected_selection_revision:0;basis:"operator_selected_electronic_cell";interval_confirmed:false;exact_take_confirmed:false};
export const SOURCE_TRIAGE_TIERS=["empty","uncertain","not_indexed","single_indexed","multi_card","same_card_collision"] as const;
export type SourceTriageTier=(typeof SOURCE_TRIAGE_TIERS)[number];
export type SourceTriageCard={card:string;occurrence_count:number;registered_count:number};
export type SourceTriageCell={camera:ElectronicSourceSelection["camera"];tier:SourceTriageTier;cards:SourceTriageCard[]};
export type SourceTriageRow={paper_row_id:string;row_digest:string;cells:SourceTriageCell[]};
export type SourceTriage={contract:"mirrororder.source_triage.v1";workspace_scope:string;paper_revision:number;index_sha256:string;rows:SourceTriageRow[]};
export class SlateIntervalBoardClient {
 constructor(private readonly bridge:NativeBridge=nativeBridge){}
 private async call<T>(projectId:string, action:string, fields:Request={}){
   if(!projectId.trim()) throw new Error("场记板需要已选项目");
   const reply=await this.bridge<T>({...fields,action,project_id:projectId});
   if(reply?.ok!==true || !reply.data) throw new Error(reply?.error?.message || "未能读取本机区间场记");
   return reply.data;
 }
 async read(projectId:string,stillCurrent:()=>boolean=()=>true){
   const rows:BoardRow[]=[];const seen=new Set<string>();let root:Omit<BoardPage,"rows"|"next_offset">|undefined;
   let offset=0;
   while (true) {
     if(!stillCurrent()) throw new Error("项目已切换");
     const fields=root?{offset,expected_revision:root.revision,expected_draft_revision:root.draft_revision,expected_paper_revision:root.paper_revision,expected_index_sha256:root.index_sha256}:{};
     const page=await this.call<BoardPage>(projectId,"board_read",fields);
     if(!nonnegative(page.revision)||!nonnegative(page.draft_revision)||!nonnegative(page.paper_revision)||!digest(page.index_sha256)||!nonnegative(page.total)||page.total>4000||!Array.isArray(page.rows)||page.rows.length>40) throw new Error("场记列表格式异常");
     if(root && (root.revision!==page.revision||root.draft_revision!==page.draft_revision||root.paper_revision!==page.paper_revision||root.index_sha256!==page.index_sha256||root.total!==page.total||root.workspace_scope!==page.workspace_scope)) throw new Error("场记列表读取期间已变化，请重读");
     root??={workspace_scope:page.workspace_scope,revision:page.revision,draft_revision:page.draft_revision,paper_revision:page.paper_revision,index_sha256:page.index_sha256,total:page.total};
     for(const row of page.rows){
       if(!row||!["interval","paper_only"].includes(row.kind)||!locator(row)||seen.has(locator(row)))throw new Error("场记行身份重复或未识别");
       seen.add(locator(row));rows.push(row);
     }
     if(page.next_offset===null){if(rows.length!==page.total || !stillCurrent())throw new Error("场记列表未完整读取");return {...root,rows};}
     if(!nonnegative(page.next_offset)||!page.rows.length||page.next_offset!==offset+page.rows.length||page.next_offset>=page.total)throw new Error("场记列表缺页");
     offset=page.next_offset;
   }
 }
 async sourceTriage(projectId:string,scope:string,paperRevision:number,indexSha256:string):Promise<SourceTriage>{
   const response=await this.call<SourceTriage>(projectId,"board_source_triage",{expected_scope:scope,expected_paper_revision:paperRevision,expected_index_sha256:indexSha256});
   if(response.contract!=="mirrororder.source_triage.v1"||response.workspace_scope!==scope||response.paper_revision!==paperRevision||response.index_sha256!==indexSha256||!Array.isArray(response.rows)||response.rows.length>4000)throw Error("来源速览版本不一致");
   const rows=new Set<string>();
   for(const row of response.rows){
     if(!row||typeof row.paper_row_id!=="string"||!row.paper_row_id||!digest(row.row_digest)||rows.has(row.paper_row_id)||!Array.isArray(row.cells)||row.cells.length>3)throw Error("来源速览行不一致");
     rows.add(row.paper_row_id);
     const cameras=new Set<string>();
     for(const cell of row.cells){
       if(!cell||!isPaperCamera(cell.camera)||cameras.has(cell.camera)||!SOURCE_TRIAGE_TIERS.includes(cell.tier)||!Array.isArray(cell.cards)||cell.cards.length>1000)throw Error("来源速览机位不一致");
       cameras.add(cell.camera);
       const cards=new Set<string>();
       for(const card of cell.cards){
         if(!card||typeof card.card!=="string"||!new RegExp("^"+cell.camera+"[0-9]{3}$").test(card.card)||cards.has(card.card)||
           !nonnegative(card.occurrence_count)||card.occurrence_count===0||!nonnegative(card.registered_count)||card.registered_count>card.occurrence_count)throw Error("来源速览卡号不一致");
         cards.add(card.card);
       }
     }
   }
   return response;
 }
 async slateThumbnail(projectId:string,workspaceScope:string,indexSha256:string,target:SlateThumbnailTarget,managedBase:string,signal:AbortSignal){
   const host=managedBase.replace(/\/+$/,"");
   if(signal.aborted||!isTauri()||!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(host))throw new Error("本机缩略图不可用");
   const requestId=crypto.randomUUID().replaceAll("-","");
   function cancel(){void invoke("slate_thumbnail_cancel",{requestId,expectedManagedBase:host}).catch(()=>{});}
   signal.addEventListener("abort",cancel,{once:true});
   try{
     const r=await this.call<SlateThumbnailReceipt>(projectId,"board_slate_thumbnail",{...target,request_id:requestId,expected_scope:workspaceScope,expected_index_sha256:indexSha256});
     if(signal.aborted||r.contract!=="mirrororder.slate_thumbnail.v1"||r.workspace_scope!==workspaceScope||r.request_id!==requestId||
       r.policy!=="first-visible-frame-in-initial-second.v1"||r.mime!=="image/jpeg"||Object.keys(target).some(key=>r.target?.[key as keyof SlateThumbnailTarget]!==target[key as keyof SlateThumbnailTarget])||
       typeof r.jpeg!=="string"||r.jpeg.length>200_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(r.jpeg))throw new Error("本机缩略图已变化");
     const raw=atob(r.jpeg),bytes=Uint8Array.from(raw,ch=>ch.charCodeAt(0));
     if(bytes.length<26||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw new Error("本机缩略图无法读取");
     return new Blob([bytes],{type:"image/jpeg"});
   }finally{signal.removeEventListener("abort",cancel);}
 }
 async paperAnnotation(projectId:string,workspaceScope:string,indexSha256:string,body:PaperAnnotationRequest){
   const reply=await this.call<{workspace_scope:string;group_id:string;field:PaperAnnotationField;reading:PaperAnnotationReading;editorial_authority:false}>(projectId,"board_paper_field_set",{...body,expected_scope:workspaceScope,expected_index_sha256:indexSha256});
   if(reply.workspace_scope!==workspaceScope||reply.group_id!==body.group_id||reply.field!==body.field||reply.editorial_authority!==false||!reply.reading||
      reply.reading.state!=="needs_review"&&(reply.reading.state!==body.mode||reply.reading.token!==body.expected_token||reply.reading.revision!==body.expected_revision+1))throw new Error("未收到这格的保存回执");
   return reply.reading;
 }
 async sheetFirst(projectId:string,workspaceScope:string,indexSha256:string,mutation?:({expected_sheet_revision:number;request_id:string;fields:Record<string,string>}|{expected_sheet_revision:number;signedEdit:SheetManualEdit})){
   const add=mutation&&"fields" in mutation?mutation:undefined;
   const edit=mutation&&"signedEdit" in mutation?mutation:undefined;
   const fields=edit?{...edit.signedEdit,expected_sheet_revision:edit.expected_sheet_revision}:add;
   const result=await this.call<SheetFirstModel>(projectId,edit?"board_sheet_edit":add?"board_sheet_add":"board_sheet_read",{...fields,expected_scope:workspaceScope,expected_index_sha256:indexSha256});
   if(result.contract!=="mirrororder.sheet_first.v1"||result.workspace_scope!==workspaceScope||result.index_sha256!==indexSha256||
     !nonnegative(result.revision)||!Array.isArray(result.manual_rows)||result.manual_rows.length>1200||
     !nonnegative(result.sync_group_count)||!Array.isArray(result.sync_groups)||result.sync_groups.length>1200||result.sync_groups.length>result.sync_group_count)throw Error("场记表内容版本不一致");
   if(new Set(result.manual_rows.map(r=>r?.row_id)).size!==result.manual_rows.length||result.manual_rows.some(r=>!r||!/^sheet-manual-[0-9a-f]{32}$/.test(r.row_id)||!nonnegative(r.sequence)||!r.fields||Object.values(r.fields).some(v=>typeof v!=="string")))throw Error("手工行内容异常");
   if(result.sync_groups.some(g=>!g||typeof g.group_id!=="string"||!Array.isArray(g.sources)||g.sources.length<2||g.sources.length>3||new Set(g.sources.map(c=>c?.camera)).size!==g.sources.length||
      g.sources.some(c=>!c||!isPaperCamera(c.camera)||typeof c.clip_id!=="string"||!c.clip_id||!/^M_[0-9a-f]{24}$/.test(c.media_id)||typeof c.label!=="string"||!c.label)))throw Error("同步素材关系异常");
   if(edit&&!result.manual_rows.some(r=>r.row_id===edit.signedEdit.row_id&&(r.fields[edit.signedEdit.field]??"")===edit.signedEdit.value))throw Error("没有收到指定场记格回执");
   if(add&&!result.manual_rows.some(row=>row.row_id==="sheet-manual-"+add.request_id&&Object.keys(row.fields).length===Object.keys(add.fields).length&&Object.keys(add.fields).every(k=>row.fields[k]===add.fields[k])))throw Error("没有收到新增行回执");
   return result;
 }
 async syncAngle(projectId:string,scope:string,indexSha:string,target:SyncAngleIdentity,mutation?:{receipt:SyncAngleReceipt;fields:SyncAngleFields}){
   if(mutation&&(!mutation.receipt.editable||!mutation.receipt.anchor||mutation.receipt.revision===null))throw Error("机位尚未具备可写的原片依据");
   const extras=mutation?{expected_annotation_revision:mutation.receipt.revision,expected_anchor:mutation.receipt.anchor,fields:mutation.fields}:{};
   const result=await this.call<SyncAngleReceipt>(projectId,mutation?"board_sync_angle_set":"board_sync_angle_read",
      {...target,...extras,expected_scope:scope,expected_index_sha256:indexSha});
   if(result.contract!=="mirrororder.sync_angle_annotations.v1"||result.workspace_scope!==scope||result.index_sha256!==indexSha||
      result.editorial_authority!==false||result.checks_current_original_bytes!==!!mutation||typeof result.editable!=="boolean"||
      !result.target||Object.keys(target).some(key=>result.target[key as keyof SyncAngleIdentity]!==target[key as keyof SyncAngleIdentity])||
      (result.editable&&(!result.anchor||!/^sync-angle-[a-f0-9]{64}$/.test(result.anchor)||!nonnegative(result.revision)))||
      (result.annotation!==null&&(!result.annotation||typeof result.annotation.shot_type!=="string"||typeof result.annotation.note!=="string"||result.annotation.note.length>500||
      !["saved","cleared"].includes(result.annotation.annotation_state))))throw Error("机位标注回执与当前原片不一致");
   if(mutation&&(result.anchor!==mutation.receipt.anchor||!result.annotation||
      (mutation.fields.shot_type!==undefined&&result.annotation.shot_type!==mutation.fields.shot_type)||
      (mutation.fields.note!==undefined&&result.annotation.note!==mutation.fields.note)))throw Error("未读回该机位的标注");
   return result;
 }
 async framing(projectId:string,workspaceScope:string,revision:number,set?:SlateFramingSet & {expected_tag_revision:number}){
   const model=await this.call<SlateFramingModel>(projectId,set?"board_framing_set":"board_framing_read",{...set,expected_scope:workspaceScope,expected_paper_revision:revision});
   if(model.contract!=="mirrororder.framing_tags.v1"||model.workspace_scope!==workspaceScope||model.paper_revision!==revision||!nonnegative(model.revision)||
      !Array.isArray(model.catalog)||model.catalog.length>53||model.catalog.some(t=>typeof t!=="string"||!t.trim()||t.length>48)||
      new Set(model.catalog).size!==model.catalog.length||!Array.isArray(model.tags)||model.tags.length>12000)throw Error("景别标签版本不一致");
   const cells=new Set<string>();
   for(const item of model.tags){
     const key=JSON.stringify([item?.paper_row_id,item?.row_digest,item?.camera]);
     if(!item||typeof item.paper_row_id!=="string"||!/^paper-row-[0-9a-f]{64}$/.test(item.paper_row_id)||!digest(item.row_digest)||!isPaperCamera(item.camera)||!model.catalog.includes(item.tag)||cells.has(key))throw Error("景别标签行位不一致");
     cells.add(key);
   }
   if(set&&(model.revision<set.expected_tag_revision||!model.tags.some(t=>t.paper_row_id===set.paper_row_id&&t.row_digest===set.row_digest&&t.camera===set.camera&&t.tag===set.tag)))
     throw Error("未读到这一个场记格的标签");
   return model;
 }
 sourceCandidates(projectId:string,fence:BoardSourceFence){
   return this.call<BoardSourceCandidates>(projectId,"board_source_candidates",fence);
 }
 linkSource(projectId:string,fence:BoardSourceFence,found:BoardSourceCandidates,picked:SourceCandidate){
   return this.call<BoardSourceLink>(projectId,"board_link_source",{...fence,expected_binding_revision:found.expected_binding_revision,expected_index_sha256:found.index_sha256,clip_id:picked.clip_id,media_id:picked.media_id});
 }
 stage(projectId:string,{expected_revision,expected_draft_revision,selected,mode,episode,scene_id}:StageCorrection,scope?:string){
   if(selected.length<1||selected.length>24||selected.some(row=>!selection(row)))throw new Error("请选 1–24 个完整的原片区间");
   return this.call<{revision:number;draft_revision:number;draft:{status:"review_draft";editorial_authority:false}}>(projectId,"board_stage",{expected_revision,expected_draft_revision,selected:selected.map(row=>selection(row)!),mode,episode,scene_id,...(scope?{expected_scope:scope}:{})});
 }
 approve(projectId:string,{draft_id,expected_revision,expected_draft_revision}:ApproveCorrection,scope?:string){
   return this.call<{revision:number;draft_revision:number;approved:string[];export_ready:false}>(projectId,"board_approve",{draft_id,expected_revision,expected_draft_revision,...(scope?{expected_scope:scope}:{})});
 }
 paperRead(projectId:string,workspaceScope:string,revision:number) {
   if(!digest(workspaceScope)||!nonnegative(revision))throw new Error("工作区身份已变化，请重读");
   return this.call<PaperModel>(projectId,"board_paper_read",{expected_scope:workspaceScope,expected_paper_revision:revision}).then(paper=>{
     if(paper.contract!=="mirrororder.paper_intake.v1"||paper.project_id!==projectId||paper.revision!==revision||!Array.isArray(paper.rows)||!Array.isArray(paper.documents)||!paper.summary)
       throw new Error("电子场记的工作区或版本不一致，请重读");
     return paper;
   });
 }
 paperIngest(projectId:string,workspaceScope:string,revision:number,content:string,format:"json"|"csv") {
   if(!digest(workspaceScope)||!nonnegative(revision))throw new Error("工作区身份已变化，请重读");
   return this.call<{count:number;duplicate:boolean}>(projectId,"board_paper_ingest",{expected_scope:workspaceScope,expected_paper_revision:revision,content,format});
 }
}

export function toLedgerSnapshot(board:Awaited<ReturnType<SlateIntervalBoardClient["read"]>>, paper:PaperModel): LedgerSnapshot {
 if(board.paper_revision!==paper.revision) throw new Error("电子转录与区间读取版本不一致，请重读");
 const originals=new Map(paper.rows.map(row=>[row.paper_row_id,row]));
 return {revision:board.revision,draftRevision:board.draft_revision,rows:board.rows.map(row=>{
   const original=row.paper_row_id?originals.get(row.paper_row_id):undefined;
   const originalPage=ordinal(original?.page??row.page), originalLine=ordinal(original?.row??row.row);
   const displayCells:Record<string,string>={"/scene":"场","/scene_raw":"场","/episode":"集","/episode_raw":"集","/shot":"镜","/shot_raw":"镜","/take":"次","/take_raw":"次","/notes":"备注","/notes_raw":"备注","/cameras/A/clip_raw":"A 机","/cameras/B/clip_raw":"B 机","/cameras/C/clip_raw":"C 机","/filename":"文件号","/filename_raw":"文件号"};
   const raw=original?.raw_cells.flatMap(c=>{
      const label=displayCells[c.cell],goodValue=typeof c.raw==="string"&&c.raw.trim()||typeof c.raw==="number";
      return label&&goodValue?[`${label}：${c.raw}`]:[];
   }).join(" · ")??"";
   const place={document:row.document_digest??original?.document_id??"",page:originalPage,line:originalLine,raw};
   const output:LedgerRow={id:locator(row),paper:place,paperRowId:row.paper_row_id??undefined,paperRowDigest:digest(row.paper_row_digest)?row.paper_row_digest:undefined, paperSourceCamera:row.kind==="interval"&&isPaperCamera(row.paper_source_camera)?row.paper_source_camera:undefined,cameraChoices:cameraChoices(row),legacyScene:row.existing_scene?.trim(),pendingReason:row.kind==="paper_only"?"待核对原片和具体区间":undefined};
   if(row.kind==="paper_only") return output;
   const evidence=selection(row),f=row.source_fps;
   if(!evidence||!row.clip_id||!row.media_id||!row.asset_revision||!nonnegative(row.source_start_frame)||!nonnegative(row.source_end_frame)||row.source_end_frame<=row.source_start_frame||
      !f||!nonnegative(f.numerator)||!nonnegative(f.denominator)||!f.numerator||!f.denominator)
     return {...output,pendingReason:"区间的帧位证据不完整"};
   output.interval={evidence,sourceIdentity:{clipId:row.clip_id,mediaId:row.media_id,assetRevision:row.asset_revision},clipLabel:[row.camera,row.filename].filter(Boolean).join(" · ")||"原片区间",start:row.source_start_frame,endExclusive:row.source_end_frame,fps:f.denominator===1?String(f.numerator):`${f.numerator}/${f.denominator}`,current:row.descriptor_state==="prepared"};
   if(row.review_state==="human_verified"&&!row.classification_pending) output.verified=choice(row.assignment);
   const draft=row.draft,targets=Array.isArray(draft?.targets)?draft.targets.map(selection):[];
   if(draft && draft.status==="review_draft" && draft.draft_id && !!choice(draft) && targets.length>=1 && targets.length<=24 && targets.every(t=>t!==undefined))
     output.draft={...draft,targets:targets as SelectedEvidence[]};
   return output;
 })};
}
