/** View-only frame coordinates. Callers retain their own timebase and write authority.
 * Sync review frames must be mapped to master frames by the sync owner, never here. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export interface FrameWindow { start: number; span: number }
export function boundedWindow(start: number, span: number, total: number): FrameWindow {
  const width = clamp(Math.round(span), 1, total);
  return { start: clamp(Math.round(start), 0, total - width), span: width };
}
export function zoomWindow(view: FrameWindow, factor: number, anchor: number, total: number, minSpan: number): FrameWindow {
  const ratio = clamp((anchor - view.start) / view.span, 0, 1);
  const span = clamp(Math.round(view.span / factor), Math.min(minSpan, total), total);
  return boundedWindow(anchor - ratio * span, span, total);
}
export function pointerFrame(x: number, left: number, width: number, view: FrameWindow): number {
  return Math.round(view.start + clamp((x - left) / Math.max(1, width), 0, 1) * view.span);
}

export function framePosition(frame: number, view: FrameWindow): number {
  return (frame - view.start) / Math.max(1, view.span);
}
export function revealFrame(frame: number, view: FrameWindow, total: number): FrameWindow {
  return frame >= view.start && frame < view.start + view.span
    ? boundedWindow(view.start, view.span, total)
    : boundedWindow(frame - view.span / 2, view.span, total);
}
export function rulerStep(pixelsPerFrame: number, spacing = 100): number {
  const desired = Math.max(1, spacing / Math.max(0.001, pixelsPerFrame));
  const decade = 10 ** Math.floor(Math.log10(desired));
  return [1, 2, 5, 10].map(n => n * decade).find(n => n >= desired) ?? decade * 10;
}
export function rulerTicks(view: FrameWindow, width: number, spacing = 150): number[] {
  const step = rulerStep(Math.max(1, width) / view.span, spacing);
  const ticks: number[] = [];
  for (let frame = Math.ceil(view.start / step) * step; frame <= view.start + view.span; frame += step) ticks.push(frame);
  return ticks;
}
export function frameStep(key: string, shiftKey: boolean): number {
  return (key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0) * (shiftKey ? 10 : 1);
}
export type NavigationAction = { type: "seek"; frame: number } | { type: "zoom"; factor: number } | { type: "pan"; direction: number };
/** No editing, persistence, history or playback side effects in keyboard navigation. */
export function navigationKey(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, cursor: number, total: number, frameAccurate = true): NavigationAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const delta = frameStep(event.key, event.shiftKey);
  if (frameAccurate && (event.key === "ArrowLeft" || event.key === "ArrowRight"))
    return { type: "seek", frame: clamp(Math.round(cursor) + delta, 0, Math.max(0, total - 1)) };
  if (event.key === "Home" || event.key === "End") return { type: "seek", frame: event.key === "Home" ? 0 : Math.max(0, total - 1) };
  if (event.key === "+" || event.key === "=") return { type: "zoom", factor: 2 };
  if (event.key === "-") return { type: "zoom", factor: 0.5 };
  if (event.key === "PageUp" || event.key === "PageDown") return { type: "pan", direction: event.key === "PageUp" ? -1 : 1 };
  return null;
}
