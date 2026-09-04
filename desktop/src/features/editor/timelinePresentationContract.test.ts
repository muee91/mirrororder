import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor-first Timeline presentation", () => {
  it("demotes rough-cut rebuild chrome once a real Timeline exists", () => {
    const css = read("./timeline.css");

    expect(css).toContain(".timeline-workbench:has(.timeline-stage) .timeline-proposal");
    expect(css).toContain("border-block: 1px solid var(--mo-border-subtle");
    expect(css).toContain(".timeline-workbench:has(.timeline-stage) .timeline-proposal-heading .eyebrow { display: none; }");
    expect(css).toContain(".timeline-workbench:has(.timeline-stage) .timeline-proposal details { display: none; }");
  });

  it("keeps destructive rebuild as an explicit two-step action", () => {
    const authority = read("./useTimelineAuthorityActions.ts");
    const initialAssembly = read("./TimelineInitialAssembly.tsx");

    expect(authority).toContain("if (snapshot && !replaceProposalArmed)");
    expect(authority).toContain("再次点击确认才会执行");
    expect(initialAssembly).toContain("再次确认重建");
  });

  it("keeps unresolved multicam angle visibly pending instead of previewing the base source", () => {
    const inspector = read("./TimelineInspectorPanel.tsx");
    const monitors = read("./EditorMonitors.tsx");

    expect(inspector).toContain('value={selection.clip.selected_angle_source_id ?? ""}');
    expect(inspector).toContain('type: "multicam_switch"');
    expect(monitors).toContain("programAnglePending");
    expect(monitors).toContain("当前多机位片段机位待选；在右侧片段检查器明确选择 A/B/C 后预览。");
  });
});
