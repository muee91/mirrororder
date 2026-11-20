import type {PaperRow,PaperDocument} from "../../api/paperIntake";
import {SlatePaperFormSurface,type SheetFramingController,type SheetFirstController} from "./SlatePaperFormSurface";
import {PdfDraftClient} from "../../api/paperPdfDraft";
import {useLayoutEffect,useRef,useState} from "react";
import {MediaBindingWorkbench} from "../media/MediaBindingWorkbench";
import {SlateElectronicImport,type ElectronicSlateIngest} from "./SlateElectronicImport";
import {SlateIntervalLedger,type SlateIntervalLedgerProps} from "./SlateIntervalLedger";

/** Reuses the project's existing scanner; merely opening it never selects or scans a folder. */
export function SlateIntervalBoardSurface({baseUrl,projectId,projectName,importElectronic,formRows,formDocuments,framingControl,sheetFirst,...ledger}:{baseUrl:string;projectId:string;projectName?:string;importElectronic?:ElectronicSlateIngest;formRows?:readonly PaperRow[];formDocuments?:readonly PaperDocument[];framingControl?:SheetFramingController;sheetFirst?:SheetFirstController}&SlateIntervalLedgerProps) {
  const [repair,setRepair]=useState(false);
  const [review,setReview]=useState(false);
  const [returnState,setReturnState]=useState("");
  const [pdfStatus,setPdfStatus]=useState("");
  const [pdfBusy,setPdfBusy]=useState(false);
  const pdfLock=useRef(false);
  const surface=useRef<HTMLDivElement>(null),back=useRef<HTMLButtonElement>(null),lastFocus=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    if(repair){back.current?.focus();return;}
    if(lastFocus.current){
      const source=lastFocus.current.isConnected?lastFocus.current:surface.current?.querySelector<HTMLElement>("button.sil-row[aria-current=true]");
      source?.focus();lastFocus.current=null;
    }
  },[repair]);
  function open(trigger:HTMLButtonElement){
    lastFocus.current=trigger;
    setReturnState("");setRepair(true);
  }
  function close(){
    setRepair(false);
    setReturnState("正在重读素材连接…");
    void ledger.refresh().then(()=>{setReturnState("已刷新素材连接；可继续核对原片。");if(document.activeElement===document.body)surface.current?.querySelector<HTMLElement>("button.sil-row[aria-current=true]")?.focus();}).catch(()=>setReturnState("未能刷新素材连接，原有输入已保留。"));
  }
  async function registerSource(){
    if(pdfLock.current)return;
    pdfLock.current=true;setPdfBusy(true);setPdfStatus("");
    try{
      const client=new PdfDraftClient();
      const model=await client.read(projectId);
      const receipt=await client.select(projectId,model.revision);
      if(receipt.status==="cancelled")return;
      if(receipt.draft.authority!==false||receipt.draft.ocr_state!=="not_run"||!/^[a-f0-9]{64}$/.test(receipt.draft.pdf_sha256)
        ||!Number.isSafeInteger(receipt.draft.page_count)||receipt.draft.page_count<1)throw Error("PDF 来源回执不一致");
      await ledger.refresh();
      setPdfStatus(`已登记本机 PDF · ${receipt.draft.page_count} 页，未重新识别。`);
    }catch(e){setPdfStatus(e instanceof Error?e.message:"未能登记原 PDF。");}
    finally{pdfLock.current=false;setPdfBusy(false);}
  }
  return <>
    <div ref={surface} hidden={repair}>
      <div hidden={review}><SlatePaperFormSurface formRows={formRows??[]} formDocuments={formDocuments} title={projectName} framingControl={framingControl} sheetFirst={sheetFirst}
        baseUrl={baseUrl} projectId={projectId} ledger={{...ledger,onOpenMediaBinding:open}} onReview={()=>setReview(true)}/>
        {importElectronic&&<details className="slate-import-optional"><summary>导入电子场记（可选）</summary><SlateElectronicImport ingest={importElectronic} refresh={ledger.refresh}/>
          <button type="button" disabled={pdfBusy} onClick={()=>void registerSource()}>登记原 PDF 来源</button>
          {pdfStatus&&<p role="status">{pdfStatus}</p>}</details>}
      </div>
      {review&&<button type="button" onClick={()=>setReview(false)}>返回场记表</button>}
      <div hidden={!review}><SlateIntervalLedger {...ledger} onOpenMediaBinding={open}/></div>
    </div>
    {repair&&<section className="sil-repair-view" aria-label="连接场记原片" onKeyDown={(e)=>{if(e.key==="Escape"&&!e.defaultPrevented){e.preventDefault();close();}}}>
      <header className="sil-toolbar"><button type="button" ref={back} onClick={close}>返回场记板并刷新</button><small>只恢复本机链接。扫描进行中也可返回，不会取消任务。</small></header>
      <MediaBindingWorkbench baseUrl={baseUrl} projectId={projectId} entry="slate"/>
    </section>}
    {!!returnState&&!repair&&<p role="status" className="sil-return-status">{returnState}</p>}
  </>;
}
