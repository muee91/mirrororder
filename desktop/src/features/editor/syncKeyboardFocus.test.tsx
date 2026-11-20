// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SyncTimelineViewport } from './SyncTimelineViewport';
import type { MulticamSyncTimeline } from '../../api/syncTimeline';
let host:HTMLDivElement, root:ReturnType<typeof createRoot>;const seek=vi.fn(),toggle=vi.fn();
const timeline={duration_seconds:100,project_id:'test',tracks:[{track_id:'A',camera:'A',label:'A',clip_count:1,clips:[{clip_id:'a',name:'synthetic',day:'test',timeline_start:0,duration:100}]}]} as MulticamSyncTimeline;
beforeEach(async()=>{seek.mockClear();toggle.mockClear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<SyncTimelineViewport timeline={timeline} rate={{numerator:30,denominator:1}} frameAccurate cursor={300} trackId="A" playing={false} canPlay onSeek={seek} onTogglePlay={toggle}/>));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function key(target:Element,key:string,shiftKey=false){const e=new KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true});await act(async()=>target.dispatchEvent(e));return e;}
it('allows focused clip arrow navigation once but leaves native button activation alone',async()=>{const clip=host.querySelector('.multicam-sync-clip')!;await key(clip,'ArrowRight');await key(clip,'ArrowLeft',true);expect(seek.mock.calls.map(c=>c[0])).toEqual([301,290]);expect((await key(clip,' ')).defaultPrevented).toBe(false);expect((await key(clip,'Enter')).defaultPrevented).toBe(false);expect(toggle).not.toHaveBeenCalled();await act(async()=>clip.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true})));expect(seek.mock.calls).toHaveLength(3);expect(seek.mock.calls[2]).toEqual([0,'A']);});
it('space toggles only from track surface, never hijacks text entry',async()=>{expect((await key(host.querySelector('.sync-working-surface')!,' ')).defaultPrevented).toBe(true);expect(toggle).toHaveBeenCalledTimes(1);await key(host.querySelector('input')!,'ArrowRight');expect(seek).not.toHaveBeenCalled();});
