// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePayload } from "../../api/host";

vi.mock("./ProjectLifecyclePanel", () => ({ ProjectLifecyclePanel: () => null }));
vi.mock("../../app/projectTransferActions", () => ({ projectTransferAvailable: () => false, saveProjectCopy: vi.fn() }));

import { ProjectHome } from "./ProjectHome";

const callbacks = {
  onOpenProject: vi.fn(),
  onOpenTeamProject: vi.fn(),
  onCopyShareLink: vi.fn(),
  onRevealProject: vi.fn(),
  onMulticamSyncProject: vi.fn(),
  onPrepareProject: vi.fn(),
  onOpenMediaBinding: vi.fn(),
  onDeleteProject: vi.fn(),
  onWorkspaceChanged: vi.fn(async () => undefined),
};

function workspace(): WorkspacePayload {
  return {
    workspace_id: "workspace-1",
    workspace: "demo",
    api_version: "1",
    projects: [
      { project_id: "empty-fcpxml", name: "空工程", input_kind: "fcpxml", stats: { groups: 0, clips: 0 } },
      { project_id: "media-project", name: "素材工程", input_kind: "media-directory", stats: { groups: 0, clips: 0 } },
      { project_id: "ready-project", name: "已就绪", input_kind: "fcpxml", stats: { groups: 2, clips: 7 } },
    ],
  };
}

describe("Project Home card density", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces duplicate empty status and fake zero stats while preserving real counts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.append(container);
    try {
      await act(async () => root.render(<ProjectHome baseUrl="http://synthetic.test" workspace={workspace()} {...callbacks} />));
      const cards = [...container.querySelectorAll<HTMLElement>(".project-home-card")];
      const empty = cards[0];
      const media = cards[1];
      const ready = cards[2];
      expect(empty.querySelector(".project-home-state")?.textContent).toContain("待整理");
      expect(empty.querySelector(".project-home-project-copy small")?.textContent).toBe("点击打开工程");
      expect(empty.textContent).not.toContain("0 Take");
      expect(empty.textContent).not.toContain("0 素材");
      expect(media.querySelector(".project-home-project-copy small")?.textContent).toBe("点击查看同步与素材");
      expect(media.querySelector(".project-home-stats-hint")?.textContent).toBe("打开后查看进度与素材");
      expect(ready.textContent).toContain("2 Take");
      expect(ready.textContent).toContain("7 素材");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
