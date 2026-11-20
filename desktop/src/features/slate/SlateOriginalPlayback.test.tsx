// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {SlateOriginalPlayback,originalPlaybackUrl} from "./SlateOriginalPlayback";
const source={clipId:'C-1',mediaId:'M_'+'a'.repeat(24),assetRevision:'rev-5'};
let host:HTMLElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host)});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()});
const button=(label:string)=>[...host.querySelectorAll('button')].find(btn=>btn.textContent===label)!;
const render=(s=source)=>act(async()=>root.render(<SlateOriginalPlayback baseUrl="http://127.0.0.1:8765" projectId="my-project" source={s}/>));
it("preview only uses supported local Host identity endpoint, never a user URL or provisional media",()=>{
 expect(originalPlaybackUrl('http://localhost:8765','p / q',source)).toBe(`http://localhost:8765/api/v1/projects/p%20%2F%20q/media/C-1?expected_media_id=${source.mediaId}`);
 expect(originalPlaybackUrl('https://foreign.example','p',source)).toBeNull();
 expect(originalPlaybackUrl('http://localhost@foreign.example','p',source)).toBeNull();
 expect(originalPlaybackUrl('http://localhost:8765','p',{...source,mediaId:'MP_abc'})).toBeNull();
});
it("opens controls only on click, neither auto plays nor alters source frames",async()=>{
 await render();expect(host.querySelector("video")).toBeNull();
 await act(async()=>button("查看原片").click());const video=host.querySelector("video")!;
 expect(video.src).toContain(`expected_media_id=${source.mediaId}`);expect(video.controls).toBe(true);expect(video.autoplay).toBe(false);expect(video.currentTime).toBe(0);
 expect(host.textContent).toContain("不会换算或改写");
 await act(async()=>button("关闭原片").click());expect(host.querySelector("video")).toBeNull();
});
it("a changed source selection cannot autoplay or leave old media open",async()=>{
 await render();await act(async()=>button("查看原片").click());expect(host.querySelector("video")).not.toBeNull();
 await render({...source,assetRevision:"rev-6"});expect(host.querySelector("video")).toBeNull();
});
it("reports decode/offline error and retries only on a second explicit action",async()=>{
 await render();await act(async()=>button("查看原片").click());
 await act(async()=>host.querySelector("video")!.dispatchEvent(new Event("error")));
 expect(host.querySelector("video")).toBeNull();expect(host.textContent).toContain("无法播放");
 await act(async()=>button("重试播放").click());expect(host.querySelector("video")).not.toBeNull();
});
it("fits decoded desktop video orientation, retaining the same active video on an unchanged selection",async()=>{
 await render();await act(async()=>button("查看原片").click());const video=host.querySelector("video")!;
 const decoded=async(width:number,height:number)=>{
  Object.defineProperties(video,{videoWidth:{configurable:true,value:width},videoHeight:{configurable:true,value:height}});
  await act(async()=>video.dispatchEvent(new Event("loadedmetadata")));
 };
 expect(video.dataset.frame).toBe("loading");
 await decoded(180,320);
 expect(video.dataset.orientation).toBe("portrait");
 expect(video.style.getPropertyValue("--slate-display-ratio")).toBe(String(180/320));
 video.currentTime=2.5;
 await render();
 expect(host.querySelector("video")).toBe(video);
 expect(video.currentTime).toBe(2.5);
 await decoded(320,180);
 expect(video.dataset.orientation).toBe("landscape");
 expect(video.style.getPropertyValue("--slate-display-ratio")).toBe(String(320/180));
});
