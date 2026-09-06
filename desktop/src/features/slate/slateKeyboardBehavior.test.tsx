// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlateRecord } from "../../api/production";
import { SlateRow, type SlateRowModel } from "./SlateRow";
import {
  SlatePlaybackShortcuts,
  applySlatePlaybackKey,
  slatePlaybackTargetBlocked,
} from "./SlatePlaybackShortcuts";

describe("slate playback target ownership", () => {
  it("blocks buttons and editable targets but not free focus", () => {
    const button = document.createElement("button");
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const free = document.createElement("div");
    expect(slatePlaybackTargetBlocked(button)).toBe(true);
    expect(slatePlaybackTargetBlocked(input)).toBe(true);
    expect(slatePlaybackTargetBlocked(editable)).toBe(true);
    expect(slatePlaybackTargetBlocked(free)).toBe(false);
    expect(slatePlaybackTargetBlocked(null)).toBe(false);
  });
});

describe("SlatePlaybackShortcuts keyboard ownership", () => {
  let container: HTMLDivElement;
  let holder: HTMLDivElement;
  let root: Root | null = null;
  let video: HTMLVideoElement;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    // React 19 createRoot 首渲染会清空容器内容——视频挂载点必须独立于 React 容器。
    holder = document.createElement("div");
    holder.className = "golden-slate-player";
    video = document.createElement("video");
    video.play = vi.fn();
    video.pause = vi.fn();
    holder.appendChild(video);
    document.body.appendChild(holder);
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
      root.render(<SlatePlaybackShortcuts />);
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
      root = null;
    });
    container.remove();
    holder.remove();
  });

  it("leaves Space activation on a focused button untouched", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(video.play).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps transport keys working from free focus", () => {
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    document.body.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
    const pause = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true });
    document.body.dispatchEvent(pause);
    expect(video.pause).toHaveBeenCalledTimes(1);
  });
});

describe("SlateRow keyboard selection", () => {
  const row: SlateRowModel = {
    recordId: "r1",
    rowNumber: 3,
    selected: false,
    dirty: false,
    derivedSource: "",
    episode: null,
    scene: "5",
    mappedScenePlaceholder: "",
    shot: "2",
    takeNumber: null,
    status: "unmarked" as SlateRecord["status"] extends infer S ? S : never,
  };

  it("selects the row via Enter/Space on the row itself, not from inner inputs", () => {
    const select = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(container);
    act(() => {
      root.render(
        <table>
          <tbody>
            <SlateRow row={row} onSelect={select} onPatch={() => undefined} renderMedia={() => null} />
          </tbody>
        </table>,
      );
    });
    const tr = container.querySelector("tr");
    expect(tr?.getAttribute("tabindex")).toBe("0");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    tr?.dispatchEvent(enter);
    expect(select).toHaveBeenCalledTimes(1);
    const input = tr?.querySelector("input");
    expect(input).not.toBeNull();
    const typed = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    input?.dispatchEvent(typed);
    expect(select).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

describe("applySlatePlaybackKey", () => {
  it("steps one second backward for J without fake reverse playback", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 5, writable: true });
    video.pause = vi.fn();
    applySlatePlaybackKey(video, "j");
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBe(4);
  });
});
