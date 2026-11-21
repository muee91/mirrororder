// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HostConnection } from "../../api/host";
import { MediaRoleClient } from "../../api/mediaRoles";
import { MediaLibraryWorkbench } from "./MediaLibraryWorkbench";

it("pages the list and grid from their initial limits and admits grid thumbnails as each load settles", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const items = Array.from({ length: 101 }, (_, i) => ({
    media_id: String(i), clip_id: String(i), display_name: `Clip ${i}`, state: "verified",
    folder_label: "", inferred_camera: "A", indexed: true, label: {},
  }));
  vi.spyOn(MediaRoleClient.prototype, "inventory").mockResolvedValue({
    contract: "", project_id: "paging", role_revision: 1, inventory_updated_at: "", scan_required: false,
    summary: { files: items.length, indexed: items.length, unindexed: 0, labeled: 0, auxiliary: 0 },
    items, semantics: {},
  });
  vi.spyOn(MediaRoleClient.prototype, "roles").mockResolvedValue({ contract: "", version: 1, revision: 1, updated_at: "", media: {} });
  const review = vi.spyOn(HostConnection.prototype, "reviewModel").mockRejectedValue(new Error("No Review fallback"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MediaLibraryWorkbench baseUrl="http://localhost:9017" projectId="paging" />));
    const list = container.querySelector<HTMLElement>(".media-library-list")!;
    const rows = () => list.querySelectorAll('[role="listitem"]');
    const gridToggle = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "缩略图")!;
    expect(rows()).toHaveLength(80);
    expect(list.querySelectorAll("video")).toHaveLength(0);
    expect(review).toHaveBeenCalledWith("paging");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新素材清单"]')!.click());
    expect(review).toHaveBeenLastCalledWith("paging", { force: true });
    Object.defineProperties(list, { clientHeight: { value: 400 }, scrollHeight: { value: 3000 } });
    list.scrollTop = 200;
    act(() => list.dispatchEvent(new Event("scroll")));
    expect(rows()).toHaveLength(80);
    list.scrollTop = 2540;
    act(() => list.dispatchEvent(new Event("scroll")));
    expect(rows()).toHaveLength(items.length);
    act(() => gridToggle.click());
    expect(rows()).toHaveLength(48);
    const videos = () => list.querySelectorAll("video");
    expect(videos()).toHaveLength(6);
    const first = videos()[0];
    Object.defineProperties(first, { duration: { value: 4 }, readyState: { value: 1 } });
    act(() => first.dispatchEvent(new Event("loadedmetadata")));
    expect(first.currentTime).toBe(0.04);
    expect(videos()).toHaveLength(6);
    act(() => first.dispatchEvent(new Event("loadeddata")));
    expect(videos()).toHaveLength(7);
    expect(videos()[0]).toBe(first);
    const more = () => Array.from(list.querySelectorAll("button")).find((button) => button.textContent?.startsWith("加载更多素材"));
    act(() => more()!.click());
    expect(rows()).toHaveLength(96);
    act(() => more()!.click());
    expect(rows()).toHaveLength(items.length);
    expect(more()).toBeUndefined();
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
