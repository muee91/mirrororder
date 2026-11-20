// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindTimelineViewportInput } from "./timelineViewportInput";
let surface: HTMLDivElement, detach: () => void;
let view = { start:1000, span:1000 };
let flush: FrameRequestCallback | undefined;
beforeEach(()=>{
 surface=document.createElement('div'); document.body.append(surface);
 surface.getBoundingClientRect=()=>({left:100,width:1000} as DOMRect);
 view={start:1000,span:1000};
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{flush=cb;return 1;});
 vi.stubGlobal('cancelAnimationFrame',()=>{flush=undefined;});
 detach=bindTimelineViewportInput(surface,surface,()=>({view,total:10000}),fn=>{view=fn(view);});
});
afterEach(()=>{detach();surface.remove();vi.unstubAllGlobals();flush=undefined;});
function run(){const cb=flush;flush=undefined;cb?.(0);}
function wheel(init:WheelEventInit){const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,...init});surface.dispatchEvent(event);run();return event;}
function gesture(target:EventTarget,type:string,props:object){const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);run();}
it('coalesces pointer anchored Ctrl-wheel zoom',()=>{
 const e=wheel({ctrlKey:true,deltaY:-Math.log(2)/.004,clientX:850});
 expect(e.defaultPrevented).toBe(true);expect(view).toEqual({start:1375,span:500});
});
it('pans horizontally and leaves vertical track scrolling alone',()=>{
 expect(wheel({deltaY:100}).defaultPrevented).toBe(false);expect(view.start).toBe(1000);
 wheel({deltaX:100});expect(view.start).toBe(1100);
 wheel({shiftKey:true,deltaY:-100});expect(view.start).toBe(1000);
});
it('normalizes line delta and clamps edges',()=>{
 wheel({deltaMode:1,deltaX:1000});expect(view.start).toBe(9000);
});
it('handles WebKit pinch and suppresses duplicate wheel while pinching',()=>{
 gesture(surface,'gesturestart',{clientX:850});
 gesture(window,'gesturechange',{scale:2});expect(view).toEqual({start:1375,span:500});
 wheel({ctrlKey:true,deltaY:-100,clientX:850});expect(view.span).toBe(500);
 gesture(window,'gestureend',{});wheel({ctrlKey:true,deltaY:-100,clientX:850});expect(view.span).toBe(500);
});
it('cancels queued gesture on blur and removes handlers on cleanup',()=>{
 gesture(surface,'gesturestart',{clientX:850});window.dispatchEvent(new Event('blur'));
 gesture(window,'gesturechange',{scale:2});expect(view.span).toBe(1000);
 detach();wheel({ctrlKey:true,deltaY:-100,clientX:850});expect(view.span).toBe(1000);
});
