import {useEffect,useRef,useState} from "react";
import type {SyncAngleFields,SyncAngleIdentity,SyncAngleReceipt} from "../../api/slateIntervalBoard";
const PRESETS=[["wide","远景"],["full","全景"],["medium","中景"],["closeup","近景"],["big_closeup","特写"],["unknown","未标"]] as const;
export function SyncAngleAnnotationPanel({target,run}:{target:SyncAngleIdentity;run(target:SyncAngleIdentity,mutation?:{receipt:SyncAngleReceipt;fields:SyncAngleFields}):Promise<SyncAngleReceipt>}){
 const method=useRef(run);method.current=run;
 const [current,setCurrent]=useState<SyncAngleReceipt>();
 const [note,setNote]=useState("");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const live=useRef(false); const locked=useRef(false);
 useEffect(()=>{
   let valid=true;live.current=true;
   void method.current(target).then(value=>{if(valid){setCurrent(value);setNote(value.annotation?.note??"");}}).catch(()=>{if(valid)setMessage("暂未读到机位标注。");});
   return ()=>{valid=false;live.current=false;};
 },[target.group_id,target.clip_id,target.media_id,target.camera]);
 async function save(fields:SyncAngleFields){
   if(!current?.editable||locked.current)return;
   locked.current=true;setBusy(true);setMessage("");
   try{
      const updated=await method.current(target,{receipt:current,fields});
      if(!live.current)return;
      setCurrent(updated);
      if(fields.note!==undefined)setNote(updated.annotation?.note??"");
      setMessage("已保存到此机位");
   }catch{
      if(!live.current)return;
      setMessage("未能确认保存：检查连接，或重新打开此机位。备注输入已保留。");
      try{const v=await method.current(target);if(live.current)setCurrent(v);}catch{/* retain local input */}
   }finally{locked.current=false;if(live.current)setBusy(false);}
 }
 if(!current)return <p role="status">{message||"正在读取机位标注…"}</p>;
 if(!current.editable)return <div><strong>{target.camera} 机景别与备注</strong><p>{current.reason==="registered_source_required"?"原片未连接。使用表格上方「连接本机素材」，再回来标注。":"这个机位的原片依据未就绪，不能写入。"}</p>{current.annotation?.note&&<p>{current.annotation.note}</p>}</div>;
 return <section aria-label={`${target.camera} 机标注`} className="slate-sync-angle">
   <strong>{target.camera} 机景别</strong>
   <div>{PRESETS.map(([id,title])=><button key={id} type="button" aria-pressed={(current.annotation?.shot_type??"unknown")===id}
      disabled={busy} onClick={()=>void save({shot_type:id})}>{title}</button>)}</div>
   <label>{target.camera} 机备注<textarea value={note} maxLength={500} rows={2} onChange={e=>setNote(e.target.value)} /></label>
   <button type="button" disabled={busy||note===(current.annotation?.note??"")} onClick={()=>void save({note})}>保存备注</button>
   {message&&<p role="status">{message}</p>}
 </section>;
}
