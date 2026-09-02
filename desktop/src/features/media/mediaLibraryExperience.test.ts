import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("media library experience contract", () => {
  it("plays indexed media from its opaque clip identity through the active Host", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const api = source("../../api/mediaRoles.ts");
    expect(api).toContain("clip_id?: string");
    expect(api).toContain("Opaque material_index clip identity. Never a device path.");
    expect(workbench).toContain("function playbackForItem(");
    expect(workbench).toContain("const indexedClipId = item.clip_id?.trim()");
    expect(workbench).toContain("host.mediaUrl(projectId, indexedClipId)");
    expect(workbench).toContain("reviewFallback");
    expect(workbench).not.toContain("file://");
    expect(workbench).not.toContain("media_path");
  });

  it("keeps Review optional instead of requiring a Take before playback", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("host.reviewModel(projectId).catch(() => null)");
    expect(workbench).toContain("Inventory is the playback authority");
    expect(workbench).toContain("Review is only a compatibility");
    expect(workbench).toContain("playbackForItem(host, projectId, item, playbackByMedia[item.media_id])");
  });

  it("keeps inspector playback explicit while thumbnail hover preview remains best-effort", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("controls");
    expect(workbench).toContain('preload="metadata"');
    expect(workbench).toContain("playsInline");
    expect(workbench).not.toContain("autoPlay");
    expect(workbench).toContain("onMouseEnter");
    expect(workbench).toContain("onMouseLeave");
    expect(workbench).toContain("event.currentTarget.pause()");
    expect(workbench).toContain("这条原片当前无法在 App 内播放");
    expect(workbench).toContain("这条素材尚未进入项目索引");
    expect(workbench).toContain("已入索引，但缺少可播放的 clip identity");
  });

  it("presents camera as a separate axis from source role", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("media-library-camera-strip");
    expect(workbench).toContain("media-role-camera-editor");
    expect(workbench).toContain("素材角色与同步");
    expect(workbench).toContain("独立于机位");
    expect(workbench).toContain("camera_override");
    expect(workbench).toContain("inferred_camera");
  });

  it("supports list and thumbnail density without replacing the selection Inspector", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const styles = source("./media-library.css");
    expect(workbench).toContain('type ViewMode = "list" | "grid"');
    expect(workbench).toContain('aria-label="素材显示密度"');
    expect(workbench).toContain(">列表</button>");
    expect(workbench).toContain(">缩略图</button>");
    expect(workbench).toContain("media-library-thumb");
    expect(workbench).toContain('aria-label="当前素材 Inspector"');
    expect(styles).toContain(".media-library-list.is-list");
    expect(styles).toContain(".media-library-list.is-grid");
    expect(styles).toContain("grid-template-rows: minmax(250px, .75fr) minmax(420px, 1.25fr)");
    expect(styles).toContain("display: flex !important");
  });

  it("keeps the media browser on the shared typography and theme authority", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const styles = source("./media-library.css");
    expect(workbench).not.toContain("media-library-experience.css");
    expect(styles).toContain("var(--mo-");
    expect(styles).not.toContain("prefers-color-scheme");
    expect(styles).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });
});
