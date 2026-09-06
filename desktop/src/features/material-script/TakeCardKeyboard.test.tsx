// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTakeGroup } from "../../api/host";
import { TakeCard } from "./TakeCard";

function take(): ReviewTakeGroup {
  return {
    group_id: "g1",
    parent_group_id: "",
    kind: "multicam",
    take_index: 1,
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

describe("TakeCard keyboard activation", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function renderCard(): { select: ReturnType<typeof vi.fn>; card: HTMLElement } {
    const select = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <TakeCard
          take={take()}
          selected
          onSelect={select}
          onDragBegin={() => undefined}
          onDragFinish={() => undefined}
        />,
      );
    });
    const card = container.querySelector("article.take-card") as HTMLElement;
    return { select, card };
  }

  it("activates selection with Enter and Space on the card surface", () => {
    const { select, card } = renderCard();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    card.dispatchEvent(enter);
    expect(select).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    card.dispatchEvent(space);
    expect(select).toHaveBeenCalledTimes(2);
    expect(space.defaultPrevented).toBe(true);
  });

  it("does not steal activation from the card's own action buttons", () => {
    const { select, card } = renderCard();
    const actionButton = card.querySelector("button.take-select") as HTMLButtonElement;
    expect(actionButton).not.toBeNull();
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    actionButton.dispatchEvent(space);
    expect(select).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true });
    actionButton.dispatchEvent(click);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
