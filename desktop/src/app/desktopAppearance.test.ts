import { describe, expect, it } from "vitest";
import {
  applyDesktopAppearance,
  normalizeDesktopAppearance,
  readDesktopAppearance,
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

  it("stores Desktop appearance only in device-local browser storage", () => {
    const storage = new MemoryStorage();
    const target = root();
    expect(saveDesktopAppearance("dark", storage, target)).toBe("dark");
    expect(readDesktopAppearance(storage)).toBe("dark");
    expect(target.dataset.mirrororderTheme).toBe("dark");
    expect(target.style.colorScheme).toBe("dark");
  });

  it("system mode removes the explicit DOM override", () => {
    const target = root();
    applyDesktopAppearance("light", target);
    expect(target.dataset.mirrororderTheme).toBe("light");
    applyDesktopAppearance("system", target);
    expect(target.dataset.mirrororderTheme).toBeUndefined();
    expect(target.style.colorScheme).toBe("light dark");
  });
});
