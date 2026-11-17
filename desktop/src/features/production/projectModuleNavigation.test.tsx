// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProjectModuleNavigation,
  canOpenProductionModule,
  modulesForProject,
} from "./ProjectModuleNavigation";

describe("independent production module routing", () => {
  it("starts raw-media projects with three different sync tasks rather than a single editor workspace", () => {
    const groups = modulesForProject("media-directory");
    expect(groups.map((group) => group.id)).toEqual(["delivery", "organize", "editorial"]);
    expect(groups[0].modules.map((item) => item.page)).toEqual([
      "sync-task", "sync-inspect", "sync-delivery",
    ]);
    expect(new Set(groups.flatMap((group) => group.modules.map((item) => item.page))).size).toBe(10);
    expect(groups.flatMap((group) => group.modules).map((item) => item.label)).toContain("交互场记");
    expect(groups.flatMap((group) => group.modules).map((item) => item.label)).toContain("演员与角色");
  });

  it("never advertises unfinished sync outputs as available, but allows local media checks", () => {
    expect(canOpenProductionModule("sync-task", "media-directory", false)).toBe(true);
    expect(canOpenProductionModule("sync-inspect", "media-directory", false)).toBe(false);
    expect(canOpenProductionModule("sync-delivery", "media-directory", false)).toBe(false);
    expect(canOpenProductionModule("media-library", "media-directory", false)).toBe(true);
    expect(canOpenProductionModule("media-binding", "media-directory", false)).toBe(true);
    expect(canOpenProductionModule("script", "media-directory", false)).toBe(false);
    expect(canOpenProductionModule("sync-inspect", "media-directory", true)).toBe(true);
    expect(canOpenProductionModule("sync-delivery", "media-directory", true)).toBe(true);
    expect(canOpenProductionModule("sync-task", "fcpxml", true)).toBe(false);
    expect(modulesForProject("fcpxml").some((group) => group.id === "delivery")).toBe(false);
  });

  it("shows a clear selected task and disabled future steps instead of a dashboard of active dead ends", () => {
    const markup = renderToStaticMarkup(createElement(ProjectModuleNavigation, {
      inputKind: "media-directory",
      selected: "sync-task",
      syncReady: false,
      syncPhase: "running",
      onNavigate: () => {},
    }));
    const root = document.createElement("div");
    root.innerHTML = markup;
    const nav = [...root.querySelectorAll<HTMLButtonElement>("button.project-module-link")];
    expect(nav).toHaveLength(10);
    expect(nav.filter((button) => !button.disabled).map((button) => button.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("同步任务"), expect.stringContaining("素材库")]),
    );
    expect(nav.find((button) => button.textContent?.includes("工程交付"))?.disabled).toBe(true);
    expect(root.querySelector('[aria-current="page"]')?.textContent).toContain("同步任务");
    expect(root.textContent).toContain("正在同步");
  });
});
