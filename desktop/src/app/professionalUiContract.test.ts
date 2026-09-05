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
    expect(camera).toContain('tone: "a", label: "A机", sortOrder: 10');
    expect(camera).toContain('tone: "b", label: "B机", sortOrder: 20');
    expect(camera).toContain('tone: "c", label: "C机", sortOrder: 30');
    expect(camera).toContain('tone: "aux", label: "AUX", sortOrder: 40');
  });

  it("keeps slate camera columns in A/B/C/AUX semantic order", () => {
    const slateRow = read("../features/slate/SlateRow.tsx");
    expect(slateRow).toContain('export const SLATE_CAMERA_COLUMNS = ["A", "B", "C", "AUX"] as const');
    const a = slateRow.indexOf('"camera-A"');
    const b = slateRow.indexOf('"camera-B"');
    const c = slateRow.indexOf('"camera-C"');
    const aux = slateRow.indexOf('"camera-AUX"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(aux).toBeGreaterThan(c);
    expect(slateRow).toContain('SLATE_CAMERA_COLUMNS.map((camera) => <td className="col-media" key={camera}>{renderMedia(camera)}</td>)');
  });

  it("keeps Take cards on the shared A/B/C/AUX contract before custom cameras", () => {
    const camera = read("../features/media/cameraPresentation.ts");
    const takeCard = read("../features/material-script/TakeCard.tsx");
    const a = camera.indexOf('{ tone: "a", label: "A机", sortOrder: 10 }');
    const b = camera.indexOf('{ tone: "b", label: "B机", sortOrder: 20 }');
    const c = camera.indexOf('{ tone: "c", label: "C机", sortOrder: 30 }');
    const aux = camera.indexOf('{ tone: "aux", label: "AUX", sortOrder: 40 }');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(aux).toBeGreaterThan(c);
    expect(takeCard).toContain("STABLE_CAMERA_SLOTS.map");
    expect(takeCard).toContain('tone === "custom" || tone === "unknown"');
  });

  it("reserves media card state columns so selection does not move metadata", () => {
    const css = read("../features/media/mirrororder-media-card.css");
    expect(css).toContain("grid-template-columns: 70px minmax(0, 1fr) 20px");
    expect(css).toContain("grid-template-columns: 136px minmax(0, 1fr) 20px");
    expect(css).toContain(".mo-media-selected-slot");
    expect(css).not.toContain("border: 2px solid");
  });

  it("keeps the compact MediaCard inside the fixed Slate camera column", () => {
    const media = read("../features/media/mirrororder-media-card.css");
    const slate = read("../features/slate/golden-slate.css");
    expect(media).toContain(".mo-media-card.is-compact { width: 180px; height: 88px; }");
    expect(media).toContain(".mo-media-card.is-inspector { width: min(300px, 100%); height: 124px; }");
    expect(slate).toContain(".golden-slate-table .col-media { width: 188px; }");
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

  it("does not regress core production surfaces below the 10px typography floor", () => {
    for (const relative of [
      "../features/media/mirrororder-media-card.css",
      "../features/media/media-library.css",
      "../features/material-script/material-script.css",
      "../features/production/production-workspaces.css",
      "../features/material-script/take-card.css",
      "../features/production/production.css",
      "../features/planning/planning.css",
      "../features/editor/timeline.css",
      "../features/status/status-center.css",
    ]) {
      expect(read(relative), relative).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    }
  });

  it("keeps flagship surfaces on the resolved Desktop theme instead of raw OS media queries", () => {
    for (const relative of [
      "../features/media/mirrororder-media-card.css",
      "../features/media/media-library.css",
      "../features/production/production-workspaces.css",
      "../features/production/production.css",
      "../features/planning/planning.css",
      "../features/editor/timeline.css",
      "../features/status/status-center.css",
    ]) {
      expect(read(relative), relative).not.toContain("prefers-color-scheme");
    }
  });

  it("keeps keyboard focus explicit on production controls", () => {
    for (const relative of [
      "../features/media/mirrororder-media-card.css",
      "../features/media/media-library.css",
      "../features/production/production.css",
      "../features/planning/planning.css",
      "../features/editor/timeline.css",
      "../features/status/status-center.css",
    ]) {
      const css = read(relative);
      expect(css, relative).toContain(":focus-visible");
      expect(css, relative).not.toContain("outline: none");
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
