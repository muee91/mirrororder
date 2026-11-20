import { fetchWithTimeout } from './requestWithTimeout';
import type { ProjectTaskRecord } from './tasks';
export interface SpeechRuntime {profile:string;available:boolean;status:string;model:string;max_clip_seconds:number}
export interface SpeechEvidence {contract:'mirrororder.speech_evidence.v1';status:'missing'|'available';clip_id:string;media_id:string;backend:string|null;coordinate_space:'source-relative-seconds';segments:{start:number;end:number;text:string}[];outcome:'not-transcribed'|'transcribed'|'no-speech'}
export class SpeechEvidenceClient {
 readonly baseUrl:string;
 constructor(baseUrl:string){this.baseUrl=baseUrl.trim().replace(/\/+$/,'');if(!/^https?:\/\//i.test(this.baseUrl))throw new Error('Host 地址无效');}
 private async json<T>(path:string,init?:RequestInit):Promise<T>{const r=await fetchWithTimeout(this.baseUrl+path,{...init,headers:{Accept:'application/json',...(init?.body?{'Content-Type':'application/json'}:{})}});if(!r.ok){let message=`请求失败 (${r.status})`;try{const body=await r.json();if(typeof body.error==='string')message=body.error;}catch{}throw new Error(message);}return r.json() as Promise<T>;}
 runtime(){return this.json<SpeechRuntime>('/api/v1/assistant/speech-runtime');}
 async evidence(projectId:string,clipId:string){const data=await this.json<SpeechEvidence>(`/api/v1/projects/${encodeURIComponent(projectId)}/speech-evidence?clip_id=${encodeURIComponent(clipId)}`);if(data.contract!=='mirrororder.speech_evidence.v1'||data.coordinate_space!=='source-relative-seconds'||data.clip_id!==clipId||!Array.isArray(data.segments)||data.segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||typeof s.text!=='string'))throw new Error('转写证据格式或素材身份不一致');return data;}
 submit(projectId:string,clipId:string,key:string){if(!projectId.trim()||!clipId.trim())throw new Error('请选择原素材');return this.json<ProjectTaskRecord>(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,{method:'POST',body:JSON.stringify({type:'transcribe',targets:{clip_ids:[clipId],speech_runtime:'local-mlx-small-v1',mapping_policy:'suggest-only',prompt_policy:'none'},actor:'desktop-v2',idempotency_key:key})});}
}
