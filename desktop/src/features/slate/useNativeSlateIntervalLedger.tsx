import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { type PaperModel } from "../../api/paperIntake";
import { SlateIntervalBoardClient, nativeManagedBoardBridge, toLedgerSnapshot, type SourceTriage, type SlateFramingModel, type SheetFirstModel } from "../../api/slateIntervalBoard";
import { SlateOriginalPlayback } from "./SlateOriginalPlayback";
import { SlateElectronicSourceMatch } from "./SlateElectronicSourceMatch";
import type { SheetFramingController, SheetFirstController } from "./SlatePaperFormSurface";
import type { ElectronicSlateIngest } from "./SlateElectronicImport";
import type { LedgerRow, LedgerSnapshot, SlateIntervalLedgerProps } from "./SlateIntervalLedger";

type LedgerAdapter=Omit<SlateIntervalLedgerProps,"catalog"> & {projectId:string;formRows?:readonly PaperModel["rows"][number][];formDocuments?:readonly PaperModel["documents"][number][];framingControl?:SheetFramingController;sheetFirst?:SheetFirstController;importElectronic?:ElectronicSlateIngest};
type Load={scope:string;snapshot:LedgerSnapshot;paper:PaperModel;workspaceScope:string;indexSha256:string;error?:string};
/** No calls until the packaged app provides an explicit opt-in at the Slate route. */
export function useNativeSlateIntervalLedger(baseUrl:string,projectId:string,enabled:boolean):{available:boolean;ledger?:LedgerAdapter;error:string;refresh:()=>Promise<void>} {
 const available=enabled && isTauri();
 const scope=available?JSON.stringify([baseUrl,projectId]):"";
 const scopeRef=useRef(scope);
 scopeRef.current=scope;
 const seq=useRef(0);
 const [loaded,setLoaded]=useState<Load>();
 const [first,setFirst]=useState<{scope:string;data:SheetFirstModel}>();
 const [framing,setFraming]=useState<{scope:string;data:SlateFramingModel}>();
 const [triage,setTriage]=useState<{scope:string;data:SourceTriage}>();
 const [focusRequest,setFocusRequest]=useState<{scope:string;id:string}>();
 const [error,setError]=useState<{scope:string;text:string}>();
 const client=useMemo(()=>new SlateIntervalBoardClient(nativeManagedBoardBridge(baseUrl)),[baseUrl]);

 const refresh=useCallback(async()=>{
   if(!scope||scopeRef.current!==scope)return;
   const generation=++seq.current;
   const current=()=>scopeRef.current===scope&&seq.current===generation;
   try {
     const board=await client.read(projectId,current);
     if(!current()||!board.workspace_scope)throw new Error("电子场记板缺少当前工作区身份");
     const paper=await client.paperRead(projectId,board.workspace_scope,board.paper_revision);
     if(!current())return;
     const snapshot=toLedgerSnapshot(board,paper);
     setLoaded({scope,snapshot,paper,workspaceScope:board.workspace_scope,indexSha256:board.index_sha256});
     setError(undefined);
     // Optional background read. Old/stale hosts still render the normal board.
     const workspaceScope=board.workspace_scope;
     void client.sourceTriage(projectId,workspaceScope,paper.revision,board.index_sha256)
       .then(data=>{if(current())setTriage({scope,data});})
       .catch(()=>{if(current())setTriage(undefined);});
     void client.sheetFirst(projectId,workspaceScope,board.index_sha256)
       .then(data=>{if(current())setFirst(previous=>previous?.scope===scope&&previous.data.index_sha256===data.index_sha256&&previous.data.revision>data.revision?previous:{scope,data});})
       .catch(()=>{if(current())setFirst(undefined);});
     void client.framing(projectId,workspaceScope,paper.revision)
       .then(data=>{if(current())setFraming(previous=>previous?.scope===scope&&previous.data.paper_revision===data.paper_revision&&previous.data.revision>data.revision?previous:{scope,data});})
       .catch(()=>{if(current())setFraming(undefined);});
   } catch (e) {
     if(current())setError({scope,text:e instanceof Error?e.message:"未能读取场记板"});
     throw e;
   }
 },[scope,client,projectId]);
 useEffect(()=>{
    if(scope)void refresh().catch(()=>{});
    return ()=>{seq.current++;};
 },[scope,refresh]);

 if(!scope||loaded?.scope!==scope)return {available,error:error?.scope===scope?error?.text??"":"",refresh};
 const {paper,snapshot,workspaceScope,indexSha256}=loaded;
 const sheet=first?.scope===scope&&first.data.workspace_scope===workspaceScope&&first.data.index_sha256===indexSha256?first.data:undefined;
 const activeFraming=framing?.scope===scope&&framing.data.workspace_scope===workspaceScope&&framing.data.paper_revision===paper.revision?framing.data:undefined;
 const paperById=new Map(paper.rows.map(row=>[row.paper_row_id,row]));
 const requireScope=()=>{if(scopeRef.current!==scope)throw new Error("项目已切换，请重新选择场记");};
 const paperEvidence=(row:LedgerRow)=>{
   const reference=row.paperRowId?paperById.get(row.paperRowId):undefined;
   return reference && !row.interval
     ? <SlateElectronicSourceMatch key={JSON.stringify([scope,workspaceScope,paper.revision,row.id])} {...{projectId,baseUrl}} row={reference} paperRevision={paper.revision} workspaceScope={workspaceScope} cameraChoices={row.cameraChoices} initialCamera={row.sheetCameraExplicit}
        candidates={(fence)=>{requireScope();return client.sourceCandidates(projectId,fence);}}
        link={(fence,found,chosen)=>{requireScope();return client.linkSource(projectId,fence,found,chosen);}}
        onPrepared={async id=>{await refresh();if(scopeRef.current===scope)setFocusRequest({scope,id});}}/>
     : null;
 };
 return {available,error:error?.scope===scope?error?.text??"":"",refresh,ledger:{
   projectId,snapshot,paperEvidence,refresh,formRows:paper.rows,formDocuments:paper.documents,
   sourceTriage:triage?.scope===scope&&triage.data.workspace_scope===workspaceScope&&triage.data.paper_revision===paper.revision&&triage.data.index_sha256===indexSha256?triage.data:undefined,
   sheetFirst:sheet?{model:sheet,
   angle:sheet.sync_angle_edit?.available&&sheet.sync_angle_edit.contract==="mirrororder.sync_angle_annotations.v1"
     ? (target,mutation)=>{requireScope();return client.syncAngle(projectId,workspaceScope,indexSha256,target,mutation);}
     : undefined,
   thumbnail:(target,signal)=>{
     requireScope();return client.slateThumbnail(projectId,workspaceScope,indexSha256,target,baseUrl,signal);
   },
   annotate:async body=>{
     requireScope();
     try{
       const reading=await client.paperAnnotation(projectId,workspaceScope,indexSha256,body);
       requireScope();
       setFirst(previous=>{
         if(previous?.scope!==scope||previous.data.index_sha256!==indexSha256)return previous;
         const fields=previous.data.paper_field_annotations??{};
         return {...previous,data:{...previous.data,paper_field_annotations:{...fields,[body.group_id]:{...fields[body.group_id],[body.field]:reading}}}};
       });
       if(reading.state==="needs_review")void refresh().catch(()=>{});
       return reading;
     }catch(e){void refresh().catch(()=>{});throw e;}
   },
   add:async(fields,request_id)=>{
     requireScope();
     try{const data=await client.sheetFirst(projectId,workspaceScope,indexSha256,{fields,request_id,expected_sheet_revision:sheet.revision});
       requireScope();setFirst({scope,data});return data;
     }catch(e){void refresh().catch(()=>{});throw e;}
   },edit:async signedEdit=>{
     requireScope();
     try{const data=await client.sheetFirst(projectId,workspaceScope,indexSha256,{signedEdit,expected_sheet_revision:sheet.revision});
       requireScope();setFirst({scope,data});return data;
     }catch(e){void refresh().catch(()=>{});throw e;}
   }}:undefined,
   framingControl:activeFraming?{model:activeFraming,set:async(request)=>{
     requireScope();
     const generation=seq.current;
     try{const data=await client.framing(projectId,workspaceScope,paper.revision,{...request,expected_tag_revision:activeFraming.revision});
       requireScope();if(generation!==seq.current){void refresh().catch(()=>{});return;}
       setFraming(previous=>previous?.scope===scope&&previous.data.paper_revision===data.paper_revision&&previous.data.revision>data.revision?previous:{scope,data});
     }catch(e){void refresh().catch(()=>{});throw e;}
   }}:undefined,
   focusEvidenceId:focusRequest?.scope===scope?focusRequest.id:undefined,
   rangeEvidence:(row,startOpen)=>{
     const source=row.interval?.current&&row.interval.sourceIdentity;
     return source?<SlateOriginalPlayback key={JSON.stringify([scope,row.id,source])} baseUrl={baseUrl} projectId={projectId} source={source} startOpen={startOpen}/>:null;
   },
   importElectronic:async(content,format)=>{
     requireScope();
     const result=await client.paperIngest(projectId,workspaceScope,paper.revision,content,format);
     requireScope();
     return result;
   },
   stageCorrection:(req)=>{requireScope();return client.stage(projectId,req,workspaceScope);},
   approveCorrection:(req)=>{requireScope();return client.approve(projectId,req,workspaceScope);},
 }};
}