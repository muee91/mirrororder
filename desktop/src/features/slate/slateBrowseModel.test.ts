import {describe,expect,it} from "vitest";
import {browseRows,pdfAnchor,type BrowseRow} from "./slateBrowseModel";
import type {PaperRow} from "../../api/paperIntake";
const digest="a".repeat(64);
const row=(id:string,sequence:number,label:string):BrowseRow=>({kind:"sync",id,digest,line:sequence,sequence,cells:{"cameras.A.clip_raw":label}});
describe("sheet browse model",()=>{
 it("natural A clip order is stable, card searchable, missing last even descending",()=>{
   const rows=[row("ten",0,"A001C010_261110"),row("two",1,"A001C002_261110"),row("blank",2,""),row("two-other",3,"A002C002_261110")];
   expect(browseRows(rows,"continuous","A",false,"","").map(r=>r.id)).toEqual(["two","two-other","ten","blank"]);
   expect(browseRows(rows,"continuous","A",true,"","").map(r=>r.id)).toEqual(["ten","two-other","two","blank"]);
   expect(browseRows(rows,"continuous","source",false,"a002", "").map(r=>r.id)).toEqual(["two-other"]);
   expect(rows.map(r=>r.id)).toEqual(["ten","two","blank","two-other"]);
 });
 it("groups only confirmed pairs; PDF raw row sequence ignores sort and needs audited provenance",()=>{
   const rows=[row("a",0,"A001C010"),{...row("b",1,"A001C002"),confirmed:{episode:7,scene:"10"}}];
   const groups=browseRows(rows,"scene","clip",false,"","");
   expect(groups.map(r=>r.browseGroup)).toEqual(["第 7 集 · 10 场","未归场"]);
   const paper={raw_row:{pdf_page:12}} as unknown as PaperRow;
   const declared={document_id:"d",row_count:1,original_document_verified:false as const,source_document_digest_claim:digest};
   expect(pdfAnchor(paper,declared)).toBeUndefined();
   expect(pdfAnchor(paper,{...declared,native_pdf_page_count:20})?.page).toBe(12);
   expect(pdfAnchor(paper,{...declared,native_pdf_page_count:10})).toBeUndefined();
   const proof=pdfAnchor(paper,{...declared,transcription_origin:"explicit_reviewed_ocr_derivation",derived_lineage:{source:{page_index:11,pdf_sha256:digest}}})!;
   expect(proof.page).toBe(12);
   expect(browseRows(rows.map((r,i)=>({...r,pdf:proof,line:2-i})),"pdf","A",true,"",proof.key).map(r=>r.id)).toEqual(["b","a"]);
 });
});

it("does not concatenate a real 558-row PDF to the 694 daily synced rows",async()=>{
 const {browseUniverse}=await import("./slateBrowseModel");
 const evidence={key:"doc-p1",page:1};
 const daily=Array.from({length:694},(_,i)=>row("d"+i,i,"C"+i));
 const original=Array.from({length:558},(_,i)=>({...row("raw"+i,1000+i,"C"+i),kind:"paper" as const,pdf:evidence}));
 expect(browseUniverse([...daily,...original],"continuous",true)).toHaveLength(694);
 expect(browseRows(browseUniverse([...daily,...original],"pdf",true),"pdf","source",true,"","doc-p1")).toHaveLength(558);
 expect(browseUniverse(original,"continuous",true)).toHaveLength(0);
 expect(browseUniverse([{...original[0],pdf:undefined}],"continuous",false)).toHaveLength(1);
});
