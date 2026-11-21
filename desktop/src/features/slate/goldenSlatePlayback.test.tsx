// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoldenSlateWorkbench } from './GoldenSlateWorkbench';
import { HostConnection, type ReviewModelPayload } from '../../api/host';
import { ProductionClient, type SlateBoard } from '../../api/production';

vi.mock('./SlatePaperIntake', () => ({ SlatePaperIntake: () => null }));
vi.mock('./SlateWorkbench', () => ({ SlateWorkbench: () => null }));
vi.mock('./SlateSpeechEvidencePanel', () => ({ SlateSpeechEvidencePanel: () => null }));
vi.mock('./SlateSourceIntervalPanel', () => ({ SlateSourceIntervalPanel: () => null }));
vi.mock('./SlateIntervalBoardSurface', () => ({ SlateIntervalBoardSurface: () => null }));
vi.mock('./useNativeSlateIntervalLedger', () => ({ useNativeSlateIntervalLedger: () => ({ available: true }) }));

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
let pause: ReturnType<typeof vi.spyOn>, play: ReturnType<typeof vi.spyOn>;
const selection = vi.fn();
const attachments = ['A', 'B', 'C'].map(camera => ({
  clip_id: `clip-${camera}`, media_id: `media-${camera}`, camera,
  display_name: `${camera}.mp4`, shot_type: 'unknown', source_role: 'sync_camera', note: '',
}));
const board = { version: 2, contract: 'script_supervisor.v2', revision: 1, updated_at: '', entries: {}, semantics: {}, records: {
  r1: { record_id: 'r1', source_group_id: 'g1', script_scene_id: '', episode: 1, scene: '2', shot: '1', take_number: 1,
    status: 'unmarked', note: '', preferred_clip_id: 'clip-B', attachments, actor: 'test', updated_at: '' },
}} as SlateBoard;
const review = { episodes: [], take_groups: [{ group_id: 'g1', take_index: 1, transcript: { text: '' }, candidates: [],
  angles: attachments.map(item => ({ ...item, name: item.display_name, duration: 90, source_start: 3.25,
    playback: { state: 'verified', available: true, url: `http://synthetic.test/${item.clip_id}`, source_start: 3.25 } })),
}]} as unknown as ReviewModelPayload;
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function render(active = true) {
  await act(async () => root.render(<GoldenSlateWorkbench baseUrl="http://synthetic.test" projectId="synthetic" active={active} onSelection={selection}/>));
}
function metadata(video: HTMLVideoElement, width = 1920, height = 1080) {
  for (const [key, value] of Object.entries({ duration: 90, readyState: 1, videoWidth: width, videoHeight: height })) {
    Object.defineProperty(video, key, { configurable: true, value });
  }
  return act(async () => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.spyOn(HostConnection.prototype, 'reviewModel').mockResolvedValue(review);
  vi.spyOn(ProductionClient.prototype, 'scriptSupervisor').mockResolvedValue(board);
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  selection.mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await render();
  await click('生产场记');
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('expands the same player without autoplay, reseeking, or changing the selected B source', async () => {
  const video = container.querySelector<HTMLVideoElement>('.golden-slate-player video')!;
  await metadata(video);
  expect(video.currentTime).toBe(3.25);
  video.currentTime = 17.375; video.volume = 0.4; video.muted = true; video.playbackRate = 1.5;
  const trigger = button('快速预览'); trigger.focus();
  await click('快速预览');
  expect(container.querySelectorAll('video[controls]')).toHaveLength(1);
  expect(container.querySelector('[role="dialog"] video')).toBe(video);
  expect(video.currentTime).toBe(17.375);
  expect(video.src).toBe('http://synthetic.test/clip-B');
  expect(video.autoplay).toBe(false);
  expect(play).not.toHaveBeenCalled();
  expect(video.volume).toBe(0.4); expect(video.muted).toBe(true); expect(video.playbackRate).toBe(1.5);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('.golden-slate-player video')).toBe(video);
  expect(video.currentTime).toBe(17.375);
  expect(document.activeElement).toBe(trigger);
  await act(async () => video.dispatchEvent(new Event('seeked', { bubbles: true })));
  expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ recordId: 'r1', clipId: 'clip-B', sourceRange: { basis: 'source', start: 17.375 } }));
});
it('sizes the player from portrait metadata and preserves that geometry when expanded', async () => {
  const video = container.querySelector<HTMLVideoElement>('.golden-slate-player video')!;
  await metadata(video, 1080, 1920);
  const frame = video.closest<HTMLElement>('.golden-slate-player')!;
  expect(frame.style.getPropertyValue('--slate-video-aspect')).toBe('0.5625');
  await click('快速预览');
  expect(video.closest('.golden-slate-player')).toBe(frame);
  expect(frame.style.getPropertyValue('--slate-video-aspect')).toBe('0.5625');
});
it('opens the same player when the inspector is collapsed, then pauses when it becomes hidden again', async () => {
  const video = container.querySelector<HTMLVideoElement>('.golden-slate-player video')!;
  await metadata(video); video.currentTime = 22.125;
  await click('检视');
  expect(pause).toHaveBeenCalled();
  await click('快速预览');
  expect(container.querySelector('[role="dialog"] video')).toBe(video);
  expect(video.currentTime).toBe(22.125);
  pause.mockClear();
  await click('关闭 (Esc)');
  expect(pause).toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it('pauses and dismisses Quick Look when the workbench or production slate is hidden', async () => {
  await click('快速预览'); pause.mockClear();
  expect(container.querySelector('.golden-slate-table .mo-media-thumb video')).not.toBeNull();
  await render(false);
  expect(pause).toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('.golden-slate-workbench .mo-media-thumb video')).toBeNull();
  expect(container.querySelector('video[controls]')?.getAttribute('preload')).toBe('none');
  await render(); await click('快速预览'); pause.mockClear();
  await click('来源场记');
  expect(pause).toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
