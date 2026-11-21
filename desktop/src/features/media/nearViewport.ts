import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

type ViewportListener = (visible: boolean) => void;
type ViewportPool = { observer: IntersectionObserver; listeners: Map<Element, ViewportListener> };
const viewportPools = new Map<string, ViewportPool>();

export function observeNearViewport(
  element: Element,
  listener: ViewportListener,
  rootMargin: string,
  createObserver = (dispatch: IntersectionObserverCallback) => new IntersectionObserver(dispatch, { rootMargin }),
): () => void {
  let pool = viewportPools.get(rootMargin);
  if (!pool) {
    const listeners = new Map<Element, ViewportListener>();
    const observer = createObserver((entries) => {
      for (const entry of entries) {
        const visible = entry.isIntersecting || entry.intersectionRatio > 0;
        if (entry.target === undefined) listeners.forEach((notify) => notify(visible));
        else listeners.get(entry.target)?.(visible);
      }
    });
    pool = { observer, listeners };
    viewportPools.set(rootMargin, pool);
  }
  const { observer, listeners } = pool;
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    listeners.delete(element);
    observer.unobserve(element);
    if (!listeners.size) {
      observer.disconnect();
      viewportPools.delete(rootMargin);
    }
  };
}

/**
 * Viewport-gated preview activation（模式来自 MirrorOrderMediaCard 的
 * IntersectionObserver 约定）：只有接近视口时才返回 true，让调用方延迟
 * 实例化 <video> decoder surface；屏幕外的行保持静态占位，避免长列表
 * 一次性挂载上百个视频解码器。`enabled=false` 时始终视为在视口内。
 */
export function useNearViewportGate<T extends HTMLElement>(
  enabled: boolean,
  rootMargin = "48px 96px",
): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setNearViewport(true);
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    return observeNearViewport(element, setNearViewport, rootMargin);
  }, [enabled, rootMargin]);

  return [ref, nearViewport];
}

const MAX_CONCURRENT_VIDEO_DECODES = 6;
const queuedDecodes = new Set<() => void>();
let activeDecodes = 0;

/** Keep a granted preview mounted until it leaves the viewport or requests a different frame. */
export function useVideoDecodeSlot(requested: boolean, requestKey = ""): [boolean, () => void] {
  const [grantedKey, setGrantedKey] = useState<string | null>(null);
  const active = useRef<{ key: string; release: () => void } | null>(null);
  const markSettled = useCallback(() => {
    if (active.current?.key === requestKey) active.current.release();
  }, [requestKey]);

  useLayoutEffect(() => {
    setGrantedKey(null);
    if (!requested) return;
    const grant = () => {
      activeDecodes += 1;
      const timeout = window.setTimeout(markSettled, 2_500);
      const release = () => {
        active.current = null;
        window.clearTimeout(timeout);
        activeDecodes -= 1;
        const next = queuedDecodes.values().next().value;
        if (next) {
          queuedDecodes.delete(next);
          next();
        }
      };
      active.current = { key: requestKey, release };
      setGrantedKey(requestKey);
    };
    if (activeDecodes < MAX_CONCURRENT_VIDEO_DECODES) grant();
    else queuedDecodes.add(grant);
    return () => {
      queuedDecodes.delete(grant);
      markSettled();
    };
  }, [requested, requestKey, markSettled]);

  return [requested && grantedKey === requestKey, markSettled];
}
