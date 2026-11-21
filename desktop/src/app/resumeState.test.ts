import { describe, expect, it } from "vitest";
import {
  forgetWorkspaceResume,
  loadAppResume,
  loadRecentWorkspaces,
  readProjectPage,
  rememberProject,
  rememberProjectPage,
  rememberWorkspace,
} from "./resumeState";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("production resume state", () => {
  it("remembers only a successfully opened workspace and its project", () => {
    const storage = new MemoryStorage();
    expect(loadAppResume(storage)).toEqual({ workspacePath: "", projectId: "" });
    rememberProject("project-before-workspace", storage);
    expect(loadAppResume(storage)).toEqual({ workspacePath: "", projectId: "" });
    rememberWorkspace(" /Volumes/Drama/MirrorOrder ", storage);
    rememberProject(" drama-01 ", storage);
    expect(loadAppResume(storage)).toEqual({ workspacePath: "/Volumes/Drama/MirrorOrder", projectId: "drama-01" });
  });

  it("clears the remembered project when the workspace changes", () => {
    const storage = new MemoryStorage();
    rememberWorkspace("/workspace/a", storage);
    rememberProject("project-a", storage);
    rememberWorkspace("/workspace/b", storage);
    expect(loadAppResume(storage)).toEqual({ workspacePath: "/workspace/b", projectId: "" });
  });

  it("reuses the last successful history and coalesces the workspace directory and manifest", () => {
    const storage = new MemoryStorage();
    storage.setItem("mirrororder.desktop.resume", JSON.stringify({ workspacePath: "/制作盘/短剧/workspace.toml", projectId: "a" }));
    expect(loadRecentWorkspaces(storage)).toEqual(["/制作盘/短剧/workspace.toml"]);
    rememberWorkspace("/另一盘/项目", storage);
    expect(loadRecentWorkspaces(storage)).toEqual(["/另一盘/项目", "/制作盘/短剧/workspace.toml"]);
    rememberWorkspace("/制作盘/短剧", storage);
    expect(loadRecentWorkspaces(storage)).toEqual(["/制作盘/短剧", "/另一盘/项目"]);
  });

  it("defaults to the script-supervisor canvas and migrates legacy editor pages", () => {
    const storage = new MemoryStorage();
    expect(readProjectPage("project-a", storage)).toBe("slate");
    rememberProjectPage("project-a", "rough-cut", storage);
    expect(readProjectPage("project-a", storage)).toBe("timeline");
    rememberProjectPage("project-a", "assembly", storage);
    expect(readProjectPage("project-a", storage)).toBe("timeline");
  });

  it("persists the three new raw-media production pages independently", () => {
    const storage = new MemoryStorage();
    for (const page of ["sync-task", "sync-inspect", "sync-delivery"] as const) {
      rememberProjectPage("raw-series", page, storage);
      expect(readProjectPage("raw-series", storage)).toBe(page);
    }
  });

  it("remembers the device-local media binding canvas as a production page", () => {
    const storage = new MemoryStorage();
    rememberProjectPage("project-a", "media-binding", storage);
    expect(readProjectPage("project-a", storage)).toBe("media-binding");
  });

  it("fails closed to the script-supervisor canvas for stale or invalid page values", () => {
    const storage = new MemoryStorage();
    storage.setItem("mirrororder.desktop.project-page.project-a", "settings");
    expect(readProjectPage("project-a", storage)).toBe("slate");
  });

  it("can forget automatic workspace resume without deleting project canvas history", () => {
    const storage = new MemoryStorage();
    rememberWorkspace("/workspace/a", storage);
    rememberProject("project-a", storage);
    rememberProjectPage("project-a", "timeline", storage);
    forgetWorkspaceResume(storage);
    expect(loadAppResume(storage)).toEqual({ workspacePath: "", projectId: "" });
    expect(readProjectPage("project-a", storage)).toBe("timeline");
  });
});
