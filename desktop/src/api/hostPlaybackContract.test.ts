import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("desktop playback URL authority", () => {
  it("canonicalizes every review angle to the Host that returned the model", () => {
    const host = read("./host.ts");
    const reviewModel = host.slice(host.indexOf("async reviewModel"), host.indexOf("async setGroupPlacement"));
    expect(reviewModel).toContain("for (const take of payload.take_groups ?? [])");
    expect(reviewModel).toContain("for (const angle of take.angles ?? [])");
    expect(reviewModel).toContain("angle.playback.url = this.mediaUrl(project, angle.clip_id)");
    expect(reviewModel).not.toContain("defaultHostBaseUrl");
  });

  it("keeps Slate and media cards consuming the canonical review playback URL", () => {
    const slate = read("../features/slate/GoldenSlateWorkbench.tsx");
    const card = read("../features/media/MirrorOrderMediaCard.tsx");
    expect(slate).toContain("src={selectedAngle.playback.url}");
    expect(card).toContain("playbackUrl: angle.playback.url");
  });
});
