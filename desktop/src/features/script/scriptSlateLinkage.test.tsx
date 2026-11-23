// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import { DesktopClient } from "../../api/desktop";
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
    "slate-2": {
      record_id: "slate-2",
      source_group_id: "take-2",
      script_scene_id: "scene-1",
      episode: 1,
      scene: "1-1",
      shot: "3",
      take_number: 2,
      status: "usable",
      note: "待确认景别",
      preferred_clip_id: "clip-2",
      attachments: [{
        clip_id: "clip-2",
        media_id: "media-2",
        camera: "B",
        display_name: "B.mp4",
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
    summary: { automation: {}, script_gaps: 0, take_groups: 2, episodes: 1 },
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
    }, {
      group_id: "take-2",
      parent_group_id: "",
      kind: "take",
      take_index: 2,
      split_reason: "",
      start: 2,
      end: 4,
      duration: 2,
      cameras: ["B"],
      angles: [{
        clip_id: "clip-2",
        media_id: "media-2",
        camera: "B",
        name: "B.mp4",
        source_start: 0,
        duration: 2,
        playback: { state: "verified", available: true, url: "http://synthetic.test/clip-2", source_start: 0 },
      }],
      transcript: { text: "待归集对白", source: "test" },
      people: { faces: [], speakers: [] },
      candidates: [],
      context: { episode_ids: [1], script_segment_ids: [] },
      automatic_state: { episode_ids: [], script_segment_ids: [] },
      editorial_state: {},
      effective_mapping: { episode_ids: [], script_segment_ids: [] },
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

  it("keeps Script side-by-side and exposes an unmapped Slate-linked pool", async () => {
    expect(host.querySelector(".script-split-workbench")).not.toBeNull();
    expect(host.querySelector(".script-alignment-pane")).not.toBeNull();
    expect(host.querySelector(".workspace-context-backdrop")).toBeNull();
    const pool = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("待归集"));
    expect(pool).toBeTruthy();
    await act(async () => pool?.click());
    expect(host.querySelector(".script-pool-card")).not.toBeNull();
    expect(host.textContent).toContain("场 1-1 · 镜 3 · 次 2");
    expect(host.textContent).toContain("待确认景别");
    expect(host.textContent).toContain("B.mp4");
  });

  it("offers an explicit background transcribe and match action", async () => {
    const pendingModel = model();
    for (const take of pendingModel.take_groups) {
      take.effective_mapping.script_segment_ids = [];
      take.candidates = [];
    }
    snapshotModel = pendingModel;
    const prepare = vi.spyOn(DesktopClient.prototype, "prepareProject").mockResolvedValue({ task_id: "task-1", status: "queued" });
    await act(async () => root.render(
      <ScriptWorkspace baseUrl="http://synthetic.test" project={project} />,
    ));
    const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "自动转写并匹配剧本");
    expect(action).toBeTruthy();
    await act(async () => action?.click());
    expect(prepare).toHaveBeenCalledWith("project-1");
    expect(host.textContent).toContain("后台转写与匹配任务已提交");
  });

});
