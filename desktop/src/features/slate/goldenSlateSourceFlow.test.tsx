// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoldenSlateWorkbench } from './GoldenSlateWorkbench';
import { HostConnection, type ReviewModelPayload } from '../../api/host';
import { ProductionClient, type SlateBoard } from '../../api/production';
import { SlateRecordClient } from '../../api/slateRecords';
import { SceneIntervalClient, type IntervalReadModel } from '../../api/sceneIntervals';
import { ProjectTaskClient } from '../../api/tasks';
import type { SheetFirstModel } from '../../api/slateIntervalBoard';
import type { SlateIntervalLedgerProps } from './SlateIntervalLedger';

vi.mock('./SlatePaperIntake', () => ({ SlatePaperIntake: () => null }));
vi.mock('./SlateWorkbench', () => ({ SlateWorkbench: () => null }));
vi.mock('./SlateSpeechEvidencePanel', () => ({ SlateSpeechEvidencePanel: () => null }));
vi.mock('./useNativeSlateIntervalLedger', () => ({ useNativeSlateIntervalLedger: () => ({ available: true, ledger }) }));

const hash = 'a'.repeat(64);
const sources = (['A', 'B', 'C'] as const).map(camera => ({ camera, clip_id: `clip-${camera}`, media_id: `M_${camera.toLowerCase().repeat(24)}`,
  label: `${camera}001C001.mp4`, connection: 'linked' as const }));
const sheet: SheetFirstModel = { contract: 'mirrororder.sheet_first.v1', workspace_scope: 'synthetic', index_sha256: hash, revision: 0,
  manual_rows: [], sync_groups: [{ group_id: 'g1', sources }], sync_group_count: 1 };
const stage = vi.fn(), refresh = vi.fn(async () => {}), add = vi.fn();
const selection = vi.fn();
const ledger: Omit<SlateIntervalLedgerProps, 'catalog'> & { projectId: string; sheetFirst: { model: SheetFirstModel; add: typeof add } } = {
  projectId: 'synthetic', snapshot: { revision: 0, draftRevision: 0, rows: [] }, stageCorrection: stage, refresh, sheetFirst: { model: sheet, add },
};
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, board: SlateBoard;
const upsert = vi.fn<SlateRecordClient['upsert']>();
const prepare = vi.fn<SceneIntervalClient['prepare']>();
const confirm = vi.fn<SceneIntervalClient['confirm']>();
const button = (label: string) => [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent)?.startsWith(label))!;
async function click(label: string) { await act(async () => button(label).click()); }
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  if (!HTMLElement.prototype.scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  localStorage.clear(); localStorage.setItem('mirrororder.productionActor', 'test');
  board = { version: 2, contract: 'script_supervisor.v2', revision: 0, updated_at: '', entries: {}, records: {}, semantics: {} };
  vi.spyOn(ProductionClient.prototype, 'scriptSupervisor').mockImplementation(async () => board);
  vi.spyOn(HostConnection.prototype, 'reviewModel').mockResolvedValue({ episodes: [], take_groups: [{
    group_id: 'g1', take_index: 1, candidates: [], automatic_state: { status: 'unassigned' }, effective_mapping: { episode_ids: [], script_segment_ids: [] },
    transcript: { text: '' }, angles: sources.map(s => ({ ...s, name: s.label, duration: 60,
      playback: { state: 'verified', available: true, url: `http://127.0.0.1:8765/media/${s.clip_id}`, source_start: 2.5 } })),
  }] } as unknown as ReviewModelPayload);
  upsert.mockReset().mockImplementation(async (_project, write) => {
    board = { ...board, revision: board.revision + 1, records: { ...board.records, [write.recordId]: { ...write.record, record_id: write.recordId } as SlateBoard['records'][string] } };
    return board;
  });
  prepare.mockReset().mockResolvedValue({ task_id: 'synthetic-task', status: 'running', type: 'scene_interval_prepare', stage: 'preparing' });
  confirm.mockReset(); stage.mockClear(); add.mockClear(); selection.mockClear();
  vi.spyOn(SlateRecordClient.prototype, 'upsert').mockImplementation(upsert);
  vi.spyOn(SceneIntervalClient.prototype, 'prepare').mockImplementation(prepare);
  vi.spyOn(SceneIntervalClient.prototype, 'confirm').mockImplementation(confirm);
  vi.spyOn(ProjectTaskClient.prototype, 'list').mockResolvedValue([]);
  vi.spyOn(SceneIntervalClient.prototype, 'read').mockImplementation(async () => ({ contract: 'mirrororder.scene_interval_review.v1', project_id: 'synthetic', revision: 0,
    candidates: [], confirmed_intervals: [], current_media_validation: 'not_checked', export_ready: false,
    prepare_context: { expected_board_revision: board.revision, expected_index_sha256: hash, range_coordinates: 'zero_based_source_frames_half_open', provenance_kind: 'editor_entered_note_snapshot' },
  } satisfies IntervalReadModel));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<GoldenSlateWorkbench baseUrl="http://127.0.0.1:8765" projectId="synthetic" onSelection={selection}/>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens the existing production row from an unclassified source scene without requiring paper import', async () => {
  await click('第 1 行 场号');
  expect(button('生产场记').getAttribute('aria-pressed')).toBe('true');
  const row = container.querySelector<HTMLTableRowElement>('.slate-row[aria-current="true"]')!;
  const inputs = row.querySelectorAll<HTMLInputElement>('input');
  expect(document.activeElement).toBe(inputs[1]);
  expect(upsert).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  await type(inputs[0], '3'); await type(inputs[1], '12');
  await click('+ 保条 ★'); await click('保存当前行');
  expect(upsert).toHaveBeenCalledOnce();
  expect(upsert.mock.calls[0][1].record).toMatchObject({ source_group_id: 'g1', episode: 3, scene: '12', note: '保条 ★' });
  await click('来源场记');
  const sourceRow = container.querySelector('tr[data-slate-row="g1"]')!;
  expect(sourceRow.querySelector('td')?.textContent).toContain('12');
  expect(sourceRow.textContent).toContain('保条 ★');
  expect(add).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});
it('carries the exact B source and playback time into existing slate interval preparation', async () => {
  await click('第 1 行 B机');
  const original = container.querySelector<HTMLVideoElement>('.slate-form-detail video')!;
  expect(original.src).toContain('clip-B');
  Object.defineProperty(original, 'readyState', { configurable: true, value: 1 }); original.currentTime = 8.125;
  await click('在生产场记中标记');
  expect(button('生产场记').getAttribute('aria-pressed')).toBe('true');
  const player = container.querySelector<HTMLVideoElement>('.golden-slate-player video')!;
  Object.defineProperty(player, 'duration', { configurable: true, value: 60 });
  await act(async () => player.dispatchEvent(new Event('loadedmetadata')));
  expect(player.src).toContain('clip-B'); expect(player.currentTime).toBe(8.125);
  const scene = container.querySelectorAll<HTMLInputElement>('.slate-row input')[1]; await type(scene, '12');
  await click('保存当前行');
  const range = container.querySelectorAll<HTMLInputElement>('.golden-slate-inspector .interval-inputs input');
  await type(range[0], '24'); await type(range[1], '48'); await click('准备此原素材区间');
  expect(prepare).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[0][1]).toMatchObject({ record_id: 'derived-g1', clip_id: 'clip-B', media_id: sources[1].media_id,
    source_start_frame: 24, source_end_frame: 48, expected_board_revision: 1 });
  expect(confirm).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
});

it.each(['A', 'B', 'C'])('opens the exact %s source without editing or saving the production row', async camera => {
  await click(`第 1 行 ${camera}机`);
  const original = container.querySelector<HTMLVideoElement>('.slate-form-detail video')!;
  Object.defineProperty(original, 'readyState', { configurable: true, value: 1 }); original.currentTime = 11.25;
  await click('在生产场记中标记');
  const player = container.querySelector<HTMLVideoElement>('.golden-slate-player video')!;
  Object.defineProperty(player, 'duration', { configurable: true, value: 60 });
  await act(async () => player.dispatchEvent(new Event('loadedmetadata')));
  expect(player.src).toContain(`clip-${camera}`); expect(player.currentTime).toBe(11.25);
  expect(selection).toHaveBeenLastCalledWith({ projectId: 'synthetic', recordId: 'derived-g1', groupId: 'g1', clipId: `clip-${camera}`, mediaId: sources.find(source => source.camera === camera)!.media_id });
  expect(container.querySelector('.slate-row.is-dirty')).toBeNull();
  expect(upsert).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
});

it('does not fall back to a clip with a different media identity', async () => {
  const staleSheet: SheetFirstModel = { ...sheet, sync_groups: [{ group_id: 'g1', sources: sources.map(source => source.camera === 'B' ? { ...source, media_id: `M_${'f'.repeat(24)}` } : source) }] };
  const staleLedger = { ...ledger, sheetFirst: { model: staleSheet, add } };
  await act(async () => root.render(<GoldenSlateWorkbench baseUrl="http://127.0.0.1:8765" projectId="synthetic" intervalLedger={staleLedger}/>));
  await click('第 1 行 B机'); await click('在生产场记中标记');
  expect(button('来源场记').getAttribute('aria-pressed')).toBe('true');
  expect(upsert).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});
