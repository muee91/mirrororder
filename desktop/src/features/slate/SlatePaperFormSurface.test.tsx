// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {PaperRow} from "../../api/paperIntake";
import type {LedgerRow} from "./SlateIntervalLedger";
import {SlatePaperFormSurface} from "./SlatePaperFormSurface";
import {SlateOriginalPlayback} from "./SlateOriginalPlayback";

const hash="a".repeat(64), digest=(n:number)=>n.toString(16).padStart(64,"0");
const make=(page:number,index:number):PaperRow=>({paper_row_id:`p${page}r${index}`,row_digest:digest(page*100+index),document_id:"synthetic",page,row:index,raw_row:{day_raw:"1",date_raw:"合成",printed_page:String(page)},
 raw_cells:[{cell:"/scene_raw",raw:"原值 ↓7"},{cell:"/cameras/A/clip_raw",raw:"c006"},{cell:"/cameras/B/clip_raw",raw:"c006"}],normalized_fields:{},review_reasons:[],confirmed:false,candidate_ready:false});
const records=[make(1,3),make(2,1),make(2,2)];
const association=(raw:PaperRow, id:string, paperSourceCamera?:"A"|"B"):LedgerRow=>({
 id,paper:{document:"doc",page:Number(raw.page),line:Number(raw.row),raw:"合成转录"},
 paperRowId:raw.paper_row_id,paperRowDigest:raw.row_digest,paperSourceCamera,
 cameraChoices:(["A","B"] as const).map(camera=>({camera,rawCode:"c006",rawCell:`/cameras/${camera}/clip_raw`,rowDigest:raw.row_digest!,status:"literal"})),
 interval:{clipLabel:id,sourceIdentity:{clipId:id,mediaId:`M_${"a".repeat(24)}`,assetRevision:"v2"},start:40,endExclusive:90,fps:"25",current:true,
 evidence:{evidence_id:id,expected_evidence_version:1,expected_evidence_sha256:hash}},
 verified:{episode:4,scene_id:"7-2"}
});
let node:HTMLDivElement, root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);node=document.createElement("div");document.body.append(node);root=createRoot(node)});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals()});
const buttons=(prefix:string)=>[...node.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.textContent)?.startsWith(prefix))!;
const click=(element:HTMLElement)=>act(async()=>element.click());
const reads=vi.fn(),stage=vi.fn(),approve=vi.fn(),onReview=vi.fn(),refresh=async()=>{};
const render=(rows:LedgerRow[])=>act(async()=>root.render(<SlatePaperFormSurface formRows={records} onReview={onReview} ledger={{snapshot:{rows,revision:4,draftRevision:0},catalog:[],stageCorrection:stage,approveCorrection:approve,refresh,
 paperEvidence:row=>{if(row.sheetCameraExplicit)reads(row.sheetCameraExplicit,row.paperRowDigest);return <p>核对指定机位</p>},
 rangeEvidence:(row,open)=>row.interval?.sourceIdentity&&<SlateOriginalPlayback baseUrl="http://127.0.0.1:8765" projectId="p" source={row.interval.sourceIdentity} startOpen={open}/>}}/>));
it("retains page and raw scene while one exact camera presents guarded Play controls, never autoplay",async()=>{
 await render([association(records[1],"test-A","A")]);
 const source=buttons("第 1 行 A机");expect(source).toBeTruthy();
 expect(node.textContent).toContain("原值 ↓7");expect(node.textContent).toContain("A机 已确认：第 4 集 · 7-2 场");
 await click(source);const video=node.querySelector("video")!;
 expect(video.getAttribute("src")).toContain("expected_media_id=M_");
 expect(video.getAttribute("preload")).toBe("none");expect(video.autoplay).toBe(false);
 expect(node.querySelector("select")?.selectedOptions[0].textContent).toBe("连续");
 await click(buttons("返回表格"));expect(node.querySelector("video")).toBeNull();expect(document.activeElement).toBe(source);
 expect(stage).not.toHaveBeenCalled();expect(approve).not.toHaveBeenCalled();
});
it("other camera never reuses an existing A interval, and ambiguous exact occurrences need a choice",async()=>{
 await render([association(records[1],"test-A","A"),association(records[1],"test-A-2","A"),association(records[1],"legacy-index-only")]);
 await click(buttons("第 1 行 B机"));expect(node.querySelector("video")).toBeNull();expect(reads).toHaveBeenLastCalledWith("B",records[1].row_digest);
 await click(buttons("第 1 行 A机"));expect(node.querySelector("video")).toBeNull();expect(node.textContent).toContain("请明确选中一个");
 const select=[...node.querySelectorAll("select")].find(s=>Array.from(s.options).some(o=>o.value==="test-A-2"))!;
 expect(Array.from(select.options).some(o=>o.value==="legacy-index-only")).toBe(false);
 await act(async()=>{select.value="test-A-2";select.dispatchEvent(new Event("change",{bubbles:true}))});
 expect(node.querySelector("video")?.getAttribute("src")).toContain("test-A-2");
});
it("tags the selected camera only without remounting its open video and confirms only the exact interval", async()=>{
 const record=records[1], interval=association(record,"video-A","A"), model={contract:"mirrororder.framing_tags.v1" as const,workspace_scope:"owned",paper_revision:1,revision:0,catalog:["远景","全景","中景","近景","特写"],tags:[]};
 const set=vi.fn(async()=>{}), stage=vi.fn(async()=>({revision:4,draft_revision:1,draft:{status:"review_draft" as const,editorial_authority:false as const}}));
 const approve=vi.fn(async()=>({revision:5,draft_revision:2,approved:["video-A"],export_ready:false as const}));
 const catalog=[{episode:4,scene_id:"7-2"}];
 const draft={episode:4,scene_id:"7-2",draft_id:"draft",targets:[interval.interval!.evidence],status:"review_draft" as const};
 const draw=(drafted=false)=>act(async()=>root.render(<SlatePaperFormSurface formRows={records} onReview={onReview} framingControl={{model,set}} ledger={{
   snapshot:{rows:[{...interval,verified:undefined,draft:drafted?draft:undefined}],revision:4,draftRevision:drafted?1:0},
   catalog,stageCorrection:stage,approveCorrection:approve,refresh,
   rangeEvidence:(row,open)=>row.interval?.sourceIdentity&&<SlateOriginalPlayback baseUrl="http://127.0.0.1:8765" projectId="p" source={row.interval.sourceIdentity} startOpen={open}/>
 }}/>));
 await draw();await click(buttons("第 1 行 A机"));
 const player=node.querySelector("video");
 await click(buttons("第 1 行 A机 景别"));await click(buttons("近景"));
 expect(set).toHaveBeenCalledExactlyOnceWith({paper_row_id:record.paper_row_id,row_digest:record.row_digest,camera:"A",tag:"近景",add_custom:false});
 expect(node.querySelector("video")).toBe(player);
 const pair=[...node.querySelectorAll("select")].find(s=>Array.from(s.options).some(o=>o.value===JSON.stringify([4,"7-2"])))!;
 await act(async()=>{pair.value=JSON.stringify([4,"7-2"]);pair.dispatchEvent(new Event("change",{bubbles:true}))});
 await click(buttons("存为修正草稿"));
 expect(stage).toHaveBeenCalledExactlyOnceWith({episode:4,scene_id:"7-2",mode:"script_scene",expected_revision:4,expected_draft_revision:0,selected:[interval.interval!.evidence]});
 await draw(true);await click(buttons("确认这 1 条集场"));
 expect(approve).toHaveBeenCalledExactlyOnceWith({draft_id:"draft",expected_revision:4,expected_draft_revision:1});
 expect(node.textContent).toContain("原值 ↓7");
});
it("renders an empty real spreadsheet and can add a manual row before any import",async()=>{
 const empty={contract:"mirrororder.sheet_first.v1" as const,workspace_scope:"owned",index_sha256:hash,revision:0,manual_rows:[],sync_groups:[],sync_group_count:0};
 const add=vi.fn(async(fields:Record<string,string>,req:string)=>({...empty,revision:1,manual_rows:[{row_id:"sheet-manual-"+req,sequence:1,fields}]}));
 const edit=vi.fn(async(change:{row_id:string;field:string;value:string})=>({...(await add.mock.results[0].value),revision:2,manual_rows:[{row_id:change.row_id,sequence:1,fields:{[change.field]:change.value}}]}));
 const draw=(model:typeof empty|Awaited<ReturnType<typeof add>>)=>act(async()=>root.render(<SlatePaperFormSurface formRows={[]} onReview={onReview} sheetFirst={{model,add,edit}}
  ledger={{snapshot:{rows:[],revision:0,draftRevision:0},catalog:[],stageCorrection:stage,refresh}}/>));
 await draw(empty);
 expect(node.querySelectorAll("table th")).toHaveLength(16);
 expect(node.querySelectorAll("table tbody tr")).toHaveLength(7);
 expect(node.textContent).not.toContain("导入");
 await click(buttons("新增一行"));
 const content=[...node.querySelectorAll("label")].find(l=>l.textContent==="拍摄内容")?.querySelector("input")!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(content,"合成工作记录");content.dispatchEvent(new Event("input",{bubbles:true}));});
 await click(buttons("保存这行"));
 expect(add).toHaveBeenCalledTimes(1);
 const [fields,rid]=add.mock.calls[0];
 expect(fields).toEqual({content_raw:"合成工作记录"});
 expect(rid).toMatch(/^[0-9a-f]{32}$/);
 await draw(await add.mock.results[0].value);
 expect(node.querySelectorAll("table tbody tr")).toHaveLength(1);
 expect(node.querySelector("table")?.textContent).toContain("合成工作记录");
 await click(buttons("第 1 行 拍摄内容"));
 const input=node.querySelector<HTMLInputElement>('form[aria-label="编辑手工场记格"] input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"修正工作记录");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await click(buttons("保存这格"));
 expect(edit).toHaveBeenCalledExactlyOnceWith({row_id:"sheet-manual-"+rid,field:"content_raw",value:"修正工作记录"});
 await draw(await edit.mock.results[0].value);
 expect(node.querySelector("table")?.textContent).toContain("修正工作记录");
});
it("can show and play the exact existing sync camera before importing, without fabricating scene numbers",async()=>{
 const model={contract:"mirrororder.sheet_first.v1" as const,workspace_scope:"owned",index_sha256:hash,revision:0,manual_rows:[],
 sync_group_count:1,sync_groups:[{group_id:"group",sources:[
  {camera:"A" as const,clip_id:"camera-A",media_id:`M_${"a".repeat(24)}`,label:"card-a",connection:"linked" as const},
  {camera:"C" as const,clip_id:"camera-C",media_id:`M_${"c".repeat(24)}`,label:"card-c",connection:"linked" as const}]}]};
 await act(async()=>root.render(<SlatePaperFormSurface baseUrl="http://127.0.0.1:8765" projectId="p" formRows={[]} onReview={onReview} sheetFirst={{model,add:vi.fn()}}
   ledger={{snapshot:{rows:[],revision:0,draftRevision:0},catalog:[],stageCorrection:stage,refresh}}/>));
 const tr=node.querySelector("table tbody tr")!;
 expect(tr.querySelector("td")?.textContent).toBe("");
 expect(tr.textContent).toContain("card-c");
 expect(node.textContent).toContain("场次和镜次未确认时留空");
 vi.spyOn(HTMLMediaElement.prototype,"play").mockResolvedValue();
 await click(buttons("第 1 行 C机"));
 expect(node.querySelector("video")?.getAttribute("src")).toContain("camera-C");
 expect(node.querySelector("video")?.getAttribute("src")).not.toContain("camera-A");
});
it("retains exact playing element and currentTime through reorder/group/search hide/reveal",async()=>{
  const row=association(records[1],"sticky-A","A"), second=association(records[2],"other-A","A");
  await render([row,second]);await click(buttons("第 1 行 A机"));
  const video=node.querySelector<HTMLVideoElement>("video")!;video.currentTime=7.25;
  const set=async(selector:string,value:string)=>act(async()=>{const el=node.querySelector<HTMLSelectElement>(selector)!;el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  const same=()=>{expect(node.querySelector("video")).toBe(video);expect(video.currentTime).toBe(7.25);expect(video.src).toContain("sticky-A");};
  await set(".slate-browse-tools label:nth-of-type(2) select","A");same();
  await click(buttons("切换升降序"));same();
  await set(".slate-browse-tools label:first-of-type select","scene");same();
  expect(node.textContent).toContain("未归场");
  const input=node.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"never-find-me");input.dispatchEvent(new Event("input",{bubbles:true}));});
  same();expect(node.textContent).toContain("不在当前视图");
  await click(buttons("显示所选行"));same();
  expect(node.querySelector('button[aria-current="true"]')?.getAttribute("aria-label")).toContain("A机");
  expect(node.textContent).not.toContain("PDF 原页");
});

it("keeps PDF records in physical pages, separate from the live synced table",async()=>{
 const first=make(1,1);first.raw_row.pdf_page=1;
 const pdf=make(12,1);
 pdf.raw_row.pdf_page=27; // Intentionally different from stored folio.
 const document={document_id:pdf.document_id,row_count:1,original_document_verified:false as const,source_document_digest_claim:hash,native_pdf_page_count:27};
 const model={contract:"mirrororder.sheet_first.v1" as const,workspace_scope:"owned",index_sha256:hash,revision:0,manual_rows:[],
 sync_group_count:1,sync_groups:[{group_id:"synced-first",sources:[
  {camera:"A" as const,clip_id:"syncedA",media_id:`M_${"a".repeat(24)}`,label:"A001C123"},
  {camera:"C" as const,clip_id:"syncedC",media_id:`M_${"c".repeat(24)}`,label:"C001C123"}]}]};
 await act(async()=>root.render(<SlatePaperFormSurface baseUrl="http://127.0.0.1:8765" projectId="scope-pdf" formRows={[first,pdf]} formDocuments={[document]} onReview={onReview} sheetFirst={{model,add:vi.fn()}}
   ledger={{snapshot:{rows:[],revision:0,draftRevision:0},catalog:[],stageCorrection:stage,refresh}}/>));
 expect(node.querySelectorAll("tr[data-slate-row]")).toHaveLength(1);
 expect(node.querySelector("tr[data-slate-row]")?.getAttribute("data-slate-row")).toBe("synced-first");
 await click(buttons("按 PDF 原页复核"));
 expect(node.querySelectorAll("tr[data-slate-row]")).toHaveLength(1);
 expect(node.querySelector("tr[data-slate-row]")?.getAttribute("data-slate-row")).toBe(first.paper_row_id);
 const jump=node.querySelector<HTMLInputElement>(".slate-pdf-jump input")!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(jump,"27");jump.dispatchEvent(new Event("input",{bubbles:true}));});
 await click(buttons("跳转"));
 expect(node.querySelector("tr[data-slate-row]")?.getAttribute("data-slate-row")).toBe(pdf.paper_row_id);
 expect(node.textContent).toContain("PDF 第 27 页");
 expect(node.textContent).toContain("未关联的纸行仍在");
});
it("keeps paper values advisory, locating only the exact registered page row",async()=>{
 const first=make(1,1);first.raw_row.pdf_page=1;
 const target=make(27,2);target.raw_row.pdf_page=27;
 const adjacent=make(27,3);adjacent.raw_row.pdf_page=27;
 const origin={document_id:"synthetic",row_count:3,original_document_verified:false as const,source_document_digest_claim:hash,native_pdf_page_count:27};
 const add=vi.fn(), edit=vi.fn();
 const scope={pdf_sha256:hash,pdf_page:27,row_index:2,paper_row_id:target.paper_row_id,row_digest:target.row_digest!};
 const draw=async(stale=false)=>act(async()=>root.render(<SlatePaperFormSurface formRows={[first,target,adjacent]} formDocuments={[origin]} onReview={onReview} sheetFirst={{add,edit,model:{
  contract:"mirrororder.sheet_first.v1",workspace_scope:"owned",index_sha256:hash,revision:0,manual_rows:[],
  sync_group_count:2,sync_groups:["group-1","group-2"].map(group_id=>({group_id,sources:[]})),
  paper_suggestions:{contract:"mirrororder.paper_field_suggestions.v1",editorial_authority:false,paper_revision:1,groups:{
    "group-1":{state:"paper_suggestion",fields:{shot:{state:"suggested",value:"12"},take:{state:"conflict",paper_value:"8"}},source:{...scope,row_digest:stale?digest(0):scope.row_digest},human_confirmed:false,source_interval_verified:false},
    "group-2":{state:"source_only",fields:{},source:scope,human_confirmed:false,source_interval_verified:false}
  }}
 }}} ledger={{snapshot:{rows:[],revision:0,draftRevision:0},catalog:[],stageCorrection:stage,refresh}}/>));
 await draw(true);expect(buttons("第 1 行 镜号：12")).toBeUndefined();
 await draw();expect(buttons("第 1 行 镜号：12")).toBeTruthy();expect(node.querySelector('button[title^="原页可查"]')).toBeTruthy();
 expect(node.querySelector('button[title^="纸记不同 8"]')).toBeTruthy();
 await click(buttons("第 1 行 镜号：12"));
 expect(node.querySelector("select")?.value).toBe("pdf");
 expect(node.querySelector("tr[data-paper-located]")?.getAttribute("data-slate-row")).toBe(target.paper_row_id);
 expect(node.querySelectorAll("tr[data-slate-row]")).toHaveLength(2);
 expect(node.textContent).toContain("原值 ↓7");
 expect(add).not.toHaveBeenCalled();expect(edit).not.toHaveBeenCalled();
});
it("confirms, corrects, or clears a single suggested field and retains the exact paper source",async()=>{
 const record=make(2,1);record.raw_row.pdf_page=2;
 const source={pdf_sha256:hash,pdf_page:2,row_index:1,paper_row_id:record.paper_row_id,row_digest:record.row_digest!};
 const doc={document_id:record.document_id,row_count:1,original_document_verified:false as const,source_document_digest_claim:hash,native_pdf_page_count:2};
 const annotate=vi.fn(async (_:import("../../api/slateIntervalBoard").PaperAnnotationRequest):Promise<import("../../api/slateIntervalBoard").PaperAnnotationReading>=>({state:"adopt",token:hash,revision:1,value:"12",suggestion:"12",source}));
 const draw=(state:"suggested"|"adopt"|"clear"|"needs_review",revision:number,value:string|null=null)=>act(async()=>root.render(<SlatePaperFormSurface formDocuments={[doc]} formRows={[record]} onReview={onReview} sheetFirst={{add:vi.fn(),annotate,model:{
  contract:"mirrororder.sheet_first.v1",workspace_scope:"owned",index_sha256:hash,revision:0,manual_rows:[],sync_group_count:1,
  sync_groups:[{group_id:"one",sources:[]}],
  paper_suggestions:{contract:"mirrororder.paper_field_suggestions.v1",editorial_authority:false,paper_revision:1,groups:{one:{state:"paper_suggestion",fields:{shot:{state:"suggested",value:"12"}},source,human_confirmed:false,source_interval_verified:false}}},
  paper_field_annotations:{one:{shot:state==="needs_review"?{state}:{state,token:hash,revision,value,suggestion:"12",source}}}
 }}} ledger={{snapshot:{rows:[],revision:0,draftRevision:0},catalog:[],stageCorrection:stage,refresh}}/>));
 await draw("suggested",0);
 await click(buttons("第 1 行 镜号：12"));
 expect(node.textContent).toContain("未确认");
 await click(buttons("采用这格的建议"));
 expect(annotate).toHaveBeenLastCalledWith({group_id:"one",field:"shot",expected_token:hash,expected_revision:0,mode:"adopt",value:null});
 await draw("adopt",1,"12");
 expect(node.querySelector('td[data-tone="confirmed"] .slate-paper-field-value')?.textContent).toBe("12");
 expect(node.querySelector('td[data-tone="confirmed"] button')?.getAttribute("title")).toContain("已确认 12");
 const correction=node.querySelector<HTMLInputElement>('form[aria-label="核对当前场记字段"] input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(correction,"07");correction.dispatchEvent(new Event("input",{bubbles:true}));});
 await click(buttons("保存更正"));
 expect(annotate).toHaveBeenLastCalledWith({group_id:"one",field:"shot",expected_token:hash,expected_revision:1,mode:"manual",value:"07"});
 await click(buttons("清空这格"));
 expect(annotate).toHaveBeenLastCalledWith({group_id:"one",field:"shot",expected_token:hash,expected_revision:1,mode:"clear",value:null});
 await draw("clear",2);
 expect(node.querySelector('td[data-tone="confirmed"] button')?.getAttribute("title")).toContain("已清空");expect(buttons("采用这格的建议")).toBeUndefined();
 await click(buttons("查看 PDF 第 2 页"));
 expect(node.querySelector("tr[data-paper-located]")?.getAttribute("data-slate-row")).toBe(record.paper_row_id);
 const mode=node.querySelector<HTMLSelectElement>('.slate-browse-tools select')!;
 await act(async()=>{mode.value="continuous";mode.dispatchEvent(new Event("change",{bubbles:true}));});
 await draw("needs_review",3);
 expect(node.querySelector('td[data-tone="pending"] .slate-paper-field-value')?.textContent).toBe("");
 expect(node.querySelector('td[data-tone="pending"] [title]')?.getAttribute("title")).toContain("待复核");
});
