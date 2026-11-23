import {fetchWithTimeout} from './requestWithTimeout';
export interface PaperRow {paper_row_id:string;row_digest?:string;document_id:string;page:string|number;row:string|number;raw_row:Record<string,unknown>;raw_cells:{cell:string;raw:unknown}[];normalized_fields:Record<string,string>;review_reasons:string[];candidate_ready:boolean;confirmed:false}
export type PaperDocument={document_id:string;digest?:string;source_document_digest_claim?:string|null;row_count:number;original_document_verified:false;transcription_origin?:string;native_pdf_page_count?:number;derived_lineage?:{source?:{page_index?:number;pdf_sha256?:string}}};
export interface PaperModel {contract:'mirrororder.paper_intake.v1';project_id:string;revision:number;documents:PaperDocument[];rows:PaperRow[];summary:{total_rows:number;candidate_ready:number;review_required:number;confirmed:0};import_status?:'imported'|'already_imported'}
export interface PaperVlmCandidate {page:string;row:number;episode:number|null;scene:string;shot:string;take:string;status:'usable'|'partial'|'ng'|'unmarked';note:string;confidence:number;authority:false}
export interface PaperVlmExtractResult {contract:'paper_vlm_candidates.v1'|string;authority:false;provider:string;model:string;page:string;candidate_count:number;candidates:PaperVlmCandidate[];warning?:string}
export function validatePaperInput(content:string,format:'json'|'csv'):string {if(!content.trim())return '请先粘贴转录内容';if(new TextEncoder().encode(content).length>2000000)return '内容超过 2 MB，请分批导入';if(format==='json'){try{const value=JSON.parse(content);const rows=Array.isArray(value)?value:value?.rows;if(!Array.isArray(rows)||!rows.length||rows.length>2000||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))return 'JSON 须包含 1–2000 行对象';}catch{return 'JSON 格式不完整，请检查后导入'}}return '';}
export class PaperIntakeClient {
 constructor(readonly baseUrl:string){}
 async request(projectId:string,body?:{content:string;format:'json'|'csv';expected_revision:number}):Promise<PaperModel>{
 const url=`${this.baseUrl.replace(/\/+$/,'')}/api/v1/projects/${encodeURIComponent(projectId)}/${body?'script-supervisor-parse':'script-supervisor-paper'}`;
 const response=await fetchWithTimeout(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'structured_slate_log.v1',operation:'ingest',...body})}:undefined);
 if(!response.ok)throw new Error(response.status===409?'场记来源已变化，请刷新后重新核对再导入':`读取或导入场记失败 (${response.status})`);
 const view=await response.json() as PaperModel;
 if(view.contract!=='mirrororder.paper_intake.v1'||view.project_id!==projectId||!Number.isSafeInteger(view.revision)||view.revision<0||!Array.isArray(view.rows)||!Array.isArray(view.documents)||!view.summary)throw new Error('场记来源格式或项目不一致');return view;
 }
 async extractPhotoCandidates(imageBase64:string,pageLabel='1'):Promise<PaperVlmExtractResult>{
 const url=`${this.baseUrl.replace(/\/+$/,'')}/api/v1/assistant/paper-slate-ocr`;
 const response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_base64:imageBase64,page_label:pageLabel})},60000);
 if(!response.ok){let msg=`手写场记识别失败 (${response.status})`;try{const err=await response.json() as {error?:string};if(err.error)msg=err.error}catch{/* ignore */}throw new Error(msg)}
 return await response.json() as PaperVlmExtractResult;
 }
 async extractFileCandidates(filePath:string,pageLabel='1'):Promise<PaperVlmExtractResult>{
 const url=`${this.baseUrl.replace(/\/+$/,'')}/api/v1/assistant/paper-slate-ocr`;
 const response=await fetchWithTimeout(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_path:filePath,page_label:pageLabel})},60000);
 if(!response.ok){let msg=`场记文件识别失败 (${response.status})`;try{const err=await response.json() as {error?:string};if(err.error)msg=err.error}catch{/* ignore */}throw new Error(msg)}
 return await response.json() as PaperVlmExtractResult;
 }
}
