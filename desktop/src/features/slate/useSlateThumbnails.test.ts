import {expect,it,vi} from "vitest";
import {VisibleThumbnailQueue,thumbKey,type ThumbCell} from "./useSlateThumbnails";
const frame=new Blob(["fake"],{type:"image/jpeg"});
const candidate=(i:number):ThumbCell=>({rowId:String(i),digest:"digest",identity:{group_id:"g"+i,clip_id:"clip"+i,media_id:"media"+i,camera:"A"}});
const relative=(n:number,base=0)=>new Map(Array.from({length:n},(_,i)=>[thumbKey(String(i+base),"A"),candidate(i+base)]));
it("starts only visible cells, limits whole view to two, cancels replaced work and emits no stale images",async()=>{
 vi.useFakeTimers();
 try{
  const resolve=new Map<string,(v:Blob)=>void>(), signals=new Map<string,AbortSignal>();
  const read=vi.fn((target,signal)=>new Promise<Blob>(r=>{resolve.set(target.clip_id,r);signals.set(target.clip_id,signal);signal.addEventListener("abort",()=>r(frame))}));
  const publish=vi.fn(), create=vi.fn(()=> "blob:fixed"), revoke=vi.fn();
  const q=new VisibleThumbnailQueue(read,publish,()=>Date.now(),create,revoke);
  q.setVisible(relative(8));
  await vi.advanceTimersByTimeAsync(130);
  expect(read.mock.calls.map(([t])=>t.clip_id)).toEqual(["clip0","clip1"]);
  expect(signals.get("clip0")?.aborted).toBe(false);
  q.setVisible(relative(4,800));
  expect(signals.get("clip0")?.aborted).toBe(true);expect(signals.get("clip1")?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(135);
  expect(read.mock.calls.map(([t])=>t.clip_id)).toEqual(["clip0","clip1","clip800","clip801"]);
  expect(create).not.toHaveBeenCalled();
  resolve.get("clip800")!(frame);
  await vi.advanceTimersByTimeAsync(125);
  expect(read.mock.calls.at(-1)?.[0].clip_id).toBe("clip802");
  expect(publish.mock.calls.at(-1)?.[0].get(thumbKey("800","A"))).toBe("blob:fixed");
  q.dispose();
  expect(signals.get("clip802")?.aborted).toBe(true);expect(revoke).toHaveBeenCalledWith("blob:fixed");
 }finally{vi.useRealTimers();}
});
it("keeps 694×3 potential data outside the queue, and negative TTL suppresses repeated requests until refresh",async()=>{
 vi.useFakeTimers();
 try{
  const read=vi.fn(async()=>{throw Error("missing")});
  const q=new VisibleThumbnailQueue(read,()=>{});
  q.setVisible(relative(1,693));
  await vi.advanceTimersByTimeAsync(300);
  expect(read).toHaveBeenCalledTimes(1);
  for(let i=0;i<20;i++)q.setVisible(relative(1,693));
  await vi.advanceTimersByTimeAsync(110);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(12_100);
  expect(read).toHaveBeenCalledTimes(2);
  q.dispose();
 }finally{vi.useRealTimers();}
});
