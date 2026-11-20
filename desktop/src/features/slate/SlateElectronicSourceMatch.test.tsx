// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {SlateElectronicSourceMatch} from "./SlateElectronicSourceMatch";
import type {PaperRow} from "../../api/paperIntake";
import type {BoardSourceCandidates,BoardSourceLink} from "../../api/slateIntervalBoard";
const wrapped=vi.fn();
vi.mock("./SlateSourceIntervalPanel",()=>({SlateSourceIntervalPanel:(p:any)=>{wrapped(p);return <p>实际原素材区间面板</p>}}));
const hex='a'.repeat(64), sourceId=(c:string)=>"M_"+c.repeat(24);
const row={paper_row_id:'row',page:1,row:2,normalized_fields:{scene:"旧暂记"},review_reasons:[],candidate_ready:true} as unknown as PaperRow;
const cell={camera:"A" as const,rawCell:"/cameras/A/clip_raw",rawCode:"C006",rowDigest:hex,status:"literal" as const};
const other={...cell,camera:"B" as const,rawCell:"/cameras/B/clip_raw"};
const files=[{clip_id:"clip1",media_id:sourceId('a'),card:"A017",camera:"A",filename_camera:"A",filename:"A017 C006 01.MP4",basis:"filename_convention_not_camera_metadata"},
              {clip_id:"clip2",media_id:sourceId('b'),card:"A018",camera:"A",filename_camera:"A",filename:"A018 C006 02.MP4",basis:"filename_convention_not_camera_metadata"}];
const reply:BoardSourceCandidates={status:"candidates",camera_conflict:true,original_document_verified:false,confirmed:false,interval_confirmed:false,basis:"filename_convention_not_camera_metadata",index_sha256:hex,paper_row_id:'row',row_digest:hex,expected_binding_revision:2,reviewed_paper_camera:"A",candidates:files,
 electronic_source_cell:{kind:"explicit_electronic_clip_cell",paper_row_id:"row",row_digest:hex,camera:"A",raw_cell:cell.rawCell,raw_code:cell.rawCode,authority:false,interval_confirmed:false,source_cell_sha256:hex}};
const receipt:BoardSourceLink={basis:"operator_selected_electronic_cell",binding_id:"bound",revision:3,source_context_revision:1,expected_selection_revision:0,interval_confirmed:false,exact_take_confirmed:false};
const get=vi.fn(),bind=vi.fn(),complete=vi.fn();let target:HTMLElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);target=document.createElement("div");document.body.append(target);root=createRoot(target);get.mockReset().mockResolvedValue(reply);bind.mockReset().mockResolvedValue(receipt);complete.mockReset();wrapped.mockReset()});
afterEach(async()=>{await act(async()=>root.unmount());target.remove();vi.unstubAllGlobals()});
const render=()=>act(async()=>root.render(<SlateElectronicSourceMatch baseUrl="http://127.0.0.1:8765" projectId="p" row={row} paperRevision={4} workspaceScope="workspace" cameraChoices={[cell,other]} candidates={get} link={bind} onPrepared={complete}/>));
const button=(s:string)=>[...target.querySelectorAll('button')].find(b=>b.textContent===s)!;
const click=(element:HTMLElement)=>act(async()=>element.click());
it("selects the exact camera cell and lists conflicting filenames without a PDF or implicit source write",async()=>{
 await render();expect(get).not.toHaveBeenCalled();await click(button("A 机 · C006"));
 expect(get).toHaveBeenCalledExactlyOnceWith({expected_scope:"workspace",paper_row_id:"row",row_digest:hex,expected_paper_revision:4,nested_camera:"A"});
 expect(target.textContent).toContain("A017 C006 01.MP4");expect(target.textContent).toContain("A018 C006 02.MP4");expect(target.textContent).toContain("已排除机位不符的同号文件");
 expect(target.querySelector('input:checked')).toBeNull();expect(button("匹配所选原片")).toBeUndefined();expect(bind).not.toHaveBeenCalled();
 expect(target.textContent).not.toMatch(/PDF|OCR|圈选表头/);
});
it("clicking a radio previews and submits only the explicitly chosen original identity",async()=>{
 await render();await click(button("A 机 · C006"));await click(target.querySelectorAll('input[type=radio]')[1] as HTMLElement);
 expect(bind).not.toHaveBeenCalled();await click(button("查看原片"));
 expect((target.querySelector('video') as HTMLVideoElement).src).toContain(`/media/clip2?expected_media_id=${files[1].media_id}`);
 await click(button("匹配所选原片"));
 expect(bind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({nested_camera:"A"}),reply,files[1]);
 expect(wrapped.mock.calls[0][0]).toMatchObject({displaySourceName:"A018 · A018 C006 02.MP4",clipId:"clip2",mediaId:files[1].media_id,boundSource:{basis:"operator_selected_electronic_cell",bindingId:"bound",revision:1,selectionRevision:0}});
 expect(complete).not.toHaveBeenCalled();
});
it("a response containing a B candidate cannot be displayed/bound for the selected A cell",async()=>{
 get.mockResolvedValueOnce({...reply,candidates:[{...files[0],card:"B011",camera:"B",filename_camera:"B"}]});
 await render();await click(button("A 机 · C006"));
 expect(target.textContent).toContain("当前行或机位证据已变化");expect(target.querySelector('input[type=radio]')).toBeNull();expect(bind).not.toHaveBeenCalled();
});
