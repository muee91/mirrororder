import type {PaperDocument,PaperRow} from "../../api/paperIntake";
import type {Camera,SlateFormRow} from "./SlateOriginalFormSheet";

export const cameras=["A","B","C"] as const;
export const sourceField=(camera:Camera)=>`cameras.${camera}.clip_raw` as const;
export const collator=new Intl.Collator("zh-CN",{numeric:true,sensitivity:"base"});
export type BrowseMode="continuous"|"scene"|"pdf"|"transcript";
export type SortKind="source"|"clip"|"scene"|Camera;
export type BrowseRow=SlateFormRow&{kind:"paper"|"sync"|"manual";sequence:number;confirmed?:{episode:number;scene:string};pdf?:{key:string;page:number};browseGroup?:string};
export function pdfAnchor(row:PaperRow,document?:PaperDocument) {
 const claim=document?.source_document_digest_claim, source=document?.derived_lineage?.source;
 const value=row.raw_row.pdf_page;
 const page=typeof value==="number"||typeof value==="string"&&/^\d+$/.test(value)?Number(value):0;
 if(!claim||!/^[a-f0-9]{64}$/.test(claim)||!Number.isSafeInteger(page)||page<1)return undefined;
 const knownDocument=Number.isSafeInteger(document?.native_pdf_page_count)&&page<=(document?.native_pdf_page_count??0);
 const auditedPage=document?.transcription_origin==="explicit_reviewed_ocr_derivation"&&source?.pdf_sha256===claim&&
    Number.isSafeInteger(source.page_index)&&Number(source.page_index)===page-1;
 return knownDocument||auditedPage?{key:JSON.stringify([claim,page]),page}:undefined;
}
export function codeParts(label:string){
 const m=/^([ABC][0-9]{3})(C[0-9]+)(?:_|\.|$)/i.exec(label);
 return m?{card:m[1].toUpperCase(),code:m[2].toUpperCase()}:{card:"",code:label};
}
const compareEmptyLast=(a:string,b:string,desc:boolean)=>a&&b?(desc?-1:1)*collator.compare(a,b):a?-1:b?1:0;
const sceneCompare=(a:BrowseRow,b:BrowseRow,desc:boolean)=>!a.confirmed||!b.confirmed?(a.confirmed?-1:b.confirmed?1:0):
 (desc?-1:1)*(a.confirmed.episode-b.confirmed.episode||collator.compare(a.confirmed.scene,b.confirmed.scene));
export function browseRows(rows:readonly BrowseRow[], mode:BrowseMode,sort:SortKind,desc:boolean,query:string,pdfPage:string) {
 const q=query.trim().normalize("NFKC").toLocaleLowerCase();
 const matches=(r:BrowseRow)=>!q||cameras.some(c=>[r.cells[sourceField(c)],r.media?.[c]?.fileName].some(value=>value?.normalize("NFKC").toLocaleLowerCase().includes(q)));
 const choices=rows.filter(r=>(mode!=="pdf"||r.pdf?.key===pdfPage)&&matches(r));
 const compareClip=(a:BrowseRow,b:BrowseRow)=>{
   const angle=sort==="A"||sort==="B"||sort==="C"?[sort]:cameras;
   const aa=angle.map(c=>a.media?.[c]?.fileName??a.cells[sourceField(c)]??"").find(Boolean)??"",bb=angle.map(c=>b.media?.[c]?.fileName??b.cells[sourceField(c)]??"").find(Boolean)??"";
   const pa=codeParts(aa),pb=codeParts(bb);
   return compareEmptyLast(pa.code,pb.code,desc)||compareEmptyLast(pa.card,pb.card,desc)||compareEmptyLast(aa,bb,desc);
 };
 const original=(a:BrowseRow,b:BrowseRow)=>a.sequence-b.sequence||collator.compare(a.id,b.id);
 return choices.sort((a,b)=>{
   if(mode==="pdf")return a.line-b.line||original(a,b);
   if(mode==="scene"){
     const g=sceneCompare(a,b,desc);if(g)return g;
   }
   if(sort==="scene"){const g=sceneCompare(a,b,desc);return g||compareEmptyLast(a.cells.shot_raw??"",b.cells.shot_raw??"",desc)||compareEmptyLast(a.cells.take_raw??"",b.cells.take_raw??"",desc)||original(a,b);}
   if(sort==="source")return desc?-original(a,b):original(a,b);
   return compareClip(a,b)||original(a,b);
 }).map((row,i,all)=>{
   const label=(r:BrowseRow)=>r.confirmed?`第 ${r.confirmed.episode} 集 · ${r.confirmed.scene} 场`:"未归场";
   return mode==="scene"&&(!i||label(row)!==label(all[i-1]))?{...row,browseGroup:label(row)}:row;
 });
}


/** Source rows and sync rows are independent until explicitly associated. */
export function browseUniverse(all:readonly BrowseRow[], mode:BrowseMode, hasEvidence:boolean) {
 if(mode==="pdf")return all.filter(r=>r.kind==="paper"&&r.pdf);
 if(mode==="transcript")return all.filter(r=>r.kind==="paper"&&!r.pdf);
 const daily=all.filter(r=>r.kind!=="paper");
 // Generic structured-only projects retain their existing usable sheet.
 return daily.length||hasEvidence?daily:all;
}
