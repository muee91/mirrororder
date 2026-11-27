// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import { ProductionClient, type SlateBoard } from "../../api/production";
import type { ProductionNavigationIntent } from "../production/productionNavigation";
import { ScriptWorkspace } from "./ScriptWorkspace";

vi.mock("../material-script/TakeInspector", () => ({ TakeInspector: () => <div data-testid="take-inspector" /> }));
vi.mock("./ScriptAssignmentDecision", () => ({ ScriptAssignmentDecision: () => null }));

let snapshotModel: ReviewModelPayload;
vi.mock("../material-script/useReviewModelSnapshot", () => ({
  useReviewModelSnapshot: () => ({
    connection: { setGroupPlacement: vi.fn(), clearGroupPlacement: vi.fn() },
    loadState: "ready",
    message: "1 Take · 2 集",
    model: snapshotModel,
    refresh: vi.fn(async () => snapshotModel),
  }),
  reviewModelErrorMessage: (error: unknown) => String(error),
  reviewWriteNeedsRefresh: () => false,
}));

const project = { project_id: "project-1", name: "测试项目", input_kind: "workspace" };
const emptyBoard: SlateBoard = {
  version: 2,
  contract: "script_supervisor.v2",
  revision: 1,
  updated_at: "",
  entries: {},
  semantics: {},
  records: {},
};

function makeModel(): ReviewModelPayload {
  return {
    contract_version: "review.v2",
    project: { project_id: "project-1", name: "测试项目", input_kind: "workspace", stats: {}, local_media: {}, issues: [] },
    revisions: { analysis: "", automation_analysis: "", automation_updated_at: "", review: 1 },
    capabilities: {},
    summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 2 },
    episodes: [
      {
        episode: 1,
        scenes: [{
          scene_id: "scene-1",
          heading: "1-1 仓库",
          take_group_ids: ["take-1"],
          script_blocks: [
            { segment_id: "seg-heading", episode: 1, scene_id: "scene-1", order: 1, type: "scene_heading", speaker: "", text: "内景 仓库", raw_text: "内景 仓库", issues: [] },
            { segment_id: "seg-1", episode: 1, scene_id: "scene-1", order: 2, type: "dialogue", speaker: "甲", text: "你好", raw_text: "甲：你好", issues: [] },
            { segment_id: "seg-2", episode: 1, scene_id: "scene-1", order: 3, type: "dialogue", speaker: "乙", text: "再见", raw_text: "乙：再见", issues: [] },
          ],
        }],
      },
      {
        episode: 2,
        scenes: [{
          scene_id: "scene-2",
          heading: "2-1 办公室",
          take_group_ids: [],
          script_blocks: [
            { segment_id: "seg-3", episode: 2, scene_id: "scene-2", order: 1, type: "dialogue", speaker: "甲", text: "第二集台词", raw_text: "甲：第二集台词", issues: [] },
          ],
        }],
      },
    ],
    take_groups: [{
      group_id: "take-1",
      parent_group_id: "",
      kind: "take",
      take_index: 1,
      split_reason: "",
      start: 0,
      end: 2,
      duration: 2,
      cameras: ["A"],
      angles: [{
        clip_id: "clip-1",
        media_id: "media-1",
        camera: "A",
        name: "A001C01.mp4",
        source_start: 0,
        duration: 2,
        playback: { state: "verified", available: true, url: "http://synthetic.test/clip-1", source_start: 0 },
      }],
      transcript: { text: "你好", source: "test" },
      people: { faces: [], speakers: [] },
      candidates: [],
      context: { episode_ids: [1], script_segment_ids: ["seg-1"] },
      automatic_state: { episode_ids: [1], script_segment_ids: ["seg-1"] },
      editorial_state: {},
      effective_mapping: { source: "human", episode_ids: [1], script_segment_ids: ["seg-1"] },
      issues: [],
    }],
    script_gaps: [],
    review_state: {},
  } as unknown as ReviewModelPayload;
}

function Harness({ intent }: { intent?: ProductionNavigationIntent | null }) {
  const [selection, setSelection] = useState<{
    groupId: string | null;
    clipId: string | null;
    scriptSegmentId: string | null;
  }>({
    groupId: "take-1",
    clipId: "clip-1",
    scriptSegmentId: "seg-1",
  });
  return (
    <ScriptWorkspace
      baseUrl="http://synthetic.test"
      project={project}
      initialGroupId={selection.groupId}
      initialClipId={selection.clipId}
      initialScriptSegmentId={selection.scriptSegmentId}
      focusIntent={intent ?? null}
      onSelectionChange={(groupId, clipId, scriptSegmentId) => setSelection({ groupId, clipId, scriptSegmentId })}
    />
  );
}

describe("ScriptWorkspace stability", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    snapshotModel = makeModel();
    vi.spyOn(ProductionClient.prototype, "scriptSupervisor").mockResolvedValue(emptyBoard);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("does not snap drawer tab, reopen collapsed drawer, or call scrollIntoView on direct block clicks", async () => {
    const scrollSpy = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollSpy;

    await act(async () => root.render(<Harness />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    scrollSpy.mockClear();

    // Switch right drawer to "当前段"
    const segTab = [...host.querySelectorAll(".script-alignment-tabs button")].find((b) => b.textContent?.includes("当前段")) as HTMLButtonElement;
    expect(segTab).toBeTruthy();
    await act(async () => segTab.click());
    expect(segTab.classList.contains("is-active")).toBe(true);

    // Click another script block: drawer must stay on "当前段" and not call scrollIntoView
    const seg2 = host.querySelector("#script-segment-seg-2") as HTMLElement;
    expect(seg2).toBeTruthy();
    await act(async () => seg2.click());
    expect(segTab.classList.contains("is-active")).toBe(true);
    expect(scrollSpy).not.toHaveBeenCalled();

    // Collapse drawer, then click seg-1: drawer must stay collapsed
    const collapseBtn = host.querySelector('.script-alignment-heading button[aria-label="收起剧本素材对齐"]') as HTMLButtonElement;
    await act(async () => collapseBtn.click());
    expect(host.querySelector(".script-alignment-pane.is-collapsed")).not.toBeNull();

    const seg1 = host.querySelector("#script-segment-seg-1") as HTMLElement;
    await act(async () => seg1.click());
    expect(host.querySelector(".script-alignment-pane.is-collapsed")).not.toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not oscillate when search matches only a non-placeable structural block", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const search = host.querySelector("input.script-search") as HTMLInputElement;
    expect(search).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "内景 仓库");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("#script-segment-seg-heading")).not.toBeNull();
  });

  it("applies external focusIntent deep-link and opens the target episode and drawer", async () => {
    const intent: ProductionNavigationIntent = {
      projectId: "project-1",
      workspace: "script",
      groupId: "take-1",
      clipId: "clip-1",
      scriptSegmentId: "seg-3",
      nonce: 42,
    };
    await act(async () => root.render(<Harness intent={intent} />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.querySelector("#script-segment-seg-3.is-selected")).not.toBeNull();
    expect(host.querySelector(".script-alignment-pane.is-collapsed")).toBeNull();
  });
});
