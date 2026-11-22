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

  it("renders the five stable workbenches with a clear selected task and lock state", () => {
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
    expect(nav).toHaveLength(5);
    expect([...nav].map((button) => button.textContent?.trim())).toEqual(["同步", "场记", "剧本", "素材", "审阅"]);
    expect([...nav].map((button) => button.getAttribute("aria-label"))).toEqual(["同步核对（当前为同步任务）", "交互场记", "剧本关联", "素材库", "看片审阅"]);
    expect(root.querySelector(".project-module-overflow")).toBeNull();
    expect(root.querySelector('[aria-current="page"]')?.textContent).toContain("同步");
    expect(root.querySelector('[aria-current="page"] .project-module-running')).toBeTruthy();
    expect(nav.find((button) => button.textContent?.includes("同步"))?.disabled).toBe(false);
    expect(nav.find((button) => button.textContent?.includes("素材"))?.disabled).toBe(false);
    expect(nav.find((button) => button.textContent?.includes("场记"))?.disabled).toBe(true);
    expect(nav.find((button) => button.textContent?.includes("剧本"))?.disabled).toBe(true);
    expect(nav.find((button) => button.textContent?.includes("审阅"))?.disabled).toBe(true);
  });

  it("keeps the sync verification entry name when the master is ready", () => {
    const markup = renderToStaticMarkup(createElement(ProjectModuleNavigation, {
      inputKind: "media-directory",
      selected: "sync-inspect",
      syncReady: true,
      syncPhase: "completed",
      onNavigate: () => {},
    }));
    const root = document.createElement("div");
    root.innerHTML = markup;
    expect(root.querySelector("button.project-module-link")?.getAttribute("aria-label")).toBe("同步核对");
  });

  it("maps secondary pages to their unified workbench active state", () => {
    const markup = renderToStaticMarkup(createElement(ProjectModuleNavigation, {
      inputKind: "media-directory",
      selected: "timeline",
      syncReady: true,
      syncPhase: "completed",
      onNavigate: () => {},
    }));
    const root = document.createElement("div");
    root.innerHTML = markup;
    expect(root.querySelectorAll("button.project-module-link")).toHaveLength(5);
    expect(root.querySelector('[aria-current="page"]')?.textContent).toContain("审阅");
    expect(root.querySelector(".project-module-overflow")).toBeNull();
  });

  it("clears workbench highlights when non-production system surfaces are active", () => {
    const markup = renderToStaticMarkup(createElement(ProjectModuleNavigation, {
      inputKind: "media-directory",
      selected: null,
      syncReady: true,
      syncPhase: "completed",
      onNavigate: () => {},
    }));
    const root = document.createElement("div");
    root.innerHTML = markup;
    expect(root.querySelectorAll("button.project-module-link")).toHaveLength(5);
    expect(root.querySelector('[aria-current="page"]')).toBeNull();
    expect(root.querySelector(".is-active")).toBeNull();
  });
});
