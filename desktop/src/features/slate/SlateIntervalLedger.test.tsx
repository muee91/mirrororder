// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {SlateIntervalLedger,type LedgerRow,type StageCorrection,type ApproveCorrection} from "./SlateIntervalLedger";

let el:HTMLDivElement, root:ReturnType<typeof createRoot>;
const pair1={episode:1,scene_id:"19-1"},pair2={episode:2,scene_id:"19-1"};
const ev=(line:number)=>({evidence_id:`ev-${line}`,expected_evidence_version:4,expected_evidence_sha256:String(line).repeat(64)});
const base=(line:number,start:number,endExclusive:number):LedgerRow=>({id:`row-${line}`,paper:{document:"doc",page:1,line,raw:`原文 ${line}`},interval:{evidence:ev(line),clipLabel:"C002",start,endExclusive,fps:"50",current:true}});
const first={...base(1,0,500),verified:pair1};
const middle=base(2,500,650);
const last={...base(3,650,850),verified:pair2};
const noSource={id:"row-4",paper:{document:"doc",page:1,line:4,raw:""},pendingReason:"同号原片证据不足"};
const stage=vi.fn<(input:StageCorrection)=>Promise<{revision:number;draft_revision:number;draft:{status:"review_draft";editorial_authority:false}}>>();
const approve=vi.fn<(input:ApproveCorrection)=>Promise<{revision:number;draft_revision:number;approved:string[];export_ready:false}>>();
const refresh=vi.fn<()=>Promise<void>>();
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);el=document.createElement("div");document.body.append(el);root=createRoot(el);stage.mockReset().mockResolvedValue({revision:7,draft_revision:2,draft:{status:"review_draft",editorial_authority:false}});approve.mockReset().mockResolvedValue({revision:8,draft_revision:2,approved:[ev(2).evidence_id,ev(3).evidence_id],export_ready:false});refresh.mockReset().mockResolvedValue(undefined)});
afterEach(async()=>{await act(async()=>root.unmount());el.remove();vi.unstubAllGlobals()});
const render=(rows:LedgerRow[]=[first,middle,last,noSource],revision=7)=>act(async()=>root.render(<SlateIntervalLedger snapshot={{rows,revision,draftRevision:1}} catalog={[pair1,pair2]} stageCorrection={stage} approveCorrection={approve} refresh={refresh}/>));
const button=(s:string)=>[...el.querySelectorAll('button')].find(b=>b.textContent===s)!;
const click=(b:HTMLElement)=>act(async()=>b.click());
async function select(index:number,v:string){await act(async()=>{const field=el.querySelectorAll('select')[index];field.value=v;field.dispatchEvent(new Event('change',{bubbles:true}));})}
it("defaults to only pending without writing; displays original evidence and true source interval",async()=>{
  await render();expect(el.textContent).toContain("待补集场");expect(el.textContent).toContain('待对原片');expect(el.textContent).toContain('500–649');expect(el.textContent).toContain('原文 2');expect(el.textContent).not.toContain('650–849');expect(stage).not.toHaveBeenCalled()
});
it("keeps the same scene label from two episodes distinctly grouped",async()=>{
 await render();await click(button("已归场"));const labels=[...el.querySelectorAll('.sil-group')].map(x=>x.textContent);expect(labels).toEqual(["第 1 集 · 19-1 场","第 2 集 · 19-1 场"]);
});
it("explicitly sends middle interval only, without allowing range or raw fields as mutation",async()=>{
 await render();await select(1,JSON.stringify([2,"19-1"]));await click(button("存为修正草稿"));
 expect(stage.mock.calls[0][0]).toEqual({mode:"script_scene",episode:2,scene_id:"19-1",expected_revision:7,expected_draft_revision:1,selected:[ev(2)]});
 expect(el.textContent).toContain("不代表已确认归场");expect(refresh).toHaveBeenCalledTimes(1);
 await render([first,{...middle,draft:{...pair2,draft_id:"d1",targets:[ev(2)],status:"review_draft"}},last,noSource],8);
 expect(el.textContent).toContain("有草稿");await click(button("已归场"));expect(el.textContent).toContain("0–499");expect(el.textContent).toContain("650–849");expect(el.textContent).not.toContain("500–649");
});
it("draft selection cannot silently switch to a different active interval by clicking/keyboard",async()=>{
 await render([middle,base(3,650,850)]);await select(1,JSON.stringify([2,"19-1"]));
 const row=button("1:2");row.focus();await act(async()=>row.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})));
 expect(document.activeElement).toBe(button("1:3"));expect(button("存为修正草稿").disabled).toBe(true);expect(stage).not.toHaveBeenCalled();
});
it("rejects cross-page or inconsistent known pairs, even with an exact edit target",async()=>{
 const other={...base(3,650,850),paper:{...last.paper,page:2}};
 await render([middle,other]);for(const cb of el.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))await click(cb);
 await select(1,JSON.stringify([2,"19-1"]));expect(button("存为修正草稿").disabled).toBe(true);expect(stage).not.toHaveBeenCalled();
});
it("sends exact list for user-selected compatible rows not every same-page row",async()=>{
 await render([base(1,0,500),middle,base(3,650,850)]);const boxes=el.querySelectorAll<HTMLInputElement>('input[type=checkbox]');await click(boxes[0]);await click(boxes[2]);await select(1,JSON.stringify([1,"19-1"]));await click(button("存为修正草稿"));
 expect(stage.mock.calls[0][0].selected).toEqual([ev(1),ev(3)]);
});
it("blocks stale writer and retains explicit input across error until re-read",async()=>{
 await render();stage.mockRejectedValueOnce(new Error("revision_changed"));await select(1,JSON.stringify([1,"19-1"]));await click(button("存为修正草稿"));
 expect(el.textContent).toContain("重读后再提交");expect(el.querySelectorAll('select')[1].value).toBe(JSON.stringify([1,"19-1"]));expect(button("存为修正草稿").disabled).toBe(true);await click(button("重读列表"));expect(refresh).toHaveBeenCalledTimes(1);
});

it("approval of a multi-row draft cannot touch an unselected companion, and must be explicit",async()=>{
 const draft={...pair2,draft_id:"draft-mid",targets:[ev(2),ev(3)],status:"review_draft" as const};
 await render([{...middle,draft},{...base(3,650,850),draft}]);
 const submit=button("确认这 2 条集场");expect(submit.disabled).toBe(true);expect(approve).not.toHaveBeenCalled();
 const boxes=el.querySelectorAll<HTMLInputElement>('input[type=checkbox]');await click(boxes[0]);expect(submit.disabled).toBe(true);await click(boxes[1]);expect(submit.disabled).toBe(false);
 await click(submit);expect(approve.mock.calls[0][0]).toEqual({draft_id:"draft-mid",expected_revision:7,expected_draft_revision:1});
 expect(el.textContent).toContain("已确认集场");expect(el.querySelector(".sil-group")).toBeNull();
});
