import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeNearViewport } from "../media/nearViewport";

interface Props {
  count: number;
  index: number;
  selectedIndex: number;
  queueId: string;
  rowKey: string;
  heights: Map<string, number>;
  estimate: number;
  pinLast?: boolean;
  children: () => ReactNode;
}

// Take cards vary with cameras, dialogue and expanded evidence. Keep their last
// measured height in the scroll flow while the expensive card is offscreen.
export function ReviewQueueRow({ count, index, selectedIndex, queueId, rowKey, heights, estimate, pinLast, children }: Props) {
  const windowed = count > 64;
  // Pin the last fragment when its navigation button must survive a jump to the scroll limit.
  const eager = index === 0 || (pinLast && index === count - 1) || Math.abs(index - Math.max(0, selectedIndex)) <= 1;
  const row = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [focused, setFocused] = useState(false);
  const mounted = !windowed || eager || near || focused;

  useEffect(() => {
    const node = row.current;
    if (!windowed || !node) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    return observeNearViewport(node, setNear, queueId, notify =>
      new IntersectionObserver(notify, { root: node.parentElement, rootMargin: "320px 0px" }));
  }, [queueId, windowed]);

  useLayoutEffect(() => {
    const node = row.current;
    if (!windowed || !mounted || !node) return;
    function measure() {
      const height = node?.offsetHeight;
      if (height) heights.set(rowKey, height);
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [heights, mounted, rowKey, windowed]);

  if (!windowed) return children();
  return <div ref={row} style={mounted ? undefined : { height: heights.get(rowKey) ?? estimate }}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    {mounted && children()}
  </div>;
}
