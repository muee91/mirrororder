import {useLayoutEffect,useRef,useState,type RefObject} from "react";
import type {SlateThumbnailTarget} from "../../api/slateIntervalBoard";

export type ThumbCell={identity:SlateThumbnailTarget;digest:string;rowId:string};
export const thumbKey=(id:string,camera:string)=>JSON.stringify([id,camera]);
const cellSignature=(cell:ThumbCell)=>JSON.stringify([cell.rowId,cell.digest,cell.identity]);
type Request=(target:SlateThumbnailTarget,signal:AbortSignal)=>Promise<Blob>;
const MAX_VISIBLE=36, MAX_ACTIVE=2, POSITIVE_TTL=20_000, NEGATIVE_TTL=12_000;

/** At most two active requests and no offscreen queue. JS cancellation also cancels the helper. */
export class VisibleThumbnailQueue {
 private readonly pending=new Map<string,ThumbCell>();
 private readonly running=new Map<string,{abort:AbortController;key:string}>();
 private readonly completed=new Map<string,{url:string;key:string;expires:number}>();
 private visible=new Map<string,ThumbCell>();
 private disposed=false;
 private timer:ReturnType<typeof setTimeout>|undefined;
 constructor(private readonly read:Request,private readonly publish:(images:ReadonlyMap<string,string>)=>void,
             private readonly clock=Date.now,private readonly create=(b:Blob)=>URL.createObjectURL(b),
             private readonly revoke=(u:string)=>URL.revokeObjectURL(u)){}
 setVisible(cells:Map<string,ThumbCell>){
   if(this.disposed)return;
   this.visible=new Map([...cells].slice(0,MAX_VISIBLE));
   this.reconcile();
 }
 private reconcile(){
   const now=this.clock();
   for(const [id,v] of this.completed){
     const wanted=this.visible.get(id);
     if(!wanted||cellSignature(wanted)!==v.key||v.expires<=now){if(v.url)this.revoke(v.url);this.completed.delete(id);}
   }
   for(const [id,task] of this.running){
     const wanted=this.visible.get(id);
     if(!wanted||cellSignature(wanted)!==task.key)task.abort.abort();
   }
   this.pending.clear();
   for(const [id,cell] of this.visible)if(!this.completed.has(id)&&!this.running.has(id))this.pending.set(id,cell);
   this.emit();
   if(this.timer)clearTimeout(this.timer);
   // Not a recurring decode: expiration first re-stats the bound source and
   // then uses the native JPEG cache. Expiry removes stale disk stills first.
   const expire=Math.min(...[...this.completed.values()].map(v=>v.expires));
   const delay=Math.min(this.pending.size?105:Infinity,expire-now);
   if(Number.isFinite(delay)&&!this.disposed)this.timer=setTimeout(()=>{
     this.timer=undefined;
     if(!this.pending.size){this.reconcile();return;}
     this.pump();
   },Math.max(1,delay));
 }
 private emit(){this.publish(new Map([...this.completed].flatMap(([key,value])=>value.url?[[key,value.url] as const]:[])));}
 private pump(){
   if(this.disposed)return;
   for(const [id,cell] of this.pending){
     if(this.running.size>=MAX_ACTIVE)break;
     this.pending.delete(id);
     const abort=new AbortController(),key=cellSignature(cell);
     this.running.set(id,{abort,key});
     void Promise.resolve().then(()=>this.read(cell.identity,abort.signal)).then(blob=>{
       const wanted=this.visible.get(id);
       if(!this.disposed&&!abort.signal.aborted&&wanted&&cellSignature(wanted)===key)
         this.completed.set(id,{url:this.create(blob),key,expires:this.clock()+POSITIVE_TTL});
     }).catch(()=>{
       if(!this.disposed&&!abort.signal.aborted)this.completed.set(id,{url:"",key,expires:this.clock()+NEGATIVE_TTL});
     }).finally(()=>{
       this.running.delete(id);
       if(!this.disposed)this.reconcile();
     });
   }
 }
 reset(){
   for(const v of this.completed.values())if(v.url)this.revoke(v.url);
   this.completed.clear();
   this.setVisible(new Map());
 }
 dispose(){
   this.disposed=true;
   if(this.timer)clearTimeout(this.timer);
   for(const task of this.running.values())task.abort.abort();
   for(const v of this.completed.values())if(v.url)this.revoke(v.url);
   this.completed.clear();this.visible.clear();this.pending.clear();
 }
}

export function useSlateThumbnails(root:RefObject<HTMLElement|null>,targets:ReadonlyMap<string,ThumbCell>,
                                  viewKey:string,request?:Request){
 const [images,setImages]=useState<ReadonlyMap<string,string>>(new Map());
 const read=useRef(request);read.current=request;
 const enabled=!!request;
 useLayoutEffect(()=>{
   setImages(new Map());
   if(!enabled||!targets.size||typeof IntersectionObserver==="undefined")return;
   const table=root.current?.querySelector<HTMLElement>(".slate-paper-form-scroll");
   if(!table)return;
   const selected=new Map<string,ThumbCell>();
   const queue=new VisibleThumbnailQueue((target,signal)=>read.current!(target,signal),setImages);
   const observer=new IntersectionObserver(entries=>{
     for(const entry of entries){
       const el=entry.target as HTMLElement;
       const id=thumbKey(el.dataset.slateThumbnail??"",el.dataset.slateCamera??"");
       const cell=targets.get(id);
       if(entry.isIntersecting&&entry.intersectionRatio>0.04&&cell&&cell.digest===el.dataset.slateDigest)selected.set(id,cell);
       else selected.delete(id);
     }
     if(!document.hidden)queue.setVisible(selected);
   },{root:null,rootMargin:"0px",threshold:[0,0.05]});
   for(const el of table.querySelectorAll<HTMLElement>("[data-slate-thumbnail][data-slate-camera]"))observer.observe(el);
   function refresh(){
     queue.reset();
     if(!document.hidden)queue.setVisible(selected);
   }
   window.addEventListener("focus",refresh);
   document.addEventListener("visibilitychange",refresh);
   return ()=>{
     observer.disconnect();
     queue.dispose();
     window.removeEventListener("focus",refresh);
     document.removeEventListener("visibilitychange",refresh);
   };
 },[root,targets,viewKey,enabled]);
 return images;
}
