export type DesktopAppearance = "system" | "light" | "dark";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeRootLike {
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, "colorScheme">;
}

const APPEARANCE_KEY = "mirrororder.desktop.appearance";
const APPEARANCE_EVENT = "mirrororder:desktop-appearance";

function browserStorage(): StorageLike | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function documentRoot(): ThemeRootLike | null {
  try { return globalThis.document?.documentElement ?? null; } catch { return null; }
}

export function normalizeDesktopAppearance(value: unknown): DesktopAppearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function readDesktopAppearance(storage: StorageLike | null = browserStorage()): DesktopAppearance {
  if (!storage) return "system";
  try { return normalizeDesktopAppearance(storage.getItem(APPEARANCE_KEY)); } catch { return "system"; }
}

export function applyDesktopAppearance(
  appearance: DesktopAppearance,
  root: ThemeRootLike | null = documentRoot(),
): DesktopAppearance {
  const next = normalizeDesktopAppearance(appearance);
  if (!root) return next;
  if (next === "system") delete root.dataset.mirrororderTheme;
  else root.dataset.mirrororderTheme = next;
  root.style.colorScheme = next === "system" ? "light dark" : next;
  return next;
}

export function saveDesktopAppearance(
  appearance: DesktopAppearance,
  storage: StorageLike | null = browserStorage(),
  root: ThemeRootLike | null = documentRoot(),
): DesktopAppearance {
  const next = applyDesktopAppearance(appearance, root);
  try { storage?.setItem(APPEARANCE_KEY, next); } catch { /* device-local convenience only */ }
  try { globalThis.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: next })); } catch { /* non-DOM test/runtime */ }
  return next;
}

export function initializeDesktopAppearance(): DesktopAppearance {
  return applyDesktopAppearance(readDesktopAppearance());
}

export function desktopAppearanceEventName(): string {
  return APPEARANCE_EVENT;
}
