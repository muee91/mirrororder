import type {PaperRow} from "../../api/paperIntake";
import type {PaperCamera} from "../../api/paperCellReview";
import type {SlateFormField,SlateFormRow} from "./SlateOriginalFormSheet";
import type {LedgerRow} from "./SlateIntervalLedger";

const rawFields = ["scene_raw", "shot_raw", "take_raw", "content_raw", "atmosphere_raw", "audio_raw", "notes_raw",
 ...(["A","B","C"] as const).flatMap(camera=>(["clip_raw","framing_raw","ok_raw"] as const).map(field=>`cameras.${camera}.${field}`))];
const sha = (value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{64}$/.test(value);
const scalar = (value:unknown):string=>typeof value==="string"?value:typeof value==="number"&&Number.isFinite(value)?String(value):"";
const order = (a:unknown,b:unknown) => scalar(a).localeCompare(scalar(b),"zh",{numeric:true});
const ordinal = (value:unknown)=>/^[0-9]{1,8}$/.test(scalar(value))?Number(scalar(value)):0;
export type FormSourceTarget={rowId:string;digest:string;camera?:PaperCamera};

export function paperFormPages(rows:readonly PaperRow[]) {
 const grouped=new Map<string,PaperRow[]>();
 for(const row of rows){
   if(!sha(row.row_digest)||!row.document_id||!row.paper_row_id)continue;
   const key=JSON.stringify([row.document_id,scalar(row.page)]);
   const group=grouped.get(key);
   if(group)group.push(row);else grouped.set(key,[row]);
 }
 return [...grouped].map(([key,records])=>{
   const first=records[0];
   const header=(name:string)=>{
      const values=[...new Set(records.map(r=>scalar(r.raw_row[name])).filter(Boolean))];
      return values.length>1?"页眉有差异":values[0]??"";
   };
   return {key,page:{day:header("day_raw"),date:header("date_raw"),printedPage:header("printed_page")||scalar(first.page),title:"场记单"},
     records:[...records].sort((a,b)=>order(a.row,b.row))};
 }).sort((a,b)=>a.records[0].document_id.localeCompare(b.records[0].document_id)||order(a.records[0].page,b.records[0].page));
}

export function selectPaperFormTargets(target:FormSourceTarget, rows:readonly LedgerRow[]) {
 const verified=rows.filter(r=>r.paperRowId===target.rowId&&r.paperRowDigest===target.digest);
 const intervals=verified.filter(r=>r.interval&&(!target.camera||r.paperSourceCamera===target.camera));
 const exact=verified.find(r=>!r.interval);
 // The existing board suppresses the source-only row once any interval was
 // prepared, so create a view-only source inspector target for other cameras.
 const base=exact??verified[0];
 if(!base)return {intervals:[],source:undefined};
 const choices=base.cameraChoices?.filter(c=>(!target.camera||c.camera===target.camera)&&c.rowDigest===target.digest)??[];
 return {intervals,source: {id:`sheet:${target.rowId}:${target.camera??"row"}`,paper:base.paper,paperRowId:target.rowId,
   paperRowDigest:target.digest,sheetCameraExplicit:target.camera,cameraChoices:choices} satisfies LedgerRow};
}

export function toPaperFormRow(row:PaperRow,ledger:readonly LedgerRow[]):SlateFormRow{
 const cells:SlateFormRow["cells"]={};
 const original=new Map(row.raw_cells.map(c=>[c.cell,c.raw]));
 for(const field of rawFields){const value=scalar(original.get("/"+field.replaceAll(".","/")));if(value!=="")cells[field as SlateFormField]=value;}
 const corrections=ledger.filter(r=>r.paperRowId===row.paper_row_id&&r.paperRowDigest===row.row_digest&&r.interval&&(r.draft||r.verified)).flatMap(r=>{
   const pair=r.draft??r.verified;
   return pair?[{label:`第 ${pair.episode} 集 · ${pair.scene_id} 场${r.interval?.current?"":"（原片待重核）"}`,camera:r.paperSourceCamera,state:r.draft?"draft" as const:"confirmed" as const}]:[];
 });
 return {id:row.paper_row_id,digest:row.row_digest??"",line:ordinal(row.row),cells,corrections};
}
