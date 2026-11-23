// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDetailsMenu,
  handleDetailsMenuBlur,
  handleDetailsMenuToggle,
} from "./detailsMenuDismiss";

describe("detailsMenuDismiss (macOS WKWebView safe dropdowns)", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps menu open on WebKit blur with null relatedTarget so button clicks fire, and closes on outside pointerdown", async () => {
    const onAction = vi.fn();
    await act(async () => {
      root.render(
        <div>
          <details onToggle={handleDetailsMenuToggle} onBlur={handleDetailsMenuBlur}>
            <summary>工具</summary>
            <div>
              <button type="button" onClick={(e) => { closeDetailsMenu(e.currentTarget); onAction(); }}>
                右侧详情栏
              </button>
            </div>
          </details>
          <button type="button" className="outside">外部按钮</button>
        </div>,
      );
    });

    const details = host.querySelector("details")!;
    const summary = host.querySelector("summary")!;
    const item = host.querySelector<HTMLButtonElement>("details button")!;
    const outside = host.querySelector<HTMLButtonElement>(".outside")!;

    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(true);

    // Simulate WebKit clicking a button inside the popover:
    // pointerdown inside -> blur on summary with relatedTarget=null -> click on button.
    await act(async () => {
      item.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      summary.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: null }));
    });
    expect(details.open).toBe(true);

    await act(async () => {
      item.click();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(details.open).toBe(false);

    // Re-open and verify outside pointerdown dismisses cleanly.
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(true);
    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(details.open).toBe(false);
  });
});
