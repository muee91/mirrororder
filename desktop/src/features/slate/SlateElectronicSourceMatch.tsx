import {useEffect,useRef,useState} from "react";
import type {BoardSourceCandidates,BoardSourceFence,BoardSourceLink} from "../../api/slateIntervalBoard";
import type {ElectronicSourceSelection,SourceCandidate} from "../../api/paperSourceContext";
import type {PaperRow} from "../../api/paperIntake";
import type {LedgerRow} from "./SlateIntervalLedger";
import {SlateOriginalPlayback} from "./SlateOriginalPlayback";
import {SlateSourceIntervalPanel} from "./SlateSourceIntervalPanel";

type Props={
 baseUrl:string;projectId:string;row:PaperRow;paperRevision:number;workspaceScope:string;cameraChoices?:LedgerRow["cameraChoices"];initialCamera?:LedgerRow["sheetCameraExplicit"];
 candidates:(fence:BoardSourceFence)=>Promise<BoardSourceCandidates>;
 link:(fence:BoardSourceFence,found:BoardSourceCandidates,chosen:SourceCandidate)=>Promise<BoardSourceLink>;
 onPrepared:(id:string)=>Promise<void>;
};
const digest=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{64}$/.test(v);
const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
const sampled=(v:unknown)=>typeof v==="string"&&/^M_[0-9a-f]{24}$/.test(v);
const key=(candidate:SourceCandidate)=>JSON.stringify([candidate.clip_id,candidate.media_id]);
/** Every camera and file choice is explicit; selecting an A cell cannot write for a B source. */
export function SlateElectronicSourceMatch({baseUrl,projectId,row,paperRevision,workspaceScope,cameraChoices,initialCamera,candidates,link,onPrepared}:Props) {
 const [cell,setCell]=useState<ElectronicSourceSelection>();
 const [found,setFound]=useState<BoardSourceCandidates>();
 const [picked,setPicked]=useState("");
 const [linked,setLinked]=useState<BoardSourceLink>();
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const epoch=useRef(0), lock=useRef(false);
 useEffect(()=>()=>{epoch.current++},[]);
 const fenceFor=(target:ElectronicSourceSelection):BoardSourceFence=>({
   expected_scope:workspaceScope,paper_row_id:row.paper_row_id,row_digest:target.rowDigest,expected_paper_revision:paperRevision,nested_camera:target.camera,
 });
 async function load(target:ElectronicSourceSelection){
   if(lock.current)return;lock.current=true;setBusy(true);setMessage("");setCell(target);setFound(undefined);setPicked("");setLinked(undefined);
   const gen=++epoch.current;
   try {
     const value=await candidates(fenceFor(target));
     if(gen!==epoch.current)return;
     const proof=value.electronic_source_cell;
     if(value.paper_row_id!==row.paper_row_id||value.row_digest!==target.rowDigest||value.reviewed_paper_camera!==target.camera||value.confirmed!==false||
       value.interval_confirmed!==false||value.original_document_verified!==false||!digest(value.index_sha256)||!count(value.expected_binding_revision)||
       proof?.kind!=="explicit_electronic_clip_cell"||proof.paper_row_id!==row.paper_row_id||proof.row_digest!==target.rowDigest||proof.camera!==target.camera||
       proof.raw_cell!==target.rawCell||proof.raw_code!==target.rawCode||proof.authority!==false||proof.interval_confirmed!==false||!digest(proof.source_cell_sha256)||
       !Array.isArray(value.candidates)||new Set(value.candidates.map(key)).size!==value.candidates.length||
       value.candidates.some(c=>!c.clip_id||!sampled(c.media_id)||c.camera!==target.camera||c.filename_camera!==target.camera||typeof c.filename!=="string"||!c.filename||c.filename.includes("/")||c.filename.includes("\\")||!new RegExp("^"+target.camera+"[0-9]{3}$").test(c.card)))
         throw new Error("当前行或机位证据已变化，请重读。");
     setFound(value);
     if(!value.candidates.length)setMessage("这台设备没有可核对的同机位原片。先连接素材盘，再重读。");
   }catch(e){if(gen===epoch.current)setMessage(e instanceof Error?e.message:"读取原片失败。");}
   finally{if(gen===epoch.current){lock.current=false;setBusy(false);}}
 }
 useEffect(()=>{
   if(!initialCamera)return;
   const target=cameraChoices?.find(c=>c.camera===initialCamera&&c.status==="literal");
   if(!target)return;
   const timer=setTimeout(()=>void load(target),0);
   return ()=>clearTimeout(timer);
 },[initialCamera,row.paper_row_id,paperRevision]);
 const target=found?.candidates.find(c=>key(c)===picked);
 async function bind(){
   if(lock.current||!found||!target||!cell||linked)return;
   lock.current=true;setBusy(true);setMessage("");const gen=epoch.current;
   try {
     const value=await link(fenceFor(cell),found,target);
     if(gen!==epoch.current)return;
     if(value.basis!=="operator_selected_electronic_cell"||value.expected_selection_revision!==0||value.interval_confirmed!==false||value.exact_take_confirmed!==false||
       typeof value.binding_id!=="string"||!value.binding_id||!count(value.revision)||value.revision<found.expected_binding_revision||!count(value.source_context_revision))
       throw new Error("匹配回执不一致，请重读。");
     setLinked(value);
   }catch(e){if(gen===epoch.current){setFound(undefined);setPicked("");setMessage(e instanceof Error?e.message:"匹配失败，请重读。");}}
   finally{if(gen===epoch.current){lock.current=false;setBusy(false);}}
 }
 const filename=target?`${target.card} · ${target.filename}`:"";
 return <section className="sil-electronic-match" aria-label="从电子记录匹配原片">
   {!cameraChoices?.length?<p>此行没有明确机位和文件号，留待复核。</p>:<div className="sil-camera-choices" aria-label="电子场记机位列">
     {cameraChoices.map(item=><button type="button" key={item.camera} aria-pressed={cell?.camera===item.camera} disabled={busy||item.status!=="literal"}
       onClick={()=>void load(item)}>{item.camera} 机 · {item.rawCode || "未填"}{item.status==="needs_review"?" · 待复核":""}</button>)}
   </div>}
   {cell&&<p role="status">{busy?"正在核对本机原片…":message}</p>}
   {found?.camera_conflict&&<p>已排除机位不符的同号文件。</p>}
   {(found?.unregistered_indexed_sampled_media_count??0)>0&&<p>有素材尚未连接；这里只列出本机已登记的候选。</p>}
   {found&&found.candidates.length>0&&<fieldset disabled={busy||!!linked}>
      <legend>{found.candidates.length>1?"同号原片：按卡号和完整文件名选择":"核对原片"}</legend>
      {found.candidates.map(candidate=><label key={key(candidate)}><input type="radio" name={`clip:${row.paper_row_id}`} checked={picked===key(candidate)} onChange={()=>setPicked(key(candidate))}/><span>{candidate.card} · {candidate.filename}</span></label>)}
   </fieldset>}
   {target&&!linked&&<><SlateOriginalPlayback key={picked} baseUrl={baseUrl} projectId={projectId} source={{clipId:target.clip_id,mediaId:target.media_id,selectionKey:picked}} startOpen={!!initialCamera}/><button type="button" disabled={busy} onClick={()=>void bind()}>匹配所选原片</button></>}
   {linked&&found&&target&&cell&&<SlateSourceIntervalPanel key={linked.binding_id} baseUrl={baseUrl} projectId={projectId} recordId="" clipId={target.clip_id} mediaId={target.media_id} boardRevision={-1} dirty={false} displaySourceName={filename}
     previewSource={<SlateOriginalPlayback baseUrl={baseUrl} projectId={projectId} source={{clipId:target.clip_id,mediaId:target.media_id,selectionKey:`source-link-${linked.source_context_revision}`}} startOpen={!!initialCamera}/>}
     paperSource={{row,revision:paperRevision}} boundSource={{basis:"operator_selected_electronic_cell",bindingId:linked.binding_id,revision:linked.source_context_revision,selectionRevision:0,indexSha256:found.index_sha256,rowDigest:cell.rowDigest}} onLocationPrepared={onPrepared}/>}
 </section>;
}
