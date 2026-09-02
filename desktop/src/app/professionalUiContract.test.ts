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

  it("reserves media card state columns so selection does not move metadata", () => {
    const css = read("../features/media/mirrororder-media-card.css");
    expect(css).toContain("grid-template-columns: 76px minmax(0, 1fr) 20px");
    expect(css).toContain("grid-template-columns: 136px minmax(0, 1fr) 20px");
    expect(css).toContain(".mo-media-selected-slot");
    expect(css).not.toContain("border: 2px solid");
  });

  it("does not regress flagship media card copy below the 10px production floor", () => {
    const css = read("../features/media/mirrororder-media-card.css");
    expect(css).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });

  it("keeps camera identity categorical and separate from semantic status colors", () => {
    const css = read("../features/media/camera-presentation.css");
    expect(css).toContain('[data-camera-tone="aux"]');
    expect(css).toContain("--camera-rail:");
    expect(css).not.toContain("--mo-success");
    expect(css).not.toContain("--mo-danger");
  });
});
