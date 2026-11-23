import type { FocusEvent, SyntheticEvent } from "react";

const outsideCleanups = new WeakMap<HTMLDetailsElement, () => void>();

function detachOutsideDismiss(details: HTMLDetailsElement): void {
  const cleanup = outsideCleanups.get(details);
  if (cleanup) {
    cleanup();
    outsideCleanups.delete(details);
  }
}

/**
 * macOS WKWebView (WebKit) does not move focus to a `<button>` on mousedown,
 * so `<details onBlur>` receives `relatedTarget === null` and collapses the
 * popover before the button's `click` event fires.
 *
 * Close on `pointerdown` outside the `<details>` while open, and on `blur`
 * only when focus explicitly moved to a node outside the `<details>`.
 */
export function handleDetailsMenuToggle(
  event: SyntheticEvent<HTMLDetailsElement>,
): void {
  const details = event.currentTarget;
  detachOutsideDismiss(details);
  if (!details.open) return;

  const onPointerDown = (pointerEvent: Event) => {
    const target = pointerEvent.target as Node | null;
    if (!details.isConnected || !details.open) {
      detachOutsideDismiss(details);
      return;
    }
    if (target && details.contains(target)) return;
    details.open = false;
    detachOutsideDismiss(details);
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  outsideCleanups.set(details, () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
  });
}

export function handleDetailsMenuBlur(
  event: FocusEvent<HTMLDetailsElement>,
): void {
  const related = event.relatedTarget as Node | null;
  if (related && !event.currentTarget.contains(related)) {
    event.currentTarget.open = false;
    detachOutsideDismiss(event.currentTarget);
  }
}

export function closeDetailsMenu(element: HTMLElement | null): void {
  const details = element?.closest("details");
  if (!details) return;
  details.open = false;
  detachOutsideDismiss(details);
}
