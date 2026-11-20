// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GoldenSlateWorkbench } from './GoldenSlateWorkbench';
import { HostConnection, type ReviewModelPayload } from '../../api/host';
import { ProductionClient, type SlateBoard, type SlateRecord } from '../../api/production';
import { SlateRecordClient } from '../../api/slateRecords';
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const record = (id: string, scene: string): SlateRecord => ({record_id:id,scene,episode:1,shot:'1',take_number:id.charCodeAt(0)-96,status:'unmarked',source_group_id:'',script_scene_id:'',attachments:[],actor:'test',updated_at:'',note:'',preferred_clip_id:''});
let board: SlateBoard;
const upsert = vi.spyOn(SlateRecordClient.prototype,'upsert');
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); localStorage.clear(); localStorage.setItem('mirrororder.productionActor','test');
  board={version:2,contract:'script_supervisor.v2',revision:3,updated_at:'',records:{a:record('a','1'),b:record('b',''),c:record('c','')},entries:{},semantics:{}};
  vi.spyOn(HostConnection.prototype,'reviewModel').mockResolvedValue({episodes:[],take_groups:[]} as unknown as ReviewModelPayload);
  vi.spyOn(ProductionClient.prototype,'scriptSupervisor').mockResolvedValue(board);
  upsert.mockReset().mockImplementation(async(_project,write)=>({...board,revision:4,records:{...board.records,[write.recordId]:{...board.records[write.recordId],...write.record}}}));
  host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  await act(async()=>root.render(<GoldenSlateWorkbench baseUrl="http://synthetic.test" projectId="synthetic"/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const row=(id:string)=>[...host.querySelectorAll<HTMLTableRowElement>('.slate-row')].find(r=>r.querySelectorAll<HTMLInputElement>('input')[3]?.value===String(id.charCodeAt(0)-96))!;
const scene=(id:string)=>row(id).querySelectorAll<HTMLInputElement>('input')[1];
async function type(input:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function focus(input:HTMLInputElement){await act(async()=>input.focus());}
async function enter(input:HTMLInputElement,isComposing=false){await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing,bubbles:true,cancelable:true})));}
it('retains the same focused DOM input while an unplaced row crosses buckets, then commits grouping on Enter',async()=>{
  const input=scene('b'), originalRow=row('b');await focus(input);
  for(const value of ['1','12','123']){await type(input,value);expect(document.activeElement).toBe(input);expect(row('b')).toBe(originalRow);expect(input.closest('.is-unplaced')).not.toBeNull();}
  expect(upsert).not.toHaveBeenCalled();await enter(input);
  expect(scene('b').value).toBe('123');expect(row('b').closest('.is-placed')).not.toBeNull();expect(row('c').closest('.is-unplaced')).not.toBeNull();
});
it('keeps order and focus while clearing a placed row, supports another row and preserves selected inspector state',async()=>{
  await act(async()=>row('a').click());const input=scene('a');await focus(input);await type(input,'');
  expect(document.activeElement).toBe(input);expect(row('a').closest('.is-placed')).not.toBeNull();
  await act(async()=>input.blur());expect(row('a').closest('.is-unplaced')).not.toBeNull();expect(row('a').getAttribute('aria-current')).toBe('true');
  const other=scene('c');await focus(other);await type(other,'20');expect(document.activeElement).toBe(other);await enter(other);expect(row('c').closest('.is-placed')).not.toBeNull();
  expect(scene('a').value).toBe('');
});
it('does not treat IME Enter as completion and saves the full draft once via existing explicit Save',async()=>{
  const input=scene('b');await focus(input);await type(input,'场十二');await enter(input,true);expect(document.activeElement).toBe(input);
  await enter(input);const save=[...host.querySelectorAll('button')].find(b=>b.textContent==='保存 1')!;
  await act(async()=>save.click());expect(upsert).toHaveBeenCalledTimes(1);expect(upsert.mock.calls[0][1].record.scene).toBe('场十二');expect(host.textContent).toContain('全部保存完成');
});
it('retains draft and visible error when the existing save fails',async()=>{
  upsert.mockRejectedValueOnce(new Error('revision conflict'));const input=scene('b');await focus(input);await type(input,'12');await enter(input);
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='保存 1')!.click());
  expect(scene('b').value).toBe('12');expect(row('b').classList.contains('is-dirty')).toBe(true);expect(host.textContent).toContain('revision conflict');
});
it('keeps the row pinned when focus moves to another field in the same row', async () => {
  const input = scene('b');
  await focus(input);
  await type(input, '42');
  const shot = row('b').querySelectorAll<HTMLInputElement>('input')[2];
  await focus(shot);
  expect(document.activeElement).toBe(shot);
  expect(row('b').closest('.is-unplaced')).not.toBeNull();
  await type(shot, '9');
  expect(document.activeElement).toBe(shot);
  await enter(shot);
  expect(row('b').closest('.is-placed')).not.toBeNull();
  expect(scene('b').value).toBe('42');
});
