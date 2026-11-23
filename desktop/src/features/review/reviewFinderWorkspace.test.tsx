// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import {
  readShowRoughCutPreference,
  saveShowRoughCutPreference,
} from "../../app/desktopPreferences";
import { ReviewWorkspace, scriptBlockBadge } from "./ReviewWorkspace";

const reviewMock = vi.hoisted(() => ({
  model: null as ReviewModelPayload | null,
}));

vi.mock("../material-script/useReviewModelSnapshot", () => ({
  useReviewModelSnapshot: () => ({
    connection: { mediaUrl: () => "" },
    loadState: reviewMock.model ? "ready" : "loading",
    message: "正在读取",
    model: reviewMock.model,
    refresh: vi.fn().mockResolvedValue(reviewMock.model),
  }),
}));

vi.mock("../../api/production", () => ({
  ProductionClient: class {
    scriptSupervisor = vi.fn().mockResolvedValue({
      version: 1,
      contract: "script_supervisor.v2",
      revision: 1,
      updated_at: "",
      records: {
        g2: {
          record_id: "s2",
          source_group_id: "g2",
          script_scene_id: "scene-2",
          episode: 2,
          scene: "12",
          shot: "3",
          take_number: 1,
          status: "usable",
          note: "夜戏临场改词",
          preferred_clip_id: "c2",
          attachments: [],
          actor: "",
          updated_at: "",
        },
      },
      entries: {},
      semantics: {},
    });
  },
}));

vi.mock("../material-script/TakeInspector", () => ({
  TakeInspector: (
    { afterPlayback, take, selectedClipId }: {
      afterPlayback?: ReactNode;
      take: ReviewTakeGroup | null;
      selectedClipId: string | null;
    },
  ) => (
    <div data-testid="take-inspector">
      {take ? `${take.group_id}:${selectedClipId}` : "empty"}
      {afterPlayback}
    </div>
  ),
}));

vi.mock(
  "./ReviewDecisionPanel",
  () => ({ ReviewDecisionPanel: () => <div data-testid="decision-panel" /> }),
);

function angle(clipId: string, name: string, camera: string) {
  return {
    clip_id: clipId,
    media_id: `m-${clipId}`,
    camera,
    name,
    timeline_start: 0,
    timeline_end: 10,
    duration: 10,
    source_start: 83,
    source_end: 93,
    playback: {
      url: "",
      source_start: 83,
      source_end: 93,
      state: "unknown" as const,
    },
  };
}

function take(
  groupId: string,
  text: string,
  clipId: string,
  name: string,
  segmentIds: string[],
  episodes: number[],
): ReviewTakeGroup {
  return {
    group_id: groupId,
    parent_group_id: groupId,
    kind: "take",
    take_index: Number(groupId.slice(1)),
    split_reason: "",
    start: 0,
    end: 10,
    duration: 10,
    cameras: ["A"],
    angles: [angle(clipId, name, "A")],
    transcript: { text, source: "asr" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: episodes, script_segment_ids: [] },
    automatic_state: {},
    editorial_state: {},
    effective_mapping: {
      source: segmentIds.length ? "automatic" : "none",
      mapping_status: segmentIds.length ? "mapped" : "none",
      script_segment_ids: segmentIds,
      episode_ids: episodes,
    },
    issues: [],
  };
}

function model(): ReviewModelPayload {
  return {
    contract_version: "review.v1",
    project: {
      project_id: "p1",
      name: "测试",
      input_kind: "media-directory",
      stats: {},
      local_media: {},
      issues: [],
    },
    revisions: {
      analysis: "a1",
      automation_analysis: "a1",
      automation_updated_at: "",
      review: 1,
    },
    capabilities: {},
    summary: { automation: {}, script_gaps: 0, take_groups: 2, episodes: 2 },
    episodes: [{
      episode: 1,
      scenes: [{
        scene_id: "scene-1",
        heading: "客厅·日",
        take_group_ids: ["g1"],
        script_blocks: [{
          segment_id: "seg-1",
          episode: 1,
          scene_id: "scene-1",
          order: 1,
          type: "dialogue",
          speaker: "小林",
          text: "你回来了",
          raw_text: "你回来了",
          issues: [],
        }],
      }],
    }, {
      episode: 2,
      scenes: [{
        scene_id: "scene-2",
        heading: "街道·夜",
        take_group_ids: ["g2"],
        script_blocks: [],
      }],
    }],
    take_groups: [
      take("g1", "你回来了", "c1", "A001C001.MOV", ["seg-1"], [1]),
      take("g2", "临场改词", "c2", "B002C003.MOV", [], [2]),
    ],
    script_gaps: [],
    review_state: {},
  };
}

describe("Review Finder workspace", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    reviewMock.model = model();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    await act(async () =>
      root.render(
        <ReviewWorkspace
          baseUrl="http://host.test"
          project={{
            project_id: "p1",
            name: "测试",
            input_kind: "media-directory",
          }}
        />,
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("labels action blocks and copies the master timeline timecode", async () => {
    expect(scriptBlockBadge({ type: "action", speaker: "", text: "△走向门", raw_text: "△走向门" } as ReviewScriptBlock)).toBe("动作");
    await act(async () =>
      (container.querySelector<HTMLButtonElement>(".review-master-timecode"))!.click()
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("00:00:00");
    expect(container.textContent).toContain("已复制时码");
  });

  it("uses sequential card numbers when take indexes repeat across scenes", async () => {
    const duplicateModel = model();
    duplicateModel.take_groups[1].take_index = 1;
    reviewMock.model = duplicateModel;
    await act(async () => root.render(
      <ReviewWorkspace
        baseUrl="http://host.test"
        project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }}
      />,
    ));
    expect(container.textContent).toContain("#1 · A001C001");
    expect(container.textContent).toContain("#2 · B002C003");
    expect(container.textContent).not.toContain("Take #1 · B002C003");
  });

  it("renders the three columns and filters Takes from the script outline", async () => {
    expect(container.querySelector(".review-script-rail")).toBeTruthy();
    expect(container.querySelector(".review-take-card-list")).toBeTruthy();
    expect(container.querySelector(".review-viewer-pane")).toBeTruthy();
    await act(async () =>
      [...container.querySelectorAll(".review-script-block")].find((item) =>
        item.textContent?.includes("你回来了")
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(container.querySelectorAll(".review-take-card")).toHaveLength(1);
    expect(container.textContent).toContain("Take #1");
    expect(container.textContent).not.toContain("B002C003.MOV");
  });

  it("searches spoken dialogue, filenames, and slate notes across episodes", async () => {
    const input = container.querySelector<HTMLInputElement>(
      ".review-search-input",
    )!;
    const setInputValue = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
        ?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setInputValue("临场改词");
    });
    expect(container.textContent).toContain("B002C003.MOV");
    expect(container.textContent).toContain("跨集搜索结果");
    await act(async () => {
      setInputValue("夜戏临场改词");
    });
    expect(container.textContent).toContain("B002C003.MOV");
  });

  it("copies the active angle filename and source timecode", async () => {
    await act(async () =>
      (container.querySelector<HTMLButtonElement>(
        ".review-cross-actions button",
      )!).click()
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "A001C001.MOV @ 00:01:23",
    );
    expect(container.textContent).toContain("已复制");
  });

  it("keeps rough cut hidden by default and exposes it after the preference is enabled", async () => {
    saveShowRoughCutPreference(false);
    expect(readShowRoughCutPreference()).toBe(false);
    expect(container.textContent).not.toContain("到时间线");
    saveShowRoughCutPreference(true);
    await act(async () =>
      root.render(
        <ReviewWorkspace
          baseUrl="http://host.test"
          project={{
            project_id: "p1",
            name: "测试",
            input_kind: "media-directory",
          }}
          showRoughCut
        />,
      )
    );
    expect(container.textContent).toContain("到时间线");
  });
});
