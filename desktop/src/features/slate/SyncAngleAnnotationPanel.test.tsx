// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {SyncAngleAnnotationPanel} from "./SyncAngleAnnotationPanel";
import {SlateIntervalBoardClient,type SyncAngleIdentity,type SyncAngleReceipt} from "../../api/slateIntervalBoard";
const sha="a".repeat(64);
const A:SyncAngleIdentity={group_id:"g",clip_id:"cA",media_id:"M_"+"a".repeat(24),camera:"A"};
const B:SyncAngleIdentity={...A,clip_id:"cB",media_id:"M_"+"b".repeat(24),camera:"B"};
const found=(target:SyncAngleIdentity,over:Partial<SyncAngleReceipt>={}):SyncAngleReceipt=>({contract:"mirrororder.sync_angle_annotations.v1",workspace_scope:"w",index_sha256:sha,target,revision:0,anchor:"sync-angle-"+sha,editable:true,reason:null,annotation:null,editorial_authority:false,checks_current_original_bytes:false,...over});
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);node=document.createElement("div");document.body.append(node);root=createRoot(node);});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
it("refuses offline and leaves saved label scoped to A",async()=>{
  const linked=found(A);
  const written=found(A,{revision:1,annotation:{annotation_id:"k",shot_type:"big_closeup",note:"",annotation_state:"saved"},checks_current_original_bytes:true});
  const run=vi.fn().mockResolvedValueOnce(linked).mockResolvedValueOnce(written)
    .mockResolvedValueOnce(found(B,{editable:false,reason:"registered_source_required"}));
  await act(async()=>root.render(<SyncAngleAnnotationPanel key="a" target={A} run={run}/>));
  const button=[...node.querySelectorAll("button")].find(b=>b.textContent==="特写")!;
  await act(async()=>button.click());
  expect(run).toHaveBeenNthCalledWith(2,A,{receipt:linked,fields:{shot_type:"big_closeup"}});
  expect(node.textContent).toContain("已保存到此机位");
  await act(async()=>root.render(<SyncAngleAnnotationPanel key="b" target={B} run={run}/>));
  expect(node.querySelector("button")).toBeNull();expect(node.textContent).toContain("原片未连接");
});
it("checks exact target and only accepts approved write readback",async()=>{
  const bridge=vi.fn().mockResolvedValueOnce({ok:true,data:found(A)})
    .mockResolvedValueOnce({ok:true,data:found(B,{checks_current_original_bytes:true,revision:1})});
  const client=new SlateIntervalBoardClient(bridge);
  const receipt=await client.syncAngle("p","w",sha,A);
  expect(bridge).toHaveBeenNthCalledWith(1,{action:"board_sync_angle_read",project_id:"p",...A,expected_scope:"w",expected_index_sha256:sha});
  await expect(client.syncAngle("p","w",sha,A,{receipt,fields:{note:"one angle"}})).rejects.toThrow("不一致");
  expect(bridge).toHaveBeenNthCalledWith(2,{action:"board_sync_angle_set",project_id:"p",...A,expected_scope:"w",expected_index_sha256:sha,
   expected_annotation_revision:0,expected_anchor:"sync-angle-"+sha,fields:{note:"one angle"}});
});
