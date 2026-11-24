// @vitest-environment jsdom
import {act} from 'react';import {createRoot} from 'react-dom/client';import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {SlatePaperIntake} from './SlatePaperIntake';import {PaperIntakeClient,validatePaperInput,type PaperModel} from '../../api/paperIntake';import type {SlateCandidateState} from '../../api/desktop';
let el:HTMLDivElement,root:ReturnType<typeof createRoot>;const request=vi.spyOn(PaperIntakeClient.prototype,'request');const extractPhotoCandidates=vi.spyOn(PaperIntakeClient.prototype,'extractPhotoCandidates');
const view:PaperModel={contract:'mirrororder.paper_intake.v1',project_id:'p',revision:3,documents:[{document_id:'d',row_count:1,original_document_verified:false}],rows:[{paper_row_id:'r',document_id:'d',page:'1',row:'2',raw_row:{scene:'003'},raw_cells:[{cell:'/scene',raw:'003'}],normalized_fields:{scene:'003'},review_reasons:[],candidate_ready:true,confirmed:false}],summary:{total_rows:1,candidate_ready:1,review_required:1,confirmed:0}};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);request.mockReset().mockResolvedValue(view);extractPhotoCandidates.mockReset();el=document.createElement('div');document.body.append(el);root=createRoot(el)});afterEach(async()=>{await act(async()=>root.unmount());el.remove();vi.unstubAllGlobals()});
const button=(s:string)=>[...el.querySelectorAll('button')].find(b=>b.textContent===s)!;
async function render(){await act(async()=>root.render(<SlatePaperIntake baseUrl="http://synthetic.test" projectId="p"/>))}
async function input(value:string){await act(async()=>{const f=el.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(f,value);f.dispatchEvent(new Event('input',{bubbles:true}))})}
it('collapsed view does no IO; open only reads, no model or mutation',async()=>{await render();expect(request).not.toHaveBeenCalled();await act(async()=>button('纸面场记').click());expect(request).toHaveBeenCalledExactlyOnceWith('p');expect(button('导入转录原文').disabled).toBe(true);expect(el.textContent).toContain('可准备候选不代表已匹配')});
it('opens a dialog, closes from its header, and restores trigger focus on Escape',async()=>{await render();const trigger=button('纸面场记');await act(async()=>trigger.click());expect(el.querySelector('[role="dialog"]')).not.toBeNull();expect(el.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('纸面与照片场记');expect(button('关闭')).not.toBeNull();await act(async()=>button('关闭').click());expect(el.querySelector('.paper-intake-body')).toBeNull();await act(async()=>button('纸面场记').click());await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(el.querySelector('.paper-intake-body')).toBeNull();expect(document.activeElement).toBe(button('纸面场记'))});
it('explicit import sends unchanged transcription and revision once, preserves draft',async()=>{await render();await act(async()=>button('纸面场记').click());const raw='[{"page":"1","row":"2","scene":"003"}]';await input(raw);request.mockResolvedValue({...view,revision:4,import_status:'imported'});await act(async()=>{button('导入转录原文').click();button('导入转录原文').click()});expect(request).toHaveBeenCalledTimes(2);expect(request).toHaveBeenLastCalledWith('p',{content:raw,format:'json',expected_revision:3});expect(el.querySelector('textarea')!.value).toBe(raw);expect(el.textContent).toContain('没有写入正式场记')});
it('conflict retains input and disables retry until explicit refresh',async()=>{await render();await act(async()=>button('纸面场记').click());await input('[{"scene":"003"}]');request.mockRejectedValueOnce(new Error('场记来源已变化'));await act(async()=>button('导入转录原文').click());expect(el.textContent).toContain('场记来源已变化');expect(el.querySelector('textarea')!.value).toContain('003');expect(button('导入转录原文').disabled).toBe(true);await act(async()=>button('刷新来源').click());expect(button('导入转录原文').disabled).toBe(false)});
it('source selection preserves lexical cells and never confirms',async()=>{await render();await act(async()=>button('纸面场记').click());await act(async()=>{const select=el.querySelector('.paper-source-bar select') as HTMLSelectElement;select.value='r';select.dispatchEvent(new Event('change',{bubbles:true}))});expect(el.textContent).toContain('/scene');expect(el.textContent).toContain('003');expect(el.textContent).toContain('尚未确认');expect(request).toHaveBeenCalledTimes(1)});
it('invalid or oversized JSON is blocked before network',()=>{expect(validatePaperInput('x','json')).not.toBe('');expect(validatePaperInput('[]','json')).not.toBe('');expect(validatePaperInput(JSON.stringify(Array(2001).fill({})),'json')).not.toBe('');expect(validatePaperInput('中'.repeat(700000),'csv')).not.toBe('');expect(validatePaperInput('[{"scene":"003"}]','json')).toBe('')});

it('success collapses paste, focuses persistent source chooser and keeps bytes for reopening',async()=>{await render();await act(async()=>button('纸面场记').click());expect(el.querySelector('textarea')!.rows).toBe(3);await input('[{"scene":"003"}]');request.mockResolvedValue({...view,import_status:'imported'});await act(async()=>button('导入转录原文').click());expect(el.querySelector<HTMLDetailsElement>('.paper-paste')!.open).toBe(false);expect(document.activeElement).toBe(el.querySelector('.paper-source-bar select'));expect(el.querySelector('textarea')!.value).toBe('[{"scene":"003"}]');expect(el.querySelector('.paper-source-bar')).not.toBeNull()});
it('failed import keeps paste open and bytes, no source focus jump',async()=>{await render();await act(async()=>button('纸面场记').click());await input('[{"scene":"003"}]');request.mockRejectedValueOnce(new Error('冲突'));await act(async()=>button('导入转录原文').click());expect(el.querySelector<HTMLDetailsElement>('.paper-paste')!.open).toBe(true);expect(el.querySelector('textarea')!.value).toContain('003')});

it('preserves a literal shorthand cell and tells the operator to review it',async()=>{
  request.mockResolvedValue({...view,rows:[{...view.rows[0],raw_row:{scene:'->'},raw_cells:[{cell:'/scene',raw:'->'}],normalized_fields:{scene:'->'},review_reasons:['paper_scene_shorthand_requires_review'],candidate_ready:false}],summary:{...view.summary,candidate_ready:0}});
  await render();await act(async()=>{button('纸面场记').click();await Promise.resolve()});
  await act(async()=>{const select=el.querySelector('.paper-source-bar select') as HTMLSelectElement;select.value='r';select.dispatchEvent(new Event('change',{bubbles:true}))});
  expect(el.querySelector('.paper-raw')?.textContent).toContain('->');
  expect(el.textContent).toContain('纸面场号是简写符号，需核对明确场号。');
  expect(el.textContent).toContain('可准备候选 0 行');
  expect(request).toHaveBeenCalledTimes(1);
});

it('uploads a photo and renders the editable Chinese candidate review table',async()=>{
  vi.stubGlobal('FileReader',class { onload:(()=>void)|null=null;onerror:(()=>void)|null=null;readAsDataURL(){this.onload?.()}});
  extractPhotoCandidates.mockResolvedValue({contract:'paper_vlm_candidates.v1',authority:false,provider:'synthetic',model:'vision',page:'1',candidate_count:1,candidates:[{page:'1',row:3,episode:2,scene:'12',shot:'3A',take:'T2',status:'usable',note:'门口',confidence:.91,authority:false}]});
  await render();await act(async()=>button('纸面场记').click());
  const input=el.querySelector('.paper-photo-hero input[type="file"]')!;const file=new File(['photo'],'slate.jpg',{type:'image/jpeg'});
  Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  expect(extractPhotoCandidates).toHaveBeenCalledOnce();
  expect(el.querySelector('.paper-candidates-review')).not.toBeNull();
  expect(el.querySelector('thead')?.textContent).toContain('集');expect(el.querySelector('thead')?.textContent).toContain('场号');expect(el.querySelector('thead')?.textContent).toContain('镜号');expect(el.querySelector('thead')?.textContent).toContain('次号');expect(el.querySelector('thead')?.textContent).toContain('状态');expect(el.querySelector('thead')?.textContent).toContain('备注');
});

it('passes an edited photo candidate to draft intake without a backend write',async()=>{
  vi.stubGlobal('FileReader',class { onload:(()=>void)|null=null;onerror:(()=>void)|null=null;readAsDataURL(){this.onload?.()}});
  extractPhotoCandidates.mockResolvedValue({contract:'paper_vlm_candidates.v1',authority:false,provider:'synthetic',model:'vision',page:'1',candidate_count:1,candidates:[{page:'1',row:3,episode:2,scene:'12',shot:'3A',take:'T2',status:'usable',note:'门口',confidence:.91,authority:false}]});
  const onApplyDraftCandidates=vi.fn();await act(async()=>root.render(<SlatePaperIntake baseUrl="http://synthetic.test" projectId="p" onApplyDraftCandidates={onApplyDraftCandidates}/>));
  await act(async()=>{button('纸面场记').click();await Promise.resolve()});const input=el.querySelector('.paper-photo-hero input[type="file"]')!;const file=new File(['photo'],'slate.jpg',{type:'image/jpeg'});Object.defineProperty(input,'files',{configurable:true,value:[file]});await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  const scene=el.querySelector<HTMLInputElement>('input[aria-label="第 1 条候选场号"]')!;Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(scene,'12B');await act(async()=>scene.dispatchEvent(new Event('input',{bubbles:true})));
  await act(async()=>button('填入场记草稿 (1)').click());
  expect(onApplyDraftCandidates).toHaveBeenCalledOnce();expect(onApplyDraftCandidates).toHaveBeenCalledWith([expect.objectContaining({scene:'12B',authority:false})]);expect(request).toHaveBeenCalledTimes(1);expect(el.querySelector('.paper-intake-body')).toBeNull();
});

it('loads durable recognition candidates for review without auto-filling drafts',async()=>{
  const recognition:SlateCandidateState={contract:'slate_candidates.v1',project_id:'p',slate_attached:true,slate_name:'slate.pdf',status:'completed',revision:2,pages_total:1,pages_done:1,candidates:[{page:'1',row:3,episode:2,scene:'12',shot:'3A',take:'T2',status:'usable',note:'门口',confidence:.91,authority:false}],warning:'',error:'',provider:'synthetic',model:'vision',started_at:'',completed_at:'',updated_at:'',task_id:'task_1'};
  const onApplyDraftCandidates=vi.fn();const onStartRecognition=vi.fn();
  await act(async()=>root.render(<SlatePaperIntake baseUrl="http://synthetic.test" projectId="p" open recognition={recognition} onApplyDraftCandidates={onApplyDraftCandidates} onStartRecognition={onStartRecognition}/>));
  await act(async()=>{await Promise.resolve();await Promise.resolve()});
  expect(el.textContent).toContain('slate.pdf');
  expect(el.textContent).toContain('识别完成，共 1 条候选');
  expect(el.querySelector('.paper-candidates-review')).not.toBeNull();
  expect(onApplyDraftCandidates).not.toHaveBeenCalled();
  expect(extractPhotoCandidates).not.toHaveBeenCalled();
  expect(onStartRecognition).not.toHaveBeenCalled();
  await act(async()=>button('填入场记草稿 (1)').click());
  expect(onApplyDraftCandidates).toHaveBeenCalledOnce();
  expect(onApplyDraftCandidates).toHaveBeenCalledWith([expect.objectContaining({scene:'12',take:'T2',authority:false})]);
});
