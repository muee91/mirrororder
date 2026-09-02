import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("MirrorOrder professional UI contracts", () => {
  it("treats A/B/C/AUX as stable first-class camera identities", () => {
    const camera = read("../features/media/cameraPresentation.ts");
    expect(camera).toContain('CameraTone = "a" | "b" | "c" | "aux" | "custom" | "unknown"');
    expect(camera).toContain('tone: "a", sortOrder: 10');
    expect(camera).toContain('tone: "b", sortOrder: 20');
    expect(camera).toContain('tone: "c", sortOrder: 30');
    expect(camera).toContain('tone: "aux", sortOrder: 40');
  });

  it("keeps slate camera columns in A/B/C/AUX semantic order", () => {
    const slate = read("../features/slate/GoldenSlateWorkbench.tsx");
    const a = slate.indexOf('mediaCell(draft, "A")');
    const b = slate.indexOf('mediaCell(draft, "B")');
    const c = slate.indexOf('mediaCell(draft, "C")');
    const aux = slate.indexOf('mediaCell(draft, "AUX")');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(aux).toBeGreaterThan(c);
  });

  it("keeps Take cards on stable A/B/C/AUX slots before custom cameras", () => {
    const takes = read("../features/material-script/VirtualTakeList.tsx");
    const a = takes.indexOf('{ tone: "a", label: "A机" }');
    const b = takes.indexOf('{ tone: "b", label: "B机" }');
    const c = takes.indexOf('{ tone: "c", label: "C机" }');
    const aux = takes.indexOf('{ tone: "aux", label: "AUX" }');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(aux).toBeGreaterThan(c);
    expect(takes).toContain('tone === "custom" || tone === "unknown"');
  });

  it("reserves media card state columns so selection does not move metadata", () => {
    const css = read("../features/media/mirrororder-media-card.css");
    expect(css).toContain("grid-template-columns: 76px minmax(0, 1fr) 20px");
    expect(css).toContain("grid-template-columns: 136px minmax(0, 1fr) 20px");
    expect(css).toContain(".mo-media-selected-slot");
    expect(css).not.toContain("border: 2px solid");
  });

  it("locks Take card identity, state, action and camera regions to explicit grids", () => {
    const css = read("../features/material-script/material-script.css");
    expect(css).toContain(".take-card-heading");
    expect(css).toContain("grid-template-columns: minmax(130px, 1fr) minmax(118px, auto) auto");
    expect(css).toContain(".take-card-state");
    expect(css).toContain(".take-camera-strip");
    expect(css).toContain("grid-auto-columns: 196px");
    expect(css).toContain(".take-issue-slot");
  });

  it("does not regress flagship production surfaces below the 10px typography floor", () => {
    for (const relative of [
      "../features/media/mirrororder-media-card.css",
      "../features/material-script/material-script.css",
      "../features/material-script/golden-material-script.css",
    ]) {
      expect(read(relative), relative).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    }
  });

  it("keeps camera identity categorical and separate from semantic status colors", () => {
    const css = read("../features/media/camera-presentation.css");
    expect(css).toContain('[data-camera-tone="aux"]');
    expect(css).toContain("--camera-rail:");
    expect(css).not.toContain("--mo-success");
    expect(css).not.toContain("--mo-danger");
  });

  it("uses independent status families instead of one universal badge", () => {
    const component = read("../components/StatusIndicators.tsx");
    const css = read("../components/status-indicators.css");
    expect(component).toContain("ConnectionIndicator");
    expect(component).toContain("TaskStatusIndicator");
    expect(component).toContain("SlateStatusIndicator");
    expect(component).toContain("MediaHealthIndicator");
    expect(component).toContain("ReviewDecisionIndicator");
    expect(css).toContain(".mo-connection-indicator");
    expect(css).toContain(".mo-task-status-indicator");
    expect(css).toContain(".mo-slate-status-indicator");
    expect(css).toContain(".mo-media-health-indicator");
    expect(css).toContain(".mo-review-decision-indicator");
  });
});
