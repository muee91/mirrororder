// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostConnection, type ReviewAngle, type ReviewTakeGroup } from "../../api/host";
import { SpeechEvidenceClient, type SpeechEvidence } from "../../api/speechEvidence";
import { ReviewMulticamMonitor } from "./ReviewMulticamMonitor";

function angle(camera: string, start = 0, end = 2): ReviewAngle {
  return { camera, clip_id: `C_${camera}`, media_id: `M_${camera}`, name: `${camera}.mov`,
    timeline_start: 0, timeline_end: end - start, source_start: start, source_end: end, duration: end - start,
    playback: { url: "", source_start: start, source_end: end, state: "verified" } };
}

function take(groupId: string, angles: ReviewAngle[]): ReviewTakeGroup {
  return { group_id: groupId, angles, transcript: { text: "候选组级摘录", source: "candidate" } } as ReviewTakeGroup;
}

function speech(clip: string, segments: SpeechEvidence["segments"] = []): SpeechEvidence {
  return { contract: "mirrororder.speech_evidence.v1", status: segments.length ? "available" : "missing",
    clip_id: clip, media_id: clip.replace("C_", "M_"), segments, coordinate_space: "source-relative-seconds",
    backend: null, outcome: segments.length ? "transcribed" : "not-transcribed" };
}

describe("ReviewMulticamMonitor", () => {
  let root: Root;
  let host: HTMLDivElement;
  const connection = new HostConnection("http://synthetic.test");
  const watch = vi.fn();
  const repair = vi.fn();
  function render(item: ReviewTakeGroup, preferred = "C_A") {
    return act(async () => root.render(<ReviewMulticamMonitor connection={connection} projectId="p" take={item}
      preferredClipId={preferred} initialSourceTime={0.8} onWatchAngle={watch} onOpenRepair={repair} />));
  }

  function tile(camera: string): HTMLElement {
    return host.querySelector<HTMLElement>(`article[aria-label="${camera}机 · ${camera}.mov"]`)!;
  }

  function button(scope: HTMLElement, label: string): HTMLButtonElement {
    const found = [...scope.querySelectorAll("button")].find(item => item.textContent === label);
    expect(found).toBeDefined();
    return found!;
  }

  function metadata(video: HTMLVideoElement, duration = 5): void {
    Object.defineProperty(video, "duration", { configurable: true, value: duration });
    act(() => video.dispatchEvent(new Event("loadedmetadata")));
  }

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(SpeechEvidenceClient.prototype, "evidence").mockImplementation(async (_, clip) => speech(clip));
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function(this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, value: false });
      this.dispatchEvent(new Event("play"));
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function(this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, value: true });
      this.dispatchEvent(new Event("pause"));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("updates the angle's layout from the actual displayed picture without seeking again", async () => {
    await render(take("first", [angle("A"), angle("B")]));
    const a = tile("A");
    const av = a.querySelector("video")!;
    Object.defineProperties(av, {
      videoWidth: { configurable: true, value: 216 }, videoHeight: { configurable: true, value: 384 },
    });
    metadata(av);
    expect(Number(a.style.getPropertyValue("--review-mc-ratio"))).toBe(9 / 16);
    av.currentTime = 1.25;
    Object.defineProperties(av, {
      videoWidth: { configurable: true, value: 480 }, videoHeight: { configurable: true, value: 480 },
    });
    act(() => av.dispatchEvent(new Event("resize")));
    expect(Number(a.style.getPropertyValue("--review-mc-ratio"))).toBe(1);
    expect(av.currentTime).toBe(1.25);
  });

  it("shows only each occurrence's recorded speech inside its Take and seeks to the corresponding source position", async () => {
    vi.mocked(SpeechEvidenceClient.prototype.evidence).mockImplementation(async (_, clip) => clip === "C_A" ? speech(clip, [
      { start: 0, end: 1, text: "上一条的内容" }, { start: 0.9, end: 1.4, text: "门开了" },
      { start: 1.55, end: 1.95, text: "我听到了" }, { start: 2, end: 3, text: "下一条的内容" },
    ]) : speech(clip));
    await render(take("first", [angle("A", 1, 2), angle("B")]));
    const a = tile("A");
    const b = tile("B");
    const av = a.querySelector("video")!;
    metadata(av);
    expect(av.currentTime).toBe(1);
    expect(host.textContent).not.toMatch(/候选组级摘录|上一条的内容|下一条的内容/);
    expect(a.textContent).toContain("门开了");
    expect(b.textContent).toContain("本机位暂无转写");
    expect(b.textContent).not.toContain("门开了");
    act(() => a.querySelector<HTMLButtonElement>('[aria-label*="我听到了"]')!.click());
    expect(av.currentTime).toBe(1.55);
    act(() => button(a, "单独看").click());
    expect(watch).toHaveBeenCalledWith("C_A", 1.55);
  });

  it("keeps independent playheads, mutes the former listening angle and stops at its own source out", async () => {
    await render(take("first", [angle("A", 0.2, 1), angle("B", 2, 4)]));
    const a = tile("A"), b = tile("B");
    const av = a.querySelector("video")!, bv = b.querySelector("video")!;
    metadata(av);
    metadata(bv);
    expect([av.currentTime, bv.currentTime]).toEqual([0.8, 2]);
    expect([av.muted, bv.muted]).toEqual([false, true]);
    await act(async () => button(a, "播放").click());
    expect([av.paused, bv.paused]).toEqual([false, true]);
    await act(async () => button(b, "播放").click());
    act(() => button(b, "监听").click());
    expect([av.muted, bv.muted]).toEqual([true, false]);
    expect([av.paused, bv.paused]).toEqual([false, false]);
    av.currentTime = 1.12;
    act(() => av.dispatchEvent(new Event("timeupdate")));
    expect([av.paused, av.currentTime, bv.paused, bv.currentTime]).toEqual([true, 1, false, 2]);
    await act(async () => button(a, "播放").click());
    expect(av.currentTime).toBe(0.2);
  });

  it("offers a repair action for offline media and avoids playback for an empty source range", async () => {
    const a = angle("A");
    a.playback.state = "missing";
    await render(take("first", [a, angle("B", 2, 2)]));
    expect(host.querySelectorAll("video")).toHaveLength(0);
    expect(tile("A").textContent).toContain("本机素材未连接");
    expect(tile("B").textContent).toContain("没有可看的原片区间");
    act(() => button(tile("A"), "检查本机素材").click());
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("discards departed speech and refuses a mismatched media identity", async () => {
    let resolveOld!: (value: SpeechEvidence) => void;
    const pending = new Promise<SpeechEvidence>(resolve => { resolveOld = resolve; });
    vi.mocked(SpeechEvidenceClient.prototype.evidence).mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ ...speech("C_B", [{ start: 0, end: 1, text: "错误文件的对白" }]), media_id: "wrong" });
    await render(take("old", [angle("A")]));
    await render(take("new", [angle("B")]), "C_B");
    await act(async () => resolveOld(speech("C_A", [{ start: 0, end: 1, text: "旧条的对白" }])));
    expect(host.textContent).not.toMatch(/错误文件的对白|旧条的对白/);
    expect(tile("B").textContent).toContain("本机位对白读取失败");
    await act(async () => button(tile("B"), "重读对白").click());
    expect(tile("B").textContent).toContain("本机位暂无转写");
  });
});
