import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("production navigation context", () => {
  it("keeps typed selection intent separate from business truth", () => {
    const navigation = read("./productionNavigation.ts");
    const workbench = read("./ProjectWorkbench.tsx");

    expect(navigation).toContain("export interface ProductionSelectionContext");
    expect(navigation).toContain("export interface ProductionNavigationIntent extends ProductionSelectionContext");
    expect(navigation).toContain('export type ProductionWorkspace = "material" | "script" | "timeline" | "review"');
    expect(navigation).toContain("scriptSegmentId?: string");
    expect(navigation).toContain("timelineClipId?: string");
    expect(workbench).toContain("const [selection, setSelection] = useState<ProductionSelectionContext>");
    expect(workbench).toContain("setNavigationIntent(nextIntent(next));");
    expect(workbench).not.toContain("ReviewReturnContext");
    expect(workbench).not.toContain("reviewReturn");
  });

  it("propagates current Take/clip selection through all four workspaces", () => {
    const workbench = read("./ProjectWorkbench.tsx");
    const material = read("../material/MaterialTakeView.tsx");
    const script = read("../script/ScriptWorkspace.tsx");
    const review = read("../review/ReviewWorkspace.tsx");
    const timeline = read("../editor/TimelineWorkbench.tsx");

    expect(workbench).toContain("initialClipId={currentSelection.clipId ?? null}");
    expect(workbench).toContain("initialScriptSegmentId={currentSelection.scriptSegmentId ?? null}");
    expect(material).toContain("onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId)");
    expect(script).toContain("onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId, selectedScriptSegmentId)");
    expect(review).toContain("onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId)");
    expect(timeline).toContain("onSelectionChange?.(groupId, clipId, timelineClipId)");
    expect(script).toContain(">在素材中打开</button>");
    expect(script).toContain(">在审阅中打开</button>");
    expect(script).toContain(">到时间线</button>");
  });
});
