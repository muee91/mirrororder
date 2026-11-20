import { boundedWindow, clamp, pointerFrame, zoomWindow, type FrameWindow } from "./timelineViewport";

type WindowState = { view: FrameWindow; total: number };
type ChangeView = (update: (current: FrameWindow) => FrameWindow) => void;
type Gesture = Event & { scale?: number; clientX?: number };
type PinchStart = { initial: FrameWindow; anchor: number; minSpan: number };

const GESTURE_WHEEL_TAIL_MS = 90;
const WHEEL_ZOOM_SPEED = 0.004;

export function bindTimelineViewportInput(
  surface: HTMLElement,
  ruler: HTMLElement,
  read: () => WindowState,
  change: ChangeView,
): () => void {
  const lineHeight = Number.parseFloat(getComputedStyle(surface).lineHeight) || 16;
  const minimumSpan = (width: number) => Math.max(2, Math.floor(width / 12));
  let pointerX: number | undefined;
  let frameRequest = 0;
  let wheel = { logZoom: 0, pan: 0, x: 0 };
  let gesture: PinchStart | null = null;
  let pendingPinch: { start: PinchStart; scale: number } | null = null;
  let lastGestureEnd = -Infinity;

  function flush(): void {
    frameRequest = 0;
    const pinch = pendingPinch;
    const queuedWheel = wheel;
    pendingPinch = null;
    wheel = { logZoom: 0, pan: 0, x: 0 };
    const { total } = read();
    if (pinch) {
      const { initial, anchor, minSpan } = pinch.start;
      change(current => preserveSameWindow(current, zoomWindow(initial, pinch.scale, anchor, total, minSpan)));
      return;
    }
    const { left, width } = ruler.getBoundingClientRect();
    if (width < 1 || (!queuedWheel.pan && !queuedWheel.logZoom)) return;
    change(current => {
      const anchor = pointerFrame(queuedWheel.x, left, width, current);
      const zoomed = queuedWheel.logZoom
        ? zoomWindow(current, Math.exp(clamp(queuedWheel.logZoom, -7, 7)), anchor, total, minimumSpan(width))
        : current;
      const next = queuedWheel.pan ? boundedWindow(zoomed.start + queuedWheel.pan / width * zoomed.span, zoomed.span, total) : zoomed;
      return preserveSameWindow(current, next);
    });
  }

  function schedule(): void {
    if (!frameRequest) frameRequest = requestAnimationFrame(flush);
  }

  function onWheel(event: WheelEvent): void {
    const mode = event.deltaMode;
    const zoom = event.ctrlKey || event.metaKey;
    if (!zoom && !event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (zoom) {
      if (gesture || performance.now() - lastGestureEnd < GESTURE_WHEEL_TAIL_MS) return;
      const unit = mode === 1 ? lineHeight : mode === 2 ? surface.clientHeight : 1;
      wheel.logZoom -= event.deltaY * unit * WHEEL_ZOOM_SPEED;
      wheel.x = event.clientX;
    } else {
      const unit = mode === 1 ? lineHeight : mode === 2 ? ruler.clientWidth : 1;
      wheel.pan += (event.shiftKey ? event.deltaY || event.deltaX : event.deltaX) * unit;
    }
    schedule();
  }

  function startPinch(event: Gesture): void {
    const { left, width } = ruler.getBoundingClientRect();
    if (width < 1) return;
    event.preventDefault();
    const x = typeof event.clientX === "number" && Number.isFinite(event.clientX) && event.clientX > 0
      ? event.clientX : pointerX ?? left + width / 2;
    const { view } = read();
    gesture = { initial: view, anchor: pointerFrame(x, left, width, view), minSpan: minimumSpan(width) };
    pendingPinch = null;
    wheel = { logZoom: 0, pan: 0, x: 0 };
  }

  function changePinch(event: Gesture): void {
    if (!gesture) return;
    event.preventDefault();
    if (typeof event.scale !== "number" || !Number.isFinite(event.scale) || event.scale <= 0) return;
    pendingPinch = { start: gesture, scale: event.scale };
    schedule();
  }

  function endPinch(event: Event): void {
    if (!gesture) return;
    event.preventDefault();
    gesture = null;
    lastGestureEnd = performance.now();
  }

  function interrupt(): void {
    if (gesture) lastGestureEnd = performance.now();
    gesture = null;
    pendingPinch = null;
    wheel = { logZoom: 0, pan: 0, x: 0 };
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
  }

  const trackPointer = (event: PointerEvent) => { pointerX = event.clientX; };
  const onVisibility = () => { if (document.hidden) interrupt(); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && gesture) interrupt(); };
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("pointermove", trackPointer, { passive: true });
  surface.addEventListener("gesturestart", startPinch, { passive: false });
  window.addEventListener("gesturechange", changePinch, { passive: false });
  window.addEventListener("gestureend", endPinch, { passive: false });
  window.addEventListener("gesturecancel", interrupt);
  window.addEventListener("blur", interrupt);
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    interrupt();
    surface.removeEventListener("wheel", onWheel);
    surface.removeEventListener("pointermove", trackPointer);
    surface.removeEventListener("gesturestart", startPinch);
    window.removeEventListener("gesturechange", changePinch);
    window.removeEventListener("gestureend", endPinch);
    window.removeEventListener("gesturecancel", interrupt);
    window.removeEventListener("blur", interrupt);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function preserveSameWindow(current: FrameWindow, next: FrameWindow): FrameWindow {
  return current.start === next.start && current.span === next.span ? current : next;
}
