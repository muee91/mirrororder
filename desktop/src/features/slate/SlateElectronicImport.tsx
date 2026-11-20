import {useRef,useState} from "react";
import {validatePaperInput} from "../../api/paperIntake";

export type ElectronicSlateIngest=(content:string,format:"json"|"csv")=>Promise<{count:number;duplicate:boolean}>;
const MAX_BYTES=2_000_000;
export function SlateElectronicImport({ingest,refresh}:{ingest:ElectronicSlateIngest;refresh:()=>Promise<void>}) {
  const [selected,setSelected]=useState<File>();
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const locked=useRef(false);
  const picker=useRef<HTMLInputElement>(null);
  async function submit(){
    if(!selected||locked.current)return;
    const m=/\.(json|csv)$/i.exec(selected.name);
    if(!m){setNotice("请选择 .json 或 .csv 电子场记文件。");return;}
    if(!selected.size||selected.size>MAX_BYTES){setNotice("电子场记文件为空或超过 2 MB，请检查后重选。");return;}
    const format=m[1].toLowerCase() as "json"|"csv";
    locked.current=true;setBusy(true);setNotice("正在读取电子表…");
    try {
      const text=await selected.text(), error=validatePaperInput(text,format);
      if(error){setNotice(error);return;}
      const result=await ingest(text,format);
      setSelected(undefined);if(picker.current)picker.current.value="";
      const message=result.duplicate?`这份电子表已导入。场记板共有 ${result.count} 行。`:`已保存电子原文。场记板共有 ${result.count} 行，仍需核对原片和集场。`;
      setNotice(message);
      try{await refresh();}catch{setNotice(`${message} 列表未能刷新，请重读。`);}
    }catch(e){setNotice(e instanceof Error?e.message:"导入未完成；已保留选中的文件。");}
    finally{locked.current=false;setBusy(false);}
  }
  return <details className="sil-electronic-import">
    <summary>导入电子场记</summary>
    <p>选现有场记表（JSON 或 CSV）。保留原始行。核对原片后，确认集和场。</p>
    <form onSubmit={(e)=>{e.preventDefault();void submit();}}>
      <label>电子场记文件<input ref={picker} type="file" accept=".json,.csv,application/json,text/csv" disabled={busy} onChange={(e)=>{setSelected(e.target.files?.length===1?e.target.files[0]:undefined);setNotice("")}}/></label>
      <button type="submit" disabled={!selected||busy}>导入所选电子表</button>
    </form>
    <p role="status">{notice}</p>
  </details>;
}
