// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewScriptBlock } from "../../api/host";
import { ScriptBlock } from "./ScriptBlock";

const block: ReviewScriptBlock = {
  segment_id: "s1",
  episode: 1,
  scene_id: "sc1",
  order: 1,
  type: "dialogue",
  speaker: "角色",
  text: "台词",
  raw_text: "台词",
  issues: [],
};

describe("ScriptBlock keyboard target ownership", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function renderBlock(selected: boolean): { onSelect: ReturnType<typeof vi.fn>; article: HTMLElement } {
    const onSelect = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <ScriptBlock
          block={block}
          mappedTakeIds={[]}
          candidateTakeIds={[]}
          selected={selected}
          projectionMode="script"
          draggingGroupId={null}
          placementGroupId={null}
          onSelect={onSelect}
          onOpenContext={() => undefined}
          onShowTake={() => undefined}
          onDropPlacement={() => undefined}
          onClickPlacement={() => undefined}
        />,
      );
    });
    const article = container.querySelector("article.script-block") as HTMLElement;
    return { onSelect, article };
  }

  it("activates block selection with Enter/Space on the block surface", () => {
    const { onSelect, article } = renderBlock(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    article.dispatchEvent(enter);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("keeps Enter activation on the block's own action buttons", () => {
    const { onSelect, article } = renderBlock(true);
    const actionButton = article.querySelector("button") as HTMLButtonElement;
    expect(actionButton).not.toBeNull();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    actionButton.dispatchEvent(enter);
    expect(onSelect).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
  });
});
