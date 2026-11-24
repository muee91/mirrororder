// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { HostConnection, type HostSnapshot, type ReviewModelPayload } from '../api/host';
import { DesktopClient, type SlateCandidateState } from '../api/desktop';
import { PlatformClient } from '../api/platform';
import { ProductionClient, type SlateBoard, type SlateRecord } from '../api/production';
import { App } from './App';
import { rememberProject, rememberWorkspace } from './resumeState';

const { write, pick } = vi.hoisted(() => ({
  write: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  pick: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: write }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: pick }));
vi.mock('../features/projects/projectActivity', () => ({ useProjectActivities: () => ({ activities: [], refreshActivities: vi.fn() }) }));
vi.mock('../features/slate/SlatePaperIntake', () => ({ SlatePaperIntake: () => null }));
vi.mock('../features/slate/SlateWorkbench', () => ({ SlateWorkbench: () => null }));
vi.mock('../features/projects/ProjectLibrary', () => ({ ProjectLibrary: () => null }));
vi.mock('../features/projects/ProjectHome', () => ({ ProjectHome: () => null }));
vi.mock('../features/projects/WorkspaceHome', () => ({ WorkspaceHome: () => null }));
vi.mock('../features/settings/SettingsStatusWorkbench', () => ({ SettingsStatusWorkbench: () => null }));
vi.mock('../features/status/StatusCenterWorkbench', () => ({ StatusCenterWorkbench: () => null }));
vi.mock('../features/team/TeamWebWorkbench', () => ({ TeamWebWorkbench: () => null }));

let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
const original: HostSnapshot = {
  baseUrl: 'http://127.0.0.1:8765', ping: { status: 'ok', service: 'mirrororder-host' },
  workspace: { workspace_id: 'old-workspace', workspace: 'Old workspace', api_version: 'v1', projects: [{ project_id: 'p1', name: 'Original project', input_kind: 'fcpxml' }] },
  projects: [{ project_id: 'p1', name: 'Original project', input_kind: 'fcpxml' }],
};
let start: MockInstance<HostConnection['startAndConnect']>;
let connect: MockInstance<HostConnection['connect']>;
let board: SlateBoard;
const record = (recordId: string, scene: string): SlateRecord => ({
  record_id: recordId, episode: 1, scene, shot: '', take_number: null, note: '', status: 'unmarked',
  source_group_id: '', script_scene_id: '', preferred_clip_id: '', attachments: [], actor: 'test', updated_at: '',
});
const newProject = { ...original.projects[0], name: 'Replacement project' };
const replacement: HostSnapshot = {
  ...original, projects: [newProject],
  workspace: { ...original.workspace, workspace_id: 'new-workspace', workspace: 'New workspace', projects: [newProject] },
};
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
const canvas = () => container.querySelector('.project-production-workbench');
const scene = (id: string) => container.querySelector(`.slate-row[data-record-id="${id}"]`)?.querySelectorAll<HTMLInputElement>('input')[1];
const requestBody = (call = 0) => JSON.parse(String(write.mock.calls[call][1]?.body));
function returnedBoard(value: SlateBoard): Response { return new Response(JSON.stringify(value)); }
async function enterScene(id: string, value: string) {
  await act(async () => {
    const input = scene(id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function reopenOriginal() {
  pick.mockResolvedValueOnce('synthetic-old/projects/p1/project.toml');
  start.mockResolvedValueOnce(original);
  const advanced = container.querySelector<HTMLDetailsElement>('.startup-advanced');
  if (!advanced) throw new Error('missing advanced workspace controls');
  advanced.open = true;
  await click('选择项目库配置文件…');
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  localStorage.setItem('mirrororder.productionActor', 'tester');
  rememberWorkspace('synthetic-old'); rememberProject('p1');
  board = {
    version: 2, contract: 'script_supervisor.v2', revision: 3, updated_at: '',
    records: { a: record('a', '1'), b: record('b', '2') }, entries: {}, semantics: {},
  };
  start = vi.spyOn(HostConnection.prototype, 'startAndConnect').mockResolvedValueOnce(original);
  connect = vi.spyOn(HostConnection.prototype, 'connect');
  vi.spyOn(HostConnection.prototype, 'reviewModel').mockResolvedValue({ episodes: [], take_groups: [] } as unknown as ReviewModelPayload);
  vi.spyOn(ProductionClient.prototype, 'scriptSupervisor').mockImplementation(async () => board);
  vi.spyOn(DesktopClient.prototype, 'slateCandidates').mockResolvedValue({
    contract: 'slate_candidates.v1', project_id: 'p1', slate_attached: false, slate_name: '',
    status: 'none', revision: 0, pages_total: 0, pages_done: 0, candidates: [],
    warning: '', error: '', provider: '', model: '', started_at: '', completed_at: '', updated_at: '', task_id: '',
  } as SlateCandidateState);
  vi.spyOn(PlatformClient.prototype, 'info').mockResolvedValue({ os: 'macos' } as Awaited<ReturnType<PlatformClient['info']>>);
  pick.mockResolvedValue('synthetic-new/projects/p1');
  write.mockReset().mockImplementation(async (input, init) => {
    if (String(input).endsWith('/slate-candidates')) {
      return new Response(JSON.stringify({
        contract: 'slate_candidates.v1', project_id: 'p1', slate_attached: false, slate_name: '',
        status: 'none', revision: 0, pages_total: 0, pages_done: 0, candidates: [],
        warning: '', error: '', provider: '', model: '', started_at: '', completed_at: '', updated_at: '', task_id: '',
      }));
    }
    const { record_id, record: patch } = JSON.parse(String(init?.body));
    board = { ...board, revision: board.revision + 1, records: { ...board.records, [record_id]: { ...board.records[record_id], ...patch } } };
    return returnedBoard(board);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<App/>));
  expect(canvas()?.getAttribute('aria-label')).toContain('Original project');
  // Slate recognition state is a lightweight read on page open; assertions
  // below concern mutations after the workspace switch, not the initial reads.
  write.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('renders recovery on the first frame when a workspace is remembered', () => {
  const firstRender = renderToStaticMarkup(<App/>);
  expect(firstRender).toContain('>恢复项目库</h1>');
  expect(firstRender).not.toContain('>镜序项目库</h1>');
});

it('removes the old canvas and stops queued saves even when the first response arrives after replacement', async () => {
  await enterScene('a', '11');
  await enterScene('b', '22');
  let finishWrite!: (response: Response) => void;
  write.mockReturnValueOnce(new Promise(resolve => { finishWrite = resolve; }));
  await click('保存 2');
  expect(container.querySelector('.golden-slate-save-state')?.getAttribute('data-state')).toBe('saving');
  expect(write).toHaveBeenCalledOnce();
  expect(requestBody()).toMatchObject({ expected_workspace_id: 'old-workspace', expected_revision: 3, record_id: 'a', record: { scene: '11' } });
  const oldWriteSignal = write.mock.calls[0][1]?.signal;
  const oldAfterFirstWrite = { ...board, revision: 4, records: { ...board.records, a: record('a', '11') } };
  let finishSwitch!: (snapshot: HostSnapshot) => void;
  start.mockReturnValueOnce(new Promise(resolve => { finishSwitch = resolve; }));
  await click('切换项目库…');
  expect(oldWriteSignal?.aborted).toBe(true);
  expect(canvas()).toBeNull();
  expect(button('保存 2')).toBeUndefined();
  await act(async () => container.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  expect(write).toHaveBeenCalledOnce();

  board = { ...board, records: { a: record('a', 'new'), b: record('b', 'new') } };
  await act(async () => finishSwitch(replacement));
  expect(canvas()?.getAttribute('aria-label')).toContain('Replacement project');
  expect(scene('b')?.value).toBe('new');
  await act(async () => finishWrite(returnedBoard(oldAfterFirstWrite)));
  expect(write).toHaveBeenCalledOnce();
  expect(scene('a')?.value).toBe('new');

  board = oldAfterFirstWrite;
  pick.mockResolvedValueOnce('synthetic-old/projects/p1');
  start.mockResolvedValueOnce(original);
  await click('切换项目库…');
  expect(scene('a')?.value).toBe('11');
  expect(scene('b')?.value).toBe('22');
  expect(button('保存 1')).toBeDefined();
  expect(container.querySelector('.golden-slate-save-state')?.getAttribute('data-state')).toBe('dirty');
  expect(write).toHaveBeenCalledOnce();
});
it('keeps drafts inaccessible while the stopped Host is offline and restores them on a verified return', async () => {
  await enterScene('a', '11');
  start.mockRejectedValueOnce(new Error('replacement failed'));
  connect.mockRejectedValueOnce(new Error('old host stopped'));
  await click('切换项目库…');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(canvas()).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('replacement failed');
  expect(container.textContent).not.toContain('当前工作现场保持打开');
  expect(write).not.toHaveBeenCalled();
  await reopenOriginal();
  expect(scene('a')?.value).toBe('11');
  expect(button('保存 1')).toBeDefined();
  expect(write).not.toHaveBeenCalled();
});
it('refuses to restore old project controls when the same port now serves a different workspace', async () => {
  await enterScene('a', '11');
  start.mockRejectedValueOnce(new Error('new projection failed'));
  connect.mockResolvedValueOnce(replacement);
  await click('切换项目库…');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(canvas()).toBeNull();
  expect(button('保存 1')).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
  await reopenOriginal();
  expect(scene('a')?.value).toBe('11');
});
it('restores only a freshly verified old workspace and uses its current project projection', async () => {
  await enterScene('a', '11');
  start.mockRejectedValueOnce(new Error('invalid new workspace'));
  const projects = [{ ...original.projects[0], name: 'Fresh old project' }];
  board = { ...board, revision: 4, records: { ...board.records, b: record('b', 'refreshed') } };
  connect.mockResolvedValueOnce({ ...original, projects, workspace: { ...original.workspace, projects } });
  await click('切换项目库…');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(canvas()?.getAttribute('aria-label')).toContain('Fresh old project');
  expect(container.textContent).toContain('当前工作现场保持打开');
  expect(scene('a')?.value).toBe('11');
  expect(scene('b')?.value).toBe('refreshed');
  expect(write).not.toHaveBeenCalled();
  await click('保存 1');
  expect(requestBody()).toMatchObject({ expected_workspace_id: 'old-workspace', expected_revision: 4, record_id: 'a', record: { scene: '11' } });
  expect(container.querySelector('.golden-slate-save-state')?.getAttribute('data-state')).toBe('saved');
});
it('holds a conflicting draft until the user explicitly chooses a version', async () => {
  await enterScene('a', '11');
  board = { ...board, revision: 4, records: { ...board.records, a: { ...record('a', '3'), note: 'newer server note' } } };
  start.mockRejectedValueOnce(new Error('invalid new workspace'));
  connect.mockResolvedValueOnce(original);
  await click('切换项目库…');
  expect(scene('a')?.value).toBe('11');
  expect(container.textContent).toContain('newer server note');
  expect(button('保存 1').disabled).toBe(true);
  await act(async () => container.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await click('用草稿覆盖…');
  expect(write).not.toHaveBeenCalled();
  await click('放弃此草稿…');
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(scene('a')?.value).toBe('3');
  expect(write).not.toHaveBeenCalled();
});
it('disconnects if Refresh discovers that the open port changed its workspace identity', async () => {
  await enterScene('a', '11');
  connect.mockResolvedValueOnce(replacement);
  await click('刷新项目库');
  expect(canvas()).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('其他项目库');
  await reopenOriginal();
  expect(scene('a')?.value).toBe('11');
});
it('also verifies the previous workspace before recovering from a failed advanced connection', async () => {
  connect.mockRejectedValueOnce(new Error('target offline')).mockRejectedValueOnce(new Error('old offline'));
  await click('连接已运行服务');
  expect(connect).toHaveBeenCalledTimes(2);
  expect(canvas()).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('target offline');
});
