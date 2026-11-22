// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import { ProductionClient, type SlateBoard } from "../../api/production";
import { ScriptWorkspace } from "./ScriptWorkspace";

vi.mock("../material-script/ScriptEpisodeView", () => ({
  ScriptEpisodeView: () => <div data-testid="script-episode-view" />,
  dragGroupId: () => null,
  scriptDomId: (segmentId: string) => `script-block-${segmentId}`,
}));
vi.mock("../material-script/TakeInspector", () => ({ TakeInspector: () => null }));
vi.mock("./ScriptAssignmentDecision", () => ({ ScriptAssignmentDecision: () => null }));

let snapshotModel: ReviewModelPayload;
vi.mock("../material-script/useReviewModelSnapshot", () => ({
  useReviewModelSnapshot: () => ({
    connection: {},
    loadState: "ready",
    message: "1 Take · 1 集",
    model: snapshotModel,
    refresh: vi.fn(async () => snapshotModel),
  }),
  reviewModelErrorMessage: (error: unknown) => String(error),
  reviewWriteNeedsRefresh: () => false,
}));

const project = { project_id: "project-1", name: "测试项目", input_kind: "workspace" };
const board: SlateBoard = {
  version: 2,
  contract: "script_supervisor.v2",
  revision: 4,
  updated_at: "",
  entries: {},
  semantics: {},
  records: {
    "slate-1": {
      record_id: "slate-1",
      source_group_id: "take-1",
      script_scene_id: "scene-1",
      episode: 1,
      scene: "1-1",
      shot: "2",
      take_number: 1,
      status: "partial",
      note: "结尾有遮挡",
      preferred_clip_id: "clip-1",
      attachments: [{
        clip_id: "clip-1",
        media_id: "media-1",
        camera: "A",
        display_name: "A.mp4",
        shot_type: "medium",
        source_role: "sync_camera",
        note: "",
      }],
      actor: "场记",
      updated_at: "",
    },
  },
};

function model(): ReviewModelPayload {
  return {
    contract_version: "review.v2",
    project: { project_id: "project-1", name: "测试项目", input_kind: "workspace", stats: {}, local_media: {}, issues: [] },
    revisions: { analysis: "", automation_analysis: "", automation_updated_at: "", review: 1 },
    capabilities: {},
    summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
    episodes: [{ episode: 1, scenes: [{
      scene_id: "scene-1",
      heading: "1-1",
      take_group_ids: ["take-1"],
      script_blocks: [{ segment_id: "segment-1", episode: 1, scene_id: "scene-1", order: 1, type: "dialogue", speaker: "甲", text: "你好", raw_text: "你好", issues: [] }],
    }] }],
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
        name: "A机",
        source_start: 0,
        duration: 2,
        playback: { state: "verified", available: true, url: "http://synthetic.test/clip-1", source_start: 0 },
      }],
      transcript: { text: "你好", source: "test" },
      people: { faces: [], speakers: [] },
      candidates: [],
      context: { episode_ids: [1], script_segment_ids: ["segment-1"] },
      automatic_state: { episode_ids: [1], script_segment_ids: ["segment-1"] },
      editorial_state: {},
      effective_mapping: { episode_ids: [1], script_segment_ids: ["segment-1"] },
      issues: [],
    }],
    script_gaps: [],
    review_state: {},
  } as unknown as ReviewModelPayload;
}

describe("Script Slate linkage", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenSlate = vi.fn();

  beforeEach(async () => {
    snapshotModel = model();
    vi.spyOn(ProductionClient.prototype, "scriptSupervisor").mockResolvedValue(board);
    onOpenSlate.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <ScriptWorkspace
        baseUrl="http://synthetic.test"
        project={project}
        initialGroupId="take-1"
        initialClipId="clip-1"
        initialScriptSegmentId="segment-1"
        onOpenSlate={onOpenSlate}
      />,
    ));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("loads SlateBoard and exposes linked status, note, and jump action", async () => {
    expect(ProductionClient.prototype.scriptSupervisor).toHaveBeenCalledWith("project-1");
    expect(host.querySelector(".script-slate-linkage")).not.toBeNull();
    expect(host.textContent).toContain("场 1-1 · 镜 2 · 次 1");
    expect(host.textContent).toContain("部分可用");
    expect(host.textContent).toContain("结尾有遮挡");

    const open = [...host.querySelectorAll("button")].find((button) => button.textContent === "在场记中打开");
    expect(open).toBeTruthy();
    await act(async () => open?.click());
    expect(onOpenSlate).toHaveBeenCalledWith("take-1", "clip-1", "segment-1");
  });
});
