export type DesktopAppearance = "system" | "light" | "dark";
export type DesktopResolvedTheme = "light" | "dark";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ThemeRootLike {
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, "colorScheme">;
}

interface MediaQueryListLike {
  matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

const APPEARANCE_KEY = "mirrororder.desktop.appearance";
const APPEARANCE_EVENT = "mirrororder:desktop-appearance";
const DARK_QUERY = "(prefers-color-scheme: dark)";
let detachSystemListener: (() => void) | null = null;

function browserStorage(): StorageLike | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function documentRoot(): ThemeRootLike | null {
  try { return globalThis.document?.documentElement ?? null; } catch { return null; }
}

function systemDarkPreference(): boolean {
  try { return globalThis.matchMedia?.(DARK_QUERY).matches ?? false; } catch { return false; }
}

function systemThemeQuery(): MediaQueryListLike | null {
  try { return globalThis.matchMedia?.(DARK_QUERY) ?? null; } catch { return null; }
}

export function normalizeDesktopAppearance(value: unknown): DesktopAppearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveDesktopTheme(
  appearance: DesktopAppearance,
  prefersDark: boolean = systemDarkPreference(),
): DesktopResolvedTheme {
  const next = normalizeDesktopAppearance(appearance);
  return next === "system" ? (prefersDark ? "dark" : "light") : next;
}

export function readDesktopAppearance(storage: StorageLike | null = browserStorage()): DesktopAppearance {
  if (!storage) return "system";
  try { return normalizeDesktopAppearance(storage.getItem(APPEARANCE_KEY)); } catch { return "system"; }
}

export function applyDesktopAppearance(
  appearance: DesktopAppearance,
  root: ThemeRootLike | null = documentRoot(),
  prefersDark: boolean = systemDarkPreference(),
): DesktopAppearance {
  const next = normalizeDesktopAppearance(appearance);
  const resolved = resolveDesktopTheme(next, prefersDark);
  if (!root) return next;
  root.dataset.mirrororderAppearance = next;
  root.dataset.mirrororderTheme = resolved;
  root.style.colorScheme = resolved;
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

function installSystemAppearanceListener(): void {
  detachSystemListener?.();
  detachSystemListener = null;
  const query = systemThemeQuery();
  if (!query) return;
  const sync = () => {
    if (readDesktopAppearance() === "system") applyDesktopAppearance("system");
  };
  if (query.addEventListener && query.removeEventListener) {
    query.addEventListener("change", sync);
    detachSystemListener = () => query.removeEventListener?.("change", sync);
    return;
  }
  if (query.addListener && query.removeListener) {
    query.addListener(sync);
    detachSystemListener = () => query.removeListener?.(sync);
  }
}

export function initializeDesktopAppearance(): DesktopAppearance {
  const appearance = readDesktopAppearance();
  applyDesktopAppearance(appearance);
  installSystemAppearanceListener();
  return appearance;
}

export function desktopAppearanceEventName(): string {
  return APPEARANCE_EVENT;
}
