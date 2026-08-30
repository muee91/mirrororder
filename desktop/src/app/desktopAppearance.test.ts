import { describe, expect, it } from "vitest";
import {
  applyDesktopAppearance,
  normalizeDesktopAppearance,
  readDesktopAppearance,
  resolveDesktopTheme,
  saveDesktopAppearance,
} from "./desktopAppearance";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function root() {
  return { dataset: {} as DOMStringMap, style: { colorScheme: "" } };
}

describe("Desktop appearance", () => {
  it("fails closed to system for unknown values", () => {
    expect(normalizeDesktopAppearance("sepia")).toBe("system");
    expect(normalizeDesktopAppearance(null)).toBe("system");
  });

  it("resolves system from the OS while manual choices stay authoritative", () => {
    expect(resolveDesktopTheme("system", false)).toBe("light");
    expect(resolveDesktopTheme("system", true)).toBe("dark");
    expect(resolveDesktopTheme("light", true)).toBe("light");
    expect(resolveDesktopTheme("dark", false)).toBe("dark");
  });

  it("stores Desktop appearance only in device-local browser storage", () => {
    const storage = new MemoryStorage();
    const target = root();
    expect(saveDesktopAppearance("dark", storage, target)).toBe("dark");
    expect(readDesktopAppearance(storage)).toBe("dark");
    expect(target.dataset.mirrororderAppearance).toBe("dark");
    expect(target.dataset.mirrororderTheme).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("system mode keeps the preference marker while applying a concrete theme", () => {
    const target = root();
    applyDesktopAppearance("system", target, false);
    expect(target.dataset.mirrororderAppearance).toBe("system");
    expect(target.dataset.mirrororderTheme).toBe("light");
    expect(target.style.colorScheme).toBe("light");
    applyDesktopAppearance("system", target, true);
    expect(target.dataset.mirrororderTheme).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("manual light and dark ignore the opposite OS preference", () => {
    const target = root();
    applyDesktopAppearance("light", target, true);
    expect(target.dataset.mirrororderTheme).toBe("light");
    expect(target.style.colorScheme).toBe("light");
    applyDesktopAppearance("dark", target, false);
    expect(target.dataset.mirrororderTheme).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });
});
