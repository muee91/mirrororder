// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GoldenSlateWorkbench } from './GoldenSlateWorkbench';
import { HostConnection, type ReviewModelPayload } from '../../api/host';
import { ProductionClient, type SlateBoard, type SlateRecord } from '../../api/production';
import { SlateRecordClient } from '../../api/slateRecords';
vi.mock('./SlatePaperIntake', () => ({ SlatePaperIntake: () => null }));
vi.mock('./SlateWorkbench', () => ({ SlateWorkbench: () => null }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const record = (id: string, scene: string): SlateRecord => ({record_id:id,scene,episode:1,shot:'1',take_number:id.charCodeAt(0)-96,status:'unmarked',source_group_id:'',script_scene_id:'',attachments:[],actor:'test',updated_at:'',note:'',preferred_clip_id:''});
let board: SlateBoard;
const upsert = vi.spyOn(SlateRecordClient.prototype,'upsert');
const parseSlate = vi.spyOn(ProductionClient.prototype,'parseSlate');
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); localStorage.clear(); localStorage.setItem('mirrororder.productionActor','test');
  board={version:2,contract:'script_supervisor.v2',revision:3,updated_at:'',records:{a:record('a','1'),b:record('b',''),c:record('c','')},entries:{},semantics:{}};
  vi.spyOn(HostConnection.prototype,'reviewModel').mockResolvedValue({episodes:[],take_groups:[]} as unknown as ReviewModelPayload);
  vi.spyOn(ProductionClient.prototype,'scriptSupervisor').mockResolvedValue(board);
  parseSlate.mockReset().mockResolvedValue({result:{episode:1,scene:'12',shot:'B',take_number:2,status:'usable',note:'可用',range_hint:'',angle_shots:{}}} as any);
  upsert.mockReset().mockImplementation(async(_project,write)=>({...board,revision:4,records:{...board.records,[write.recordId]:{...board.records[write.recordId],...write.record}}}));
  host=document.createElement('div'); document.body.append(host); root=createRoot(host);
  await act(async()=>root.render(<GoldenSlateWorkbench baseUrl="http://synthetic.test" projectId="synthetic"/>));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const row = (id: string) => host.querySelector<HTMLTableRowElement>(`.slate-row[data-record-id="${id}"]`)!;
const scene=(id:string)=>row(id).querySelectorAll<HTMLInputElement>('input')[1];
async function type(input:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function focus(input:HTMLInputElement){await act(async()=>input.focus());}
async function enter(input:HTMLInputElement,isComposing=false){await act(async()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing,bubbles:true,cancelable:true})));}
it('keeps Quick Entry 2 inline in the open Inspector and focuses it with slash', async () => {
  const inspector = host.querySelector('.golden-slate-inspector')!;
  const quick = inspector.querySelector<HTMLInputElement>('.golden-slate-quick input');
  expect(quick).not.toBeNull();
  expect(quick?.placeholder).toContain('看画面快录');
  await act(async () => host.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(quick);
});

it('opens collapsed Quick Entry 2 as a focused floating island, applies Enter, and dismisses with Escape', async () => {
  await clickButton('检视');
  expect(host.querySelector('.golden-slate-inspector')?.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('.golden-slate-quick')).toBeNull();

  await clickButton('快录 /');
  let floating = host.querySelector<HTMLInputElement>('.golden-slate-quick-floating input');
  expect(floating).not.toBeNull();
  expect(document.activeElement).toBe(floating);

  await act(async () => floating!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(host.querySelector('.golden-slate-quick-floating')).toBeNull();
  expect(document.activeElement?.textContent).toBe('快录 /');

  await act(async () => host.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })));
  floating = host.querySelector<HTMLInputElement>('.golden-slate-quick-floating input');
  expect(floating).not.toBeNull();
  expect(document.activeElement).toBe(floating);
  await type(floating!, '12场 B近 可用');
  await enter(floating!);
  expect(parseSlate).toHaveBeenCalledWith('synthetic', '12场 B近 可用', expect.anything());
  expect(scene('b').value).toBe('12');

  await act(async () => host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(host.querySelector('.golden-slate-quick-floating')).toBeNull();
});

it('retains the same focused DOM input while an unplaced row crosses buckets, then commits grouping on Enter',async()=>{
  await clickButton('拍摄顺序');
  const input=scene('b'), originalRow=row('b');await focus(input);
  for(const value of ['1','12','123']){await type(input,value);expect(document.activeElement).toBe(input);expect(row('b')).toBe(originalRow);expect(input.closest('.is-unplaced')).not.toBeNull();}
  expect(upsert).not.toHaveBeenCalled();await enter(input);
  expect(scene('b').value).toBe('123');expect(row('b').closest('.is-placed')).not.toBeNull();expect(row('c').closest('.is-unplaced')).not.toBeNull();
});
it('keeps order and focus while clearing a placed row, supports another row and preserves selected inspector state',async()=>{
  await clickButton('拍摄顺序');
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
  await clickButton('拍摄顺序');
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

async function mixedOrder() {
  board.records = {a: record('a', '20'), b: record('b', ''), c: record('c', '10')};
  await act(async () => root.render(<GoldenSlateWorkbench key="mixed" baseUrl="http://synthetic.test" projectId="synthetic"/>));
}
const visibleIds = () => [...host.querySelectorAll<HTMLTableRowElement>('.slate-row')].map(r => r.dataset.recordId);
const numbers = () => [...host.querySelectorAll('.slate-row .col-index strong')].map(n => n.textContent);
it('bypasses the shared review cache when the editor explicitly refreshes the slate', async () => {
  await clickButton('刷新场记');
  expect(HostConnection.prototype.reviewModel).toHaveBeenLastCalledWith('synthetic', { force: true });
});

async function clickButton(label: string) {
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click());
}

async function largeBoard(count: number, active = true, revealId?: string) {
  board.records = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `record-${index}`;
    return [id, record(id, '')];
  }));
  await act(async () => root.render(<GoldenSlateWorkbench key={count} baseUrl="http://synthetic.test" projectId="synthetic"
    active={active} focus={revealId ? { projectId: 'synthetic', recordId: revealId } : undefined} />));
}
it('mounts 60 rows normally and windows larger sections, preserving numbering and draft edits across scrolls', async () => {
  await largeBoard(60);
  expect(visibleIds()).toHaveLength(60);
  expect(host.querySelector('.slate-virtual-spacer')).toBeNull();

  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  await largeBoard(200);
  expect(visibleIds()).toHaveLength(13);
  const scroller = host.querySelector<HTMLElement>('.golden-slate-section-scroll')!;
  const spacers = () => [...scroller.querySelectorAll<HTMLTableCellElement>('.slate-virtual-spacer td')];
  expect(spacers().map(cell => cell.colSpan)).toEqual([10, 10]);
  expect((spacers()[1].firstElementChild as HTMLElement).style.height).toBe(`${187 * 105}px`);

  async function scroll(index: number) {
    scroller.scrollTop = index * 105;
    scroller.dispatchEvent(new Event('scroll'));
    scroller.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    await act(async () => frames.shift()!(0));
  }
  await scroll(100);
  expect(visibleIds()[0]).toBe('record-94');
  expect(numbers()[0]).toBe('095');
  expect(row('record-0')).toBeNull();
  await focus(scene('record-100'));
  await type(scene('record-100'), '42');
  await scroll(0);
  expect(row('record-100')).toBeNull();
  await scroll(100);
  expect(scene('record-100').value).toBe('42');
  expect(upsert).not.toHaveBeenCalled();
});

it('disconnects hidden section measurements, refines row size on resize, and reveals a distant requested record', async () => {
  let resize!: () => void;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  await largeBoard(150);
  const scroller = host.querySelector<HTMLElement>('.golden-slate-section-scroll')!;
  expect(observe).toHaveBeenCalledWith(scroller);
  const rowRects = vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLTableRowElement) {
    return DOMRect.fromRect({ y: this.sectionRowIndex * 100, height: 100 });
  });
  try {
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 });
    resize();
    await act(async () => frames.shift()!(0));
    expect(visibleIds()).toHaveLength(11);
    expect((scroller.querySelector('.slate-virtual-spacer:last-child td > div') as HTMLElement).style.height).toBe('13900px');
    await largeBoard(150, false);
    expect(disconnect).toHaveBeenCalledOnce();
    scroller.scrollTop = 3000;
    scroller.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(0);
    expect(visibleIds()[0]).toBe('record-0');
    await largeBoard(150, true, 'record-140');
    expect(row('record-140')?.getAttribute('aria-current')).toBe('true');
    expect(numbers()).toContain('141');
    expect(visibleIds()).toHaveLength(16);
  } finally {
    rowRects.mockRestore();
  }
});
it('defaults to shooting order, numbers rows in visible order, and inherits the actual preceding row', async () => {
  await mixedOrder();
  expect(visibleIds()).toEqual(['a', 'b', 'c']);
  expect(numbers()).toEqual(['001', '002', '003']);
  await act(async () => row('b').click());
  await clickButton('同上');
  expect(scene('b').value).toBe('20');
  expect(visibleIds()).toEqual(['a', 'b', 'c']);
  expect(upsert).not.toHaveBeenCalled();
});
it('uses continuous visible numbering and inheritance across the placed/unplaced split in script order', async () => {
  await mixedOrder();
  await clickButton('拍摄顺序');
  expect(visibleIds()).toEqual(['c', 'a', 'b']);
  expect(numbers()).toEqual(['001', '002', '003']);
  await act(async () => row('b').click());
  await clickButton('同上');
  expect(scene('b').value).toBe('20');
});
it('has no previous row for the first shooting row even when it follows another scene in script order', async () => {
  await mixedOrder();
  await act(async () => row('a').click());
  await clickButton('同上');
  expect(scene('a').value).toBe('20');
  expect(host.textContent).toContain('当前没有上一条场记可沿用');
});

it.each([
  { mode: '剧本归位', visible: ['c', 'a', 'd', 'b'], previous: 'a' },
  { mode: '拍摄顺序', visible: ['a', 'b', 'c', 'd'], previous: 'c' },
])('copies the scene identity of a different predecessor in $mode', async ({ mode, visible, previous }) => {
  board.records = {
    a: { ...record('a', '20'), script_scene_id: 'SC_1_20', status: 'usable' },
    b: record('b', ''),
    c: { ...record('c', '10'), script_scene_id: 'SC_1_10', status: 'partial' },
    d: { ...record('d', '30'), episode: 2, script_scene_id: 'SC_2_30', note: '原备注', usable_range: { start: 2, end: 4 } },
  };
  await act(async () => root.render(<GoldenSlateWorkbench key={mode} baseUrl="http://synthetic.test" projectId="synthetic"/>));
  if (mode === '剧本归位') await clickButton('拍摄顺序');
  expect(visibleIds()).toEqual(visible);
  expect(numbers()).toEqual(['001', '002', '003', '004']);
  await act(async () => row('d').click());
  await clickButton('同上');
  await clickButton('保存当前行');
  expect(upsert).toHaveBeenCalledOnce();
  expect(upsert.mock.calls[0][1]).toMatchObject({
    recordId: 'd',
    record: {
      scene: board.records[previous].scene,
      script_scene_id: board.records[previous].script_scene_id,
      status: board.records[previous].status,
      episode: 1,
      take_number: 4,
      note: '原备注',
      usable_range: { start: 2, end: 4 },
    },
  });
  expect(numbers()).toEqual(['001', '002', '003', '004']);
});

it('restores a deleted manual record’s derived Take and keeps unrelated local drafts', async () => {
  board.records = { a: { ...record('a', '1'), source_group_id: 'g1' }, b: record('b', '') };
  vi.mocked(HostConnection.prototype.reviewModel).mockResolvedValue({
    episodes: [], take_groups: [{
      group_id: 'g1', take_index: 1, candidates: [], automatic_state: { status: 'unassigned' },
      effective_mapping: { episode_ids: [], script_segment_ids: [] }, transcript: { text: '' }, angles: [],
    }],
  } as unknown as ReviewModelPayload);
  const deleteRecord = vi.spyOn(SlateRecordClient.prototype, 'delete').mockImplementation(async () => ({
    ...board, revision: 4, records: { b: board.records.b },
  }));
  const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
  try {
    await act(async () => root.render(<GoldenSlateWorkbench key="deletion" baseUrl="http://synthetic.test" projectId="synthetic"/>));
    await type(scene('b'), '55');
    await act(async () => row('a').click());
    await clickButton('删除人工场记…');
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(row('a')).not.toBeNull();
    await clickButton('删除人工场记…');
    expect(deleteRecord).toHaveBeenCalledExactlyOnceWith('synthetic', expect.objectContaining({ recordId: 'a', expectedRevision: 3, actor: 'test' }));
    expect(visibleIds()).toEqual(['derived-g1', 'b']);
    expect(numbers()).toEqual(['001', '002']);
    expect(scene('b').value).toBe('55');
    expect(row('b').classList.contains('is-dirty')).toBe(true);

    await act(async () => row('derived-g1').click());
    expect([...host.querySelectorAll('button')].some(button => button.textContent === '删除人工场记…' || button.textContent === '移除草稿…')).toBe(false);
    await clickButton('空白');
    expect(visibleIds()).toHaveLength(3);
    await clickButton('移除草稿…');
    expect(visibleIds()).toEqual(['derived-g1', 'b']);
    expect(deleteRecord).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
  } finally {
    confirm.mockRestore();
    deleteRecord.mockRestore();
  }
});
