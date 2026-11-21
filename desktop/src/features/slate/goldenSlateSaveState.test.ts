import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Golden Slate save state feedback", () => {
  it("exposes a live save state beside the primary save action", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench).toContain('className="golden-slate-save-state"');
    expect(workbench).toContain('aria-live="polite"');
    expect(workbench).toContain('data-state={busy ? "saving" : dirtyCount ? "dirty" : board ? "saved" : "idle"}');
    expect(workbench).toContain('busy ? "保存中…" : draftConflicts.size ? `${draftConflicts.size} 条草稿需核对` : dirtyCount ? `未保存 ${dirtyCount}` : board ? "已保存" : "等待加载"');
  });

  it("keeps state colors readable in both dark and light themes", () => {
    const css = source("./golden-slate.css");
    expect(css).toContain('.golden-slate-save-state[data-state="dirty"]');
    expect(css).toContain('.golden-slate-save-state[data-state="saving"]');
    expect(css).toContain('.golden-slate-save-state[data-state="saved"]');
    expect(css).toContain(".golden-slate-save-state { color: #687580; }");
  });
});
