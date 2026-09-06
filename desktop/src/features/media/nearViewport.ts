import { useEffect, useRef, useState, type RefObject } from "react";

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
    const observer = new IntersectionObserver((entries) => {
      setNearViewport(entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0));
    }, { rootMargin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return [ref, nearViewport];
}
