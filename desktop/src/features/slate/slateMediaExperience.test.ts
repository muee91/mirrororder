import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("golden slate media experience", () => {
  it("lets Escape dismiss the take picker even while search has focus", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench).toContain('event.key === "Escape" && takePickerOpen');
    expect(workbench).toContain("setTakePickerOpen(false)");
    expect(workbench).toContain('setTakeSearch("")');
    expect(workbench).toContain("[takePickerOpen]");
  });

  it("uses the shared camera presentation for take evidence instead of raw camera text", () => {
    const takeCard = source("../material-script/TakeCard.tsx");
    expect(takeCard).toContain('import { cameraPresentation, STABLE_CAMERA_SLOTS, type CameraTone } from "../media/cameraPresentation"');
    expect(takeCard).toContain("takeCameraSlots");
    expect(takeCard).toContain("data-camera-tone={slot.tone}");
    expect(takeCard).toContain('cameraPresentation(angle.camera || "")');
  });

  it("recovers from a playback error without forcing a project refresh", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench).toContain("const [playbackRetry, setPlaybackRetry] = useState(0)");
    expect(workbench).toContain('key={`${selectedAngle.clip_id}-${playbackRetry}`}');
    expect(workbench).toContain("golden-player-error");
    expect(workbench).toContain("重新加载");
    expect(workbench).toContain('setPlaybackFailedClipId("")');
    expect(workbench).toContain("setPlaybackRetry((value) => value + 1)");
  });

  it("clears stale playback failure when the user changes angle", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench).toContain("function selectClip(clipId: string)");
    expect(workbench).toContain("setSelectedClipId(clipId)");
    expect(workbench).toContain('setPlaybackFailedClipId("")');
    expect(workbench).toContain("onSelect={selectClip}");
  });
});
