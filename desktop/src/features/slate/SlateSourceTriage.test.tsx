// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {SlateIntervalLedger,type LedgerRow} from "./SlateIntervalLedger";
import type {SourceTriage} from "../../api/slateIntervalBoard";
let root:ReturnType<typeof createRoot>,host:HTMLDivElement;
const hash="a".repeat(64);
const raw=(id:number):LedgerRow=>({id:String(id),paperRowId:`r${id}`,paperRowDigest:hash,paper:{document:"test-doc",page:1,line:id,raw:"合成记录"}});
const data:SourceTriage={contract:"mirrororder.source_triage.v1",workspace_scope:"workspace",paper_revision:1,index_sha256:hash,rows:[
 {paper_row_id:"r1",row_digest:hash,cells:[{camera:"A",tier:"single_indexed",cards:[{card:"A001",occurrence_count:1,registered_count:0}]}]},
 {paper_row_id:"r2",row_digest:hash,cells:[{camera:"B",tier:"uncertain",cards:[]}]},
 {paper_row_id:"r3",row_digest:hash,cells:[{camera:"A",tier:"multi_card",cards:[{card:"A001",occurrence_count:1,registered_count:1},{card:"A003",occurrence_count:2,registered_count:1}]}]},
 {paper_row_id:"r4",row_digest:"b".repeat(64),cells:[{camera:"C",tier:"not_indexed",cards:[]}]},
]};
const stage=vi.fn();
const refresh=vi.fn();
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);stage.mockReset()});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()});
const render=(triage?:SourceTriage)=>act(async()=>root.render(<SlateIntervalLedger catalog={[]} refresh={refresh} stageCorrection={stage} snapshot={{revision:1,draftRevision:0,rows:[raw(1),raw(2),raw(3),raw(4)]}} sourceTriage={triage}/>));
const button=(name:string)=>[...host.querySelectorAll("button")].find(b=>b.textContent===name)!;
const rows=()=>[...host.querySelectorAll(".sil-row")].map(x=>x.textContent);
const click=(element:HTMLElement)=>act(async()=>element.click());
async function change(control:number,value:string){await act(async()=>{const el=host.querySelectorAll<HTMLSelectElement>(".sil-source-triage select")[control];el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}))})}
it("optional triage opens only in pending media, ranking unresolved exceptions without changing records",async()=>{
 await render(data);expect(host.querySelector(".sil-source-triage")).toBeNull();expect(rows()).toEqual(["1:1","1:2","1:3","1:4"]);
 await click(button("待匹配原片 4"));expect(rows()).toEqual(["1:2","1:3","1:1","1:4"]);
 expect(host.textContent).toContain("索引提示，已登记不等于可播放");
 expect(host.textContent).toContain("A 机 · 2 格");expect(host.textContent).not.toContain("C机 索引未找到");
 expect(host.textContent).toContain("显示 4 行"); expect(host.textContent).toContain("索引仅一候选 · 未连接");

 expect(stage).not.toHaveBeenCalled();
});
it("filters against the same per-cell camera/card and tier, excludes wrong-digest detail",async()=>{
 await render(data);await click(button("待匹配原片 4"));
 await change(0,"A");expect(rows()).toEqual(["1:3","1:1"]);await change(1,"A003");expect(rows()).toEqual(["1:3"]);
 await change(2,"single_indexed");expect(rows()).toEqual([]);expect(host.textContent).toContain("没有符合筛选条件");
 await render(undefined);expect(host.querySelector(".sil-source-triage")).toBeNull();expect(rows()).toEqual(["1:1","1:2","1:3","1:4"]);
});
