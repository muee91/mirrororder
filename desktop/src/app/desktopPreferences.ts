import { useEffect, useState } from "react";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SHOW_ROUGH_CUT_KEY = "mirrororder.desktop.showRoughCut";
const SHOW_ROUGH_CUT_EVENT = "mirrororder:desktop-show-rough-cut";

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readShowRoughCutPreference(
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_ROUGH_CUT_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveShowRoughCutPreference(enabled: boolean): boolean {
  try {
    browserStorage()?.setItem(SHOW_ROUGH_CUT_KEY, String(enabled));
  } catch {
    // Device-local convenience only. Test environments may not expose storage.
  }
  try {
    globalThis.dispatchEvent?.(
      new CustomEvent(SHOW_ROUGH_CUT_EVENT, { detail: enabled }),
    );
  } catch {
    // CustomEvent is unavailable in some non-DOM test environments.
  }
  return enabled;
}

export function showRoughCutEventName(): string {
  return SHOW_ROUGH_CUT_EVENT;
}

export function useShowRoughCutPreference(): [
  boolean,
  (next: boolean) => void,
] {
  const [enabled, setEnabled] = useState(() => readShowRoughCutPreference());

  useEffect(() => {
    const sync = () => setEnabled(readShowRoughCutPreference());
    try {
      globalThis.addEventListener?.(SHOW_ROUGH_CUT_EVENT, sync);
      globalThis.addEventListener?.("storage", sync);
    } catch {
      // Event listeners are optional in non-browser renderers and tests.
    }
    return () => {
      try {
        globalThis.removeEventListener?.(SHOW_ROUGH_CUT_EVENT, sync);
        globalThis.removeEventListener?.("storage", sync);
      } catch {
        // Event listeners are optional in non-browser renderers and tests.
      }
    };
  }, []);

  return [enabled, (next: boolean) => {
    saveShowRoughCutPreference(next);
    setEnabled(next);
  }];
}
