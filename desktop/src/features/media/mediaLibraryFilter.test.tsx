// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HostConnection } from "../../api/host";
import { MediaRoleClient } from "../../api/mediaRoles";
import { MediaLibraryWorkbench } from "./MediaLibraryWorkbench";

it("changes the active status filter and hides empty secondary filter pills", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const item = {
    media_id: "aux-1",
    clip_id: "clip-1",
    display_name: "B-roll.mov",
    folder_label: "素材",
    inferred_camera: "?",
    indexed: true,
    state: "verified",
    label: {},
  };
  const inventory = vi.spyOn(MediaRoleClient.prototype, "inventory").mockResolvedValue({
    contract: "media-inventory.v1",
    project_id: "filtering",
    role_revision: 1,
    inventory_updated_at: "",
    scan_required: false,
    summary: { files: 1, indexed: 1, unindexed: 0, labeled: 1, auxiliary: 1 },
    items: [item],
    semantics: {},
  });
  const roles = vi.spyOn(MediaRoleClient.prototype, "roles").mockResolvedValue({
    version: 1,
    contract: "media-roles.v1",
    revision: 1,
    updated_at: "",
    media: { "aux-1": { source_role: "aerial" } },
  });
  const review = vi.spyOn(HostConnection.prototype, "reviewModel").mockRejectedValue(new Error("Review unavailable"));
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => root.render(<MediaLibraryWorkbench baseUrl="http://synthetic.test" projectId="filtering" />));
    expect(inventory).toHaveBeenCalledWith("filtering");
    expect(roles).toHaveBeenCalledWith("filtering");
    expect(review).toHaveBeenCalledWith("filtering");
    const filters = () => [...container.querySelectorAll<HTMLButtonElement>(".media-library-filters button")];
    expect(filters().map((button) => button.getAttribute("aria-label"))).toEqual([
      "按状态筛选：全部",
      "按状态筛选：辅助素材",
      "按状态筛选：已标记",
    ]);
    const row = container.querySelector<HTMLButtonElement>(".media-library-row")!;
    expect(row.dataset.cameraTone).toBe("unknown");
    await act(async () => row.click());
    expect(container.querySelector<HTMLDetailsElement>(".media-role-advanced-fields")?.open).toBe(false);
    const auxiliary = container.querySelector<HTMLButtonElement>('[aria-label="按状态筛选：辅助素材"]')!;
    await act(async () => auxiliary.click());
    expect(auxiliary.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
