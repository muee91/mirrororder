import {useLayoutEffect,useRef,useState,type FormEvent,type KeyboardEvent} from "react";
import "./slate-framing-picker.css";

type Preset={id:string;label:string;custom?:boolean};
type Props={
 label:string; original:string;currentId?:string;catalog:readonly Preset[];
 onApply:(tagId:string)=>Promise<void>;onAddCustom?:(label:string)=>Promise<void>;onClose:()=>void;
};
export function SlateFramingPicker({label,original,currentId,catalog,onApply,onAddCustom,onClose}:Props){
 const [custom,setCustom]=useState(false),[name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const focusables=useRef(new Map<string,HTMLButtonElement>()),input=useRef<HTMLInputElement>(null),close=useRef<HTMLButtonElement>(null);
 const busyRef=useRef(false),mounted=useRef(false);
 useLayoutEffect(()=>{
  mounted.current=true;
  (focusables.current.get(currentId??"")??focusables.current.values().next().value??close.current)?.focus();
  return ()=>{mounted.current=false;};
 },[]);
 useLayoutEffect(()=>{if(custom)input.current?.focus();},[custom]);
 async function act(operation:()=>Promise<void>,failure:string){
  if(busyRef.current)return;
  busyRef.current=true;setBusy(true);setError("");
  try {
   await operation();
   if(mounted.current)onClose();
  } catch {if(mounted.current)setError(failure);}
  finally{busyRef.current=false;if(mounted.current)setBusy(false);}
 }
 function keys(e:KeyboardEvent<HTMLElement>){
  if(e.nativeEvent.isComposing)return;
  if(e.key==="Escape"){e.preventDefault();e.stopPropagation();onClose();return;}
  const buttons=[...focusables.current.values()],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
  if(index<0||!buttons.length)return;
  const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:e.key==="ArrowLeft"||e.key==="ArrowUp"?(index+buttons.length-1)%buttons.length:e.key==="ArrowRight"||e.key==="ArrowDown"?(index+1)%buttons.length:-1;
  if(next>=0){e.preventDefault();buttons[next].focus();}
 }
 function saveCustom(e:FormEvent){
  e.preventDefault();const trimmed=name.trim();
  if(!onAddCustom||!trimmed||Array.from(trimmed).length>24)return;
  if(catalog.some(tag=>tag.label.normalize("NFKC").toLowerCase()===trimmed.normalize("NFKC").toLowerCase())){setError("已有同名景别，直接选择即可。");return;}
  void act(()=>onAddCustom(trimmed),"没有添加景别。请刷新后重试。");
 }
 return <section className="slate-framing-picker" role="dialog" aria-label={label} onKeyDown={keys} aria-busy={busy}>
   <div className="slate-framing-title"><strong>{label}</strong><button ref={close} type="button" aria-label="关闭景别选择" onClick={onClose}>关闭</button></div>
   <small>原记录：{original||"未记录"}。选择景别不会改动原记录。</small>
   <div className="slate-framing-options" aria-label="可选景别">
    {catalog.map(tag=><button key={tag.id} type="button" disabled={busy} aria-pressed={tag.id===currentId}
     ref={button=>{if(button)focusables.current.set(tag.id,button);else focusables.current.delete(tag.id);}}
     onClick={()=>void act(()=>onApply(tag.id),"没有保存景别。请刷新后重试。")}>{tag.label}</button>)}
   </div>
   {onAddCustom&&(custom?<form onSubmit={saveCustom}>
    <label>自定义景别 <input ref={input} value={name} onChange={e=>setName(e.currentTarget.value)} maxLength={24} disabled={busy}/></label>
    <button type="submit" disabled={busy||!name.trim()}>添加并应用</button>
   </form>:<button type="button" onClick={()=>setCustom(true)}>＋ 自定义景别</button>)}
   {busy&&<span role="status">正在保存…</span>}
   {error&&<span role="alert">{error}</span>}
 </section>;
}
