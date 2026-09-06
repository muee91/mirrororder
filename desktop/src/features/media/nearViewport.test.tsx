// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNearViewportGate } from "./nearViewport";

type Entry = { isIntersecting: boolean; intersectionRatio: number };

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
  unobserve(): void {}
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
});
