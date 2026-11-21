// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MirrorOrderMediaCard } from "./MirrorOrderMediaCard";
import { useNearViewportGate, useVideoDecodeSlot } from "./nearViewport";

type Entry = { target?: Element; isIntersecting: boolean; intersectionRatio: number };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: Entry[]) => void;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: (entries: Entry[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }
}

describe("useNearViewportGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderProbe(enabled: boolean): HTMLElement {
    function Probe() {
      const [ref, near] = useNearViewportGate<HTMLDivElement>(enabled);
      return <div ref={ref} data-state={near ? "near" : "far"} />;
    }
    act(() => {
      root = createRoot(container);
      root.render(<Probe />);
    });
    return container.firstElementChild as HTMLElement;
  }

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps the preview dormant until the observer reports the viewport", () => {
    const element = renderProbe(true);
    expect(element.dataset.state).toBe("far");
    const observer = FakeIntersectionObserver.instances.at(-1);
    expect(observer?.observed).toContain(element);
    act(() => {
      observer?.callback([{ isIntersecting: true, intersectionRatio: 0.5 }]);
    });
    expect(element.dataset.state).toBe("near");
    act(() => {
      observer?.callback([{ isIntersecting: false, intersectionRatio: 0 }]);
    });
    expect(element.dataset.state).toBe("far");
  });

  it("treats a disabled gate as always active without observing", () => {
    const before = FakeIntersectionObserver.instances.length;
    const element = renderProbe(false);
    expect(element.dataset.state).toBe("near");
    expect(FakeIntersectionObserver.instances.length).toBe(before);
  });

  it("disconnects the observer on unmount", () => {
    renderProbe(true);
    const observer = FakeIntersectionObserver.instances.at(-1);
    act(() => {
      root?.unmount();
      root = null;
    });
    expect(observer?.disconnected).toBe(true);
  });

  it("falls back to always-active when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const element = renderProbe(true);
    expect(element.dataset.state).toBe("near");
  });

  it("shares each margin, routes targeted entries, broadcasts untargeted entries, and retires empty pools", () => {
    function Gate({ margin }: { margin: string }) {
      const [ref, near] = useNearViewportGate<HTMLDivElement>(true, margin);
      return <div ref={ref} data-near={near} />;
    }
    root = createRoot(container);
    const gates = (margins: string[]) => margins.map((margin, i) => <Gate key={i} margin={margin} />);
    act(() => root!.render(gates(["10px", "10px", "20px"])));
    const [one, two, three] = Array.from(container.children);
    const [shared, separate] = FakeIntersectionObserver.instances;
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(shared.observed).toEqual([one, two]);
    act(() => shared.callback([{ target: two, isIntersecting: true, intersectionRatio: 1 }]));
    expect([one, two, three].map((el) => el.getAttribute("data-near"))).toEqual(["false", "true", "false"]);
    act(() => shared.callback([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect([one, two, three].map((el) => el.getAttribute("data-near"))).toEqual(["true", "true", "false"]);
    act(() => root!.render(gates(["10px"])));
    expect(shared.observed).toEqual([one]);
    expect(shared.disconnected).toBe(false);
    expect(separate.disconnected).toBe(true);
    act(() => root!.render(null));
    expect(shared.disconnected).toBe(true);
    act(() => root!.render(gates(["10px"])));
    expect(FakeIntersectionObserver.instances).toHaveLength(3);
  });

  it.each([
    { duration: 4, readyState: 1, start: 0, expectedTime: 0.04 },
    { duration: 0.08, readyState: 1, start: 0, expectedTime: 0.001 },
    { duration: NaN, readyState: 1, start: 0, expectedTime: 0.001 },
    { duration: 4, readyState: 2, start: 0, expectedTime: 0 },
    { duration: 4, readyState: 1, start: 2, expectedTime: 2 },
  ])("requests the thumbnail at $expectedTime when duration=$duration, readyState=$readyState and start=$start", ({ duration, readyState, start, expectedTime }) => {
    root = createRoot(container);
    act(() => root!.render(<MirrorOrderMediaCard showPreview model={{
      id: "one", mediaId: "one", camera: "A", name: "Clip", playbackUrl: "/clip", sourceStart: start,
    }} />));
    const video = container.querySelector("video")!;
    Object.defineProperties(video, { duration: { value: duration }, readyState: { value: readyState } });
    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.currentTime).toBe(expectedTime);
    expect(video.classList.contains("is-ready")).toBe(readyState >= 2);
    act(() => video.dispatchEvent(new Event("seeked")));
    expect(video.classList.contains("is-ready")).toBe(true);
  });

  it("admits six compact thumbnails and keeps each loaded frame mounted as the FIFO advances", () => {
    root = createRoot(container);
    act(() => root!.render(Array.from({ length: 9 }, (_, i) => (
      <MirrorOrderMediaCard key={i} compact model={{
        id: String(i), mediaId: String(i), camera: "A", name: String(i),
        playbackUrl: `/media/${i}`, sourceStart: i === 0 ? 2 : 0,
      }} />
    ))));
    const [observer] = FakeIntersectionObserver.instances;
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(container.querySelector("video")).toBeNull();
    act(() => observer.callback([{ isIntersecting: true, intersectionRatio: 1 }]));
    const videos = () => Array.from(container.querySelectorAll("video"));
    const firstSix = videos();
    expect(firstSix.map((video) => video.getAttribute("src"))).toEqual(Array.from({ length: 6 }, (_, i) => `/media/${i}`));
    act(() => firstSix[0].dispatchEvent(new Event("loadeddata")));
    expect(videos()).toEqual(firstSix);
    act(() => firstSix[0].dispatchEvent(new Event("seeked")));
    expect(videos()[0]).toBe(firstSix[0]);
    expect(videos()[6].getAttribute("src")).toBe("/media/6");
    act(() => firstSix[0].dispatchEvent(new Event("seeked")));
    expect(videos()).toHaveLength(7);
    act(() => firstSix[1].dispatchEvent(new Event("loadeddata")));
    expect(videos()[7].getAttribute("src")).toBe("/media/7");
    act(() => firstSix[2].dispatchEvent(new Event("error")));
    expect(videos()[8].getAttribute("src")).toBe("/media/8");
    act(() => observer.callback([{ target: observer.observed[0], isIntersecting: false, intersectionRatio: 0 }]));
    expect(container.contains(firstSix[0])).toBe(false);
    expect(videos()[0]).toBe(firstSix[1]);
  });

  it("removes cancelled waiters, releases active slots on unmount and times out stalled decodes", () => {
    vi.useFakeTimers();
    function Decode({ requested }: { requested: boolean }) {
      const [granted] = useVideoDecodeSlot(requested);
      return <output>{granted ? "ready" : "waiting"}</output>;
    }
    root = createRoot(container);
    const render = (ids: number[], disabled: number[] = []) => {
      act(() => root!.render(ids.map((id) => <Decode key={id} requested={!disabled.includes(id)} />)));
      return Array.from(container.children, (child) => child.textContent);
    };
    const ids = Array.from({ length: 10 }, (_, i) => i);
    expect(render(ids).slice(5)).toEqual(["ready", "waiting", "waiting", "waiting", "waiting"]);
    expect(render(ids.slice(1), [6, 7]).slice(5)).toEqual(["waiting", "waiting", "ready", "waiting"]);
    expect(render(ids.slice(1), [1, 6, 7]).slice(5)).toEqual(["waiting", "waiting", "ready", "ready"]);
    render(ids);
    act(() => vi.advanceTimersByTime(2_500));
    expect(Array.from(container.children).every((child) => child.textContent === "ready")).toBe(true);
  });

  it("reacquires a slot when a settled card changes its source in-point or playback URL", () => {
    root = createRoot(container);
    function renderCards(url: string, start: number, count: number) {
      act(() => root!.render(Array.from({ length: count }, (_, i) => (
        <MirrorOrderMediaCard key={i} showPreview model={{
          id: String(i), mediaId: String(i), camera: "A", name: String(i),
          playbackUrl: i === 0 ? url : `/clip/${i}`, sourceStart: i === 0 ? start : 0,
        }} />
      ))));
    }
    const videoAt = (i: number) => container.querySelectorAll(".mo-media-card")[i].querySelector("video");
    renderCards("/first", 0, 7);
    const firstFrame = videoAt(0)!;
    act(() => firstFrame.dispatchEvent(new Event("loadeddata")));
    expect(videoAt(6)).not.toBeNull();
    renderCards("/first", 3, 7);
    expect(videoAt(0)).toBeNull();
    act(() => videoAt(1)!.dispatchEvent(new Event("loadeddata")));
    expect(videoAt(0)).not.toBe(firstFrame);
    renderCards("/first", 3, 8);
    act(() => videoAt(0)!.dispatchEvent(new Event("loadeddata")));
    expect(videoAt(7)).toBeNull();
    act(() => videoAt(0)!.dispatchEvent(new Event("seeked")));
    expect(videoAt(7)).not.toBeNull();
    renderCards("/replacement", 3, 8);
    expect(videoAt(0)).toBeNull();
    act(() => videoAt(2)!.dispatchEvent(new Event("loadeddata")));
    expect(videoAt(0)?.getAttribute("src")).toBe("/replacement");
  });
});
