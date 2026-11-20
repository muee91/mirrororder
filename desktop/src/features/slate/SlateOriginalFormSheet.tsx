import {Fragment,useRef,useState,type KeyboardEvent} from "react";
import "./slate-original-form-sheet.css";

const CAMERAS=["A","B","C"] as const;
export type Camera=typeof CAMERAS[number];
export type CameraField=`cameras.${Camera}.${"clip_raw"|"framing_raw"|"ok_raw"}`;
export type SlateFormField="scene_raw"|"shot_raw"|"take_raw"|"atmosphere_raw"|"audio_raw"|"content_raw"|"notes_raw"|CameraField;
export type SlateFormMedia={state:"linked"|"not_connected"|"ambiguous"|"absent"|"unknown";fileName?:string;sourceCode?:string;thumbnailUrl?:string;card?:string;showCard?:boolean};
export type SlateFormSourceSelection={rowId:string;digest:string;camera:Camera};
export type SlateFormRow={fieldReview?:Partial<Record<SlateFormField,{label:string;editable:boolean}>>;paperHint?:{page:number;row:number;fields:Partial<Record<SlateFormField,{value:string;conflict:boolean}>>};browseGroup?:string;kind?:"paper"|"sync"|"manual";id:string;digest:string;line:number;cells:Partial<Record<SlateFormField,string>>; framing?:Partial<Record<Camera,string>>;media?:Partial<Record<Camera,SlateFormMedia>>;corrections?:readonly {label:string;camera?:Camera;state:"draft"|"confirmed"}[]};
export type SlateFormCellAction={rowId:string;digest:string;line:number;field:SlateFormField;raw:string;mode:"source"|"edit"|"framing";camera?:Camera;anchor:HTMLButtonElement};
type Column={field:SlateFormField;label:string;width:number;camera?:Camera;clip?:true;framing?:true};
const CAM_COLS=(c:Camera):Column[]=>[
 {field:`cameras.${c}.clip_raw`,label:c+"机",width:7.19,camera:c,clip:true},
 {field:`cameras.${c}.framing_raw`,label:"景别",width:4.5,camera:c,framing:true},
 {field:`cameras.${c}.ok_raw`,label:"OK",width:3.35,camera:c},
];
export const SLATE_FORM_COLUMNS:readonly Column[]=[
 {field:"scene_raw",label:"场号",width:4.38},{field:"shot_raw",label:"镜号",width:4.2},{field:"take_raw",label:"次数",width:4.2},{field:"atmosphere_raw",label:"气氛",width:5.6},
 ...CAMERAS.flatMap(CAM_COLS),
 {field:"audio_raw",label:"录音",width:5},{field:"content_raw",label:"拍摄内容",width:20.4},{field:"notes_raw",label:"备注",width:11.1},
];
const mediaLabels={linked:"已关联",not_connected:"未连接",ambiguous:"待选原片",absent:"未找到",unknown:""} as const;
function safeLabel(value?:string,max=180){
 const v=value?.trim();
 return v&&v.length<=max&&!/[\\/\u0000-\u001f\u007f]/.test(v)&&!/^([a-z]:|\w+:\/\/)/i.test(v)?v:"";
}
function clipDisplay(raw:string,media?:SlateFormMedia){
 const file=safeLabel(media?.fileName);
 const paper=raw.trim();
 const code=safeLabel(media?.sourceCode)||file||paper;
 const rawThumbnail=media?.state==="linked"?thumbnailUrl(media.thumbnailUrl):null;
 return {file,code,rawThumbnail,card:media?.showCard?safeLabel(media.card,32):"",status:media?mediaLabels[media.state]:""};
}
const numericFields=new Set<SlateFormField>(["scene_raw","shot_raw","take_raw"]);
function displayReview(label:string){
 if(label==="待复核")return {tone:"pending",value:""};
 if(label==="已清空")return {tone:"confirmed",value:""};
 for(const [prefix,tone] of [["已确认 ","confirmed"],["手工 ","confirmed"],["建议 ","suggested"]] as const){
  if(label.startsWith(prefix))return {tone,value:label.slice(prefix.length)};
 }
 return {tone:"pending",value:""};
}
function thumbnailUrl(input?:string):string|null{
 if(!input)return null;
 try{
  const url=new URL(input);
  if(url.protocol!=="blob:"||url.search||url.hash)return null;
  const slash=url.pathname.lastIndexOf("/");
  const uuid=url.pathname.slice(slash+1);
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid))return null;
  const owner=url.pathname.slice(0,slash);
  return owner==="null"||owner==="tauri://localhost"||owner===globalThis.location?.origin?url.href:null;
 }catch{return null;}
}
function SourceThumb({uri}:{uri:string}){
 const [failed,fail]=useState(false);
 if(failed)return null;
 return <img className="slate-paper-clip-image" src={uri} loading="lazy" decoding="async" alt="" draggable={false} onError={()=>fail(true)}/>;
}
type Props={
 page:{day:string;date:string;printedPage:string;title:string};
 rows:readonly SlateFormRow[];onCellAction?:(request:SlateFormCellAction)=>void;
 onReview?:()=>void;pendingCount?:number;canEditFraming?:boolean;onAddRow?:()=>void;addRowBusy?:boolean;activeSource?:SlateFormSourceSelection;onPaperHint?:(rowId:string)=>void;highlightRow?:string;
};
export function SlateOriginalFormSheet({page,rows,onCellAction,onReview,pendingCount,canEditFraming=false,onAddRow,addRowBusy=false,activeSource,onPaperHint,highlightRow}:Props){
 const buttons=useRef(new Map<string,HTMLButtonElement>());
 const key=(row:SlateFormRow,col:Column)=>JSON.stringify([row.id,col.field]);
 const focus=(r:number,c:number)=>{
  if(rows[r]&&SLATE_FORM_COLUMNS[c])buttons.current.get(key(rows[r],SLATE_FORM_COLUMNS[c]))?.focus();
 };
 const request=(row:SlateFormRow,col:Column,anchor:HTMLButtonElement,forceEdit=false)=>{
  const raw=row.cells[col.field]??"";
  onCellAction?.({rowId:row.id,digest:row.digest,line:row.line,field:col.field,raw,mode:col.framing&&canEditFraming?"framing":col.clip&&raw.trim()&&!forceEdit?"source":"edit",camera:col.camera,anchor});
 };
 const navigate=(e:KeyboardEvent<HTMLButtonElement>,row:SlateFormRow,col:Column,r:number,c:number)=>{
  if(e.altKey||e.metaKey||e.ctrlKey||e.nativeEvent.isComposing)return;
  let next:[number,number]|undefined;
  if(e.key==="ArrowUp")next=[r-1,c];
  if(e.key==="ArrowDown")next=[r+1,c];
  if(e.key==="ArrowLeft")next=[r,c-1];
  if(e.key==="ArrowRight")next=[r,c+1];
  if(e.key==="Home")next=[r,0];
  if(e.key==="End")next=[r,SLATE_FORM_COLUMNS.length-1];
  if(e.key==="Tab"){
   const offset=r*SLATE_FORM_COLUMNS.length+c+(e.shiftKey?-1:1);
   if(offset<0||offset>=rows.length*SLATE_FORM_COLUMNS.length)return;
   next=[Math.floor(offset/SLATE_FORM_COLUMNS.length),offset%SLATE_FORM_COLUMNS.length];
  }
  if(next){e.preventDefault();focus(...next);}
  if(e.key==="F2"){e.preventDefault();request(row,col,e.currentTarget,true);}
 };
 return <section className="slate-paper-form" aria-label="场记单">
  {(onReview||onAddRow)&&<div className="slate-paper-form-tools">
   {onAddRow&&<button type="button" className="slate-paper-add-row" disabled={addRowBusy} onClick={onAddRow}>新增一行</button>}
   {onReview&&(rows.length>0||(pendingCount??0)>0)&&<button type="button" onClick={onReview}>待复核{typeof pendingCount==="number"?" "+pendingCount:""}</button>}
  </div>}
  <div className="slate-paper-form-scroll">
   <table className="slate-paper-form-table">
    <caption><strong>{page.title?`《${page.title}》场记单`:"场记单"}</strong>{(page.day||page.date||page.printedPage)&&<details className="slate-paper-form-source"><summary>来源信息</summary><span className="slate-paper-form-meta">
     <span>第 <b>{page.day}</b> 天</span><span>日期：<b>{page.date}</b></span><span>页数：<b>{page.printedPage}</b></span>
    </span></details>}</caption>
    <colgroup>{SLATE_FORM_COLUMNS.map(col=><col key={col.field} style={{width:`${col.width}%`}}/>)}</colgroup>
    <thead><tr>{SLATE_FORM_COLUMNS.map(col=><th key={col.field} scope="col" className={col.clip?"slate-paper-camera-start":col.camera?"slate-paper-camera":undefined}>{col.label}</th>)}</tr></thead>
    <tbody>{rows.map((row,r)=><Fragment key={row.id}>{row.browseGroup&&<tr className="slate-paper-browse-group"><th scope="rowgroup" colSpan={SLATE_FORM_COLUMNS.length}>{row.browseGroup}</th></tr>}<tr key="data" data-slate-row={row.id} data-paper-located={row.id===highlightRow||undefined}>
     {SLATE_FORM_COLUMNS.map((col,c)=>{
      const raw=row.cells[col.field]??"";
      const refKey=key(row,col);
      const source=Boolean(col.clip&&raw.trim());
      const media=col.clip&&col.camera?row.media?.[col.camera]:undefined;
      const clip=source?clipDisplay(raw,media):undefined;
      const fieldReview=row.fieldReview?.[col.field];
      const actionable=!!onCellAction&&(row.kind!=="sync"||source||fieldReview?.editable);
      const selected=Boolean(col.clip&&activeSource?.rowId===row.id&&activeSource.digest===row.digest&&activeSource.camera===col.camera);
      const framing=col.framing&&col.camera?row.framing?.[col.camera]:undefined;
      const display=framing??raw;
      const canTag=canEditFraming&&row.kind!=="sync"&&row.kind!=="manual";
      const emptyFraming=canTag&&col.framing&&!display;
      if(numericFields.has(col.field)){
       const review=fieldReview?displayReview(fieldReview.label):undefined;
       const hint=row.paperHint?.fields[col.field];
       const originalOnly=col.field==="scene_raw"&&row.paperHint&&!Object.keys(row.paperHint.fields).length;
       const canJump=!!(row.paperHint&&onPaperHint&&!fieldReview&&(originalOnly||hint&&(!raw||hint.conflict)));
       const locator=row.paperHint?`PDF 第 ${row.paperHint.page} 页 · 第 ${row.paperHint.row} 行`:"";
       const hintLabel=hint?`${hint.conflict?"纸记不同":"建议"} ${hint.value}`:originalOnly?"原页可查":"";
       const corrected=col.field==="scene_raw"?row.corrections:undefined;
       const correctionLabels=corrected?.map(note=>`${note.camera?note.camera+"机 ":""}${note.state==="draft"?"草稿":"已确认"}：${note.label}`)??[];
       const text=review?review.value:raw||(!hint?.conflict?hint?.value:"")||"";
       const tone=review?.tone??(hint?.conflict?"pending":hint?"suggested":corrected?.some(note=>note.state==="draft")?"suggested":corrected?.length?"confirmed":originalOnly?"source":undefined);
       const context=[fieldReview?.label??hintLabel,...correctionLabels,locator].filter(Boolean).join(" · ");
       const label=`第 ${row.line} 行 ${col.label}${text?"："+text:"，空白"}${context?" · "+context:""}`;
       const renderValue=<span className="slate-paper-field-value">{text}</span>;
       const buttonRef=(button:HTMLButtonElement|null)=>{if(button)buttons.current.set(refKey,button);else buttons.current.delete(refKey);};
       return <td className="slate-paper-field" key={refKey} data-tone={tone} data-split={actionable&&canJump||undefined}>
        {actionable||canJump?<button className="slate-paper-field-main" type="button" ref={buttonRef} title={context||undefined} aria-label={label}
         onClick={e=>actionable?request(row,col,e.currentTarget):onPaperHint?.(row.id)}
         onKeyDown={e=>{if(actionable||e.key!=="F2")navigate(e,row,col,r,c);}}>{renderValue}</button>:
         <span className="slate-paper-field-main" aria-label={context?label:undefined} title={context||undefined} tabIndex={context?0:undefined}>{renderValue}</span>}
        {actionable&&canJump&&<button type="button" className="slate-paper-field-origin" onClick={()=>onPaperHint?.(row.id)}
         title={[hintLabel,locator].filter(Boolean).join(" · ")} aria-label={`查看原页 · ${col.label} · ${hintLabel} · ${locator}`}/>}
        {context&&<div className="slate-paper-field-tooltip" aria-hidden="true">{context}</div>}
       </td>;
      }
      return <td key={refKey} className={col.clip?"slate-paper-camera-start":col.field==="content_raw"||col.field==="notes_raw"?"slate-paper-long":undefined}>
       {actionable?<button type="button" className={source?"slate-paper-clip":framing?"slate-paper-tagged":emptyFraming?"slate-paper-empty-tag":undefined}
        ref={button=>{if(button)buttons.current.set(refKey,button);else buttons.current.delete(refKey);}}
        aria-current={selected?"true":undefined}
        data-slate-thumbnail={source&&media?.state==="linked"?row.id:undefined} data-slate-camera={source&&media?.state==="linked"?col.camera:undefined} data-slate-digest={source&&media?.state==="linked"?row.digest:undefined}
        title={fieldReview?.label??(clip?[clip.file||clip.code,clip.card,clip.status].filter(Boolean).join(" · "):undefined)}
        aria-label={fieldReview?`第 ${row.line} 行 ${col.label}：${fieldReview.label}`:`第 ${row.line} 行 ${!col.clip&&col.camera?col.camera+"机 ":""}${col.label}${display?"："+(clip?.file||clip?.code||display):emptyFraming?"，选景别":"，空白"}${clip?.card?"，"+clip.card:""}${clip?.status?"，"+clip.status:""}`}
        onClick={e=>request(row,col,e.currentTarget)} onKeyDown={e=>navigate(e,row,col,r,c)}>{clip?<>{media?.state==="linked"&&<span className="slate-paper-clip-well" aria-hidden="true">{clip.rawThumbnail&&<SourceThumb key={row.digest+":"+clip.rawThumbnail} uri={clip.rawThumbnail}/>}</span>}<span className="slate-paper-clip-code">{clip.code.split(/(?=[_.])/).map((part,i)=><Fragment key={i}>{i>0&&<wbr/>}{part}</Fragment>)}</span>{(clip.status||clip.card)&&<span className="slate-paper-clip-context">{[clip.card,clip.status].filter(Boolean).join(" · ")}</span>}</>:fieldReview?<span className="slate-paper-hint">{fieldReview.label}</span>:display|| (emptyFraming?"＋":null)}</button>:<span>{fieldReview&&!fieldReview.editable?<small>{fieldReview.label}</small>:null}{media?.state==="absent"&&row.kind==="sync"?<small className="slate-paper-clip-context">无素材</small>:display}</span>}
       {framing&&raw&&framing!==raw&&<small className="slate-paper-raw-framing">原：{raw}</small>}
      </td>;
     })}
    </tr></Fragment>)}
    {!rows.length&&Array.from({length:7},(_,i)=><tr className="slate-paper-blank-row" key={"blank-"+i} aria-hidden="true">{SLATE_FORM_COLUMNS.map(col=><td key={col.field} className={col.clip?"slate-paper-camera-start":undefined}/>)}</tr>)}
    </tbody>
   </table>
  </div>
 </section>;
}
