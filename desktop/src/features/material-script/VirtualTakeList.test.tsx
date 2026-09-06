// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTakeGroup } from "../../api/host";
import { VirtualTakeList } from "./VirtualTakeList";

function take(groupId: string, takeIndex: number): ReviewTakeGroup {
  return {
    group_id: groupId,
    parent_group_id: "",
    kind: "multicam",
    take_index: takeIndex,
    split_reason: "",
    start: 0,
    end: 10,
    duration: 10,
    cameras: ["A"],
    angles: [],
    transcript: { text: "", source: "none" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: [], script_segment_ids: [] },
    automatic_state: {},
    editorial_state: {},
    effective_mapping: {
      source: "none",
      mapping_status: "unresolved",
      script_segment_ids: [],
      episode_ids: [],
    },
    issues: [],
  };
}

describe("VirtualTakeList compact virtualization", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
      root = null;
    });
    container.remove();
  });

  function renderCompact(takes: ReviewTakeGroup[]): { select: ReturnType<typeof vi.fn> } {
    const select = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(
        <VirtualTakeList
          variant="compact"
          takes={takes}
          selectedGroupId={null}
          onSelect={select}
        />,
      );
    });
    return { select };
  }

  it("mounts only a viewport-bounded window of a 1500-take list", () => {
    const takes = Array.from({ length: 1500 }, (_, index) => take(`g${index}`, index + 1));
    renderCompact(takes);
    const mounted = container.querySelectorAll(".virtual-take-row").length;
    // jsdom clientHeight 退回 720 默认视口：compact 行高 82 + overscan 3。
    expect(mounted).toBeGreaterThanOrEqual(9);
    expect(mounted).toBeLessThanOrEqual(30);
    expect(container.querySelector('article[aria-label^="Take #1"]')).not.toBeNull();
    expect(container.querySelector('article[aria-label^="Take #800"]')).toBeNull();
  });

  it("updates the rendered window after scrolling without mounting the full list", () => {
    const takes = Array.from({ length: 1500 }, (_, index) => take(`g${index}`, index + 1));
    renderCompact(takes);
    const scroller = container.querySelector<HTMLElement>(".take-virtual-scroll");
    expect(scroller).not.toBeNull();
    act(() => {
      scroller!.scrollTop = 100 * 82;
      scroller!.dispatchEvent(new Event("scroll"));
    });
    const mounted = container.querySelectorAll(".virtual-take-row").length;
    expect(mounted).toBeLessThanOrEqual(30);
    expect(container.querySelector('article[aria-label^="Take #98 "]')).not.toBeNull();
    expect(container.querySelector('article[aria-label^="Take #1 "]')).toBeNull();
  });

  it("keeps stable group_id keys and reports row selection", () => {
    const takes = Array.from({ length: 40 }, (_, index) => take(`g${index}`, index + 1));
    const { select } = renderCompact(takes);
    const firstRow = container.querySelector("article.mo-take-list-row");
    expect(firstRow?.getAttribute("aria-label")).toContain("Take #1");
    act(() => {
      firstRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(select).toHaveBeenCalledWith(takes[0]);
  });
});
