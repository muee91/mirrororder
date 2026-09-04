import { describe, expect, it } from "vitest";
import { canonicalProductionPage, readProjectPage, rememberProjectPage } from "./resumeState";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
}

describe("legacy editor page migration", () => {
  it("routes rough-cut and assembly into the single timeline workbench", () => {
    expect(canonicalProductionPage("rough-cut")).toBe("timeline");
    expect(canonicalProductionPage("assembly")).toBe("timeline");
  });

  it("migrates saved legacy pages without losing the project resume", () => {
    const store = storage();
    store.setItem("mirrororder.desktop.project-page.p1", "assembly");
    expect(readProjectPage("p1", store)).toBe("timeline");
    rememberProjectPage("p1", "rough-cut", store);
    expect(store.getItem("mirrororder.desktop.project-page.p1")).toBe("timeline");
  });
});
