// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {SlateIntervalBoardSurface} from "./SlateIntervalBoardSurface";
import type {LedgerRow} from "./SlateIntervalLedger";

const scan=vi.fn();
vi.mock("../media/MediaBindingWorkbench",()=>({
 MediaBindingWorkbench:({projectId,baseUrl}:{projectId:string;baseUrl:string})=><section aria-label="原有素材恢复" data-project={projectId} data-host={baseUrl}><button onClick={scan}>原有连接任务</button></section>
}));
const refresh=vi.fn(async()=>{});
const ingest=vi.fn(async()=>({count:558,duplicate:false}));
const stage=vi.fn();
let host:HTMLElement,root:ReturnType<typeof createRoot>;
const raw={document:"doc",page:7,line:6,raw:"场：—"};
const missing:LedgerRow={id:"missing",paper:raw};
const correction:LedgerRow={id:"mid",paper:{...raw,line:7},interval:{clipLabel:"A001 C006",start:500,endExclusive:650,fps:"50",current:true,evidence:{evidence_id:"e",expected_evidence_version:2,expected_evidence_sha256:"a".repeat(64)}}};
const grouped:LedgerRow={...correction,id:"group",paper:{...raw,line:8},verified:{episode:9,scene_id:"S6"}};
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);scan.mockClear();refresh.mockClear();ingest.mockClear();stage.mockClear()});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()});
function render(rows:LedgerRow[]=[],importElectronic?:typeof ingest){return act(async()=>root.render(<SlateIntervalBoardSurface baseUrl="http://native.synthetic" projectId="existing-project" snapshot={{revision:1,draftRevision:1,rows}} catalog={[]} refresh={refresh} stageCorrection={stage} importElectronic={importElectronic}/>))}
const button=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===name)!;
async function chooseFile(f:File){await act(async()=>{const input=host.querySelector('input[type=file]')!;Object.defineProperty(input,"files",{configurable:true,value:[f]});input.dispatchEvent(new Event("change",{bubbles:true}))})}
it("calls the existing project scanner only via a local CTA, then resets focus and refreshes without starting a scan",async()=>{
 await render([missing]);await act(async()=>button("待复核 1").click());const trigger=button("连接原片…");expect(document.querySelector('[aria-label="原有素材恢复"]')).toBeNull();expect(button("存为修正草稿")).toBeUndefined();
 await act(async()=>trigger.click());const scanner=document.querySelector('[aria-label="原有素材恢复"]')!;
 expect(scanner.getAttribute("data-project")).toBe("existing-project");expect(scanner.getAttribute("data-host")).toBe("http://native.synthetic");
 const back=button("返回场记板并刷新");expect(document.activeElement).toBe(back);expect(scan).not.toHaveBeenCalled();
 await act(async()=>back.click());expect(refresh).toHaveBeenCalledTimes(1);expect(document.activeElement).toBe(trigger);expect(host.textContent).toContain("可继续核对原片");
});
it("prioritizes rows which already have original intervals and separates pending work counts",async()=>{
 await render([missing,correction,grouped]);
 await act(async()=>button("待复核 2").click());
 expect(host.querySelector('button.sil-row[aria-current=true]')?.textContent).toBe("7:7");
 expect(button("补集场 1")).toBeDefined();expect(button("待匹配原片 1")).toBeDefined();
 await act(async()=>button("待匹配原片 1").click());expect(host.querySelector('button.sil-row[aria-current=true]')?.textContent).toBe("7:6");
 expect(button("连接原片…")).toBeDefined();expect(button("存为修正草稿")).toBeUndefined();expect(stage).not.toHaveBeenCalled();
});
it("empty board imports structured file explicitly, without starting OCR or a scanner",async()=>{
 await render([],ingest);
 expect(host.querySelector("table[aria-hidden=true]")).toBeNull();expect(host.querySelector("details.slate-import-optional")?.hasAttribute("open")).toBe(false);const payload=JSON.stringify({rows:[{pdf_page:7,row_index:6,cameras:{A:{clip_raw:"C006"}}}]});
 const f=new File([payload],"present-electronic-slate.json",{type:"application/json"});
 Object.defineProperty(f,"text",{value:async()=>payload});await chooseFile(f);
 expect(ingest).not.toHaveBeenCalled();await act(async()=>button("导入所选电子表").click());
 expect(ingest).toHaveBeenCalledExactlyOnceWith(payload,"json");
 expect(host.textContent).toContain("场记板共有 558 行");expect(refresh).toHaveBeenCalledTimes(1);expect(stage).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
});
it("rejects an invalid local file before using the existing ingest path",async()=>{
 await render([],ingest);await chooseFile(new File(["pdf"],"slate.pdf",{type:"application/pdf"}));
 await act(async()=>button("导入所选电子表").click());expect(ingest).not.toHaveBeenCalled();expect(host.textContent).toContain("请选择 .json 或 .csv");
});
