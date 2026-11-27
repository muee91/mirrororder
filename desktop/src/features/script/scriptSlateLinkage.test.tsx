// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import { writeCurrentOperator } from "../../components/CurrentOperatorControl";
import { ProjectTaskClient } from "../../api/tasks";
import { ProductionClient, type SlateBoard } from "../../api/production";
import { ScriptWorkspace } from "./ScriptWorkspace";

vi.mock("../material-script/ScriptEpisodeView", () => ({
  ScriptEpisodeView: () => <div data-testid="script-episode-view" />,
  dragGroupId: () => null,
  scriptDomId: (segmentId: string) => `script-block-${segmentId}`,
}));
vi.mock("../material-script/TakeInspector", () => ({ TakeInspector: () => null }));
vi.mock("./ScriptAssignmentDecision", () => ({ ScriptAssignmentDecision: () => null }));

const setGroupPlacement = vi.fn();
let snapshotModel: ReviewModelPayload;
vi.mock("../material-script/useReviewModelSnapshot", () => ({
  useReviewModelSnapshot: () => ({
    connection: { setGroupPlacement },
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
    setGroupPlacement.mockReset();
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
    localStorage.clear();
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

  it.each(["human", "automatic"])("opens the requested line and B camera, then adds the line while preserving only human placements (%s)", async (source) => {
    const fixture = model();
    const take = fixture.take_groups[0];
    take.angles.push({ ...take.angles[0], camera: "B", clip_id: "clip-b", media_id: "media-b", name: "B.mp4" });
    take.effective_mapping = { source, inherited: true, mapping_status: "confirmed", script_segment_ids: ["segment-1"], episode_ids: [1] };
    fixture.episodes.push({ episode: 2, scenes: [{ scene_id: "scene-2", heading: "2-1", take_group_ids: [], script_blocks: [
      { ...fixture.episodes[0].scenes[0].script_blocks[0], segment_id: "target", episode: 2, scene_id: "scene-2", text: "回来吧" },
    ] }] });
    snapshotModel = fixture;
    await act(async () => {
      writeCurrentOperator("审片人");
      root.render(<ScriptWorkspace key="handoff" baseUrl="http://synthetic.test" project={project}
        initialGroupId={take.group_id} initialClipId="clip-b" initialScriptSegmentId="target" />);
    });
    expect(setGroupPlacement).not.toHaveBeenCalled();
    const attach = [...host.querySelectorAll("button")].find((node) => node.textContent === "挂到当前段");
    expect(attach).toBeTruthy();
    await act(async () => attach!.click());
    expect(setGroupPlacement).toHaveBeenCalledWith("project-1", expect.objectContaining({
      groupId: take.group_id, actor: "审片人", sourceClipId: "clip-b", expectedRevision: 1,
      scriptSegmentIds: source === "human" ? ["segment-1", "target"] : ["target"],
      episodeIds: source === "human" ? [1, 2] : [2],
    }));
  });

  it.each(["human", "automatic"])("confirms only the chosen action and dialogue while retaining earlier human placements (%s)", async (source) => {
    const fixture = model();
    const scene = fixture.episodes[0].scenes[0];
    const first = scene.script_blocks[0];
    scene.script_blocks.push({ ...first, type: "action", segment_id: "pass", order: 2, speaker: "", text: "递过杯子", raw_text: "递过杯子" },
      { ...first, segment_id: "second-line", order: 3, text: "喝口水", raw_text: "喝口水" },
      { ...first, segment_id: "elsewhere", order: 4, text: "早点睡", raw_text: "早点睡" });
    const take = fixture.take_groups[0];
    take.effective_mapping = { source, inherited: false, episode_ids: [1], script_segment_ids: ["segment-1","second-line","elsewhere"], mapping_status: "confirmed" };
    snapshotModel = fixture;
    await act(async () => {
      writeCurrentOperator("剪辑");
      root.render(<ScriptWorkspace key="action" baseUrl="http://synthetic.test" project={project}
        initialGroupId={take.group_id} initialClipId="clip-1" initialScriptSegmentId="pass" />);
    });
    const panel = host.querySelector('[aria-label="动作与台词同拍"]')!;
    expect(panel.textContent).toContain("递过杯子");
    const select = panel.querySelector("select")!;
    await act(async () => { select.value = "second-line"; select.dispatchEvent(new Event("change", { bubbles:true })); });
    expect(setGroupPlacement).not.toHaveBeenCalled();
    await act(async () => panel.querySelector("button")!.click());
    expect(setGroupPlacement).toHaveBeenCalledWith("project-1", expect.objectContaining({
      groupId: take.group_id, sourceClipId: "clip-1", expectedRevision: 1, actor: "剪辑",
      scriptSegmentIds: source === "human" ? ["segment-1","second-line","elsewhere","pass"] : ["second-line","pass"],
    }));
  });

  it("offers an explicit background transcribe and match action", async () => {
    const pendingModel = model();
    for (const take of pendingModel.take_groups) {
      take.effective_mapping.script_segment_ids = [];
      take.candidates = [];
    }
    snapshotModel = pendingModel;
    const submit = vi.spyOn(ProjectTaskClient.prototype, "submit").mockResolvedValue({
      task_id: "task-1", status: "queued", type: "incremental_analyze", stage: "queued",
    });
    await act(async () => root.render(
      <ScriptWorkspace baseUrl="http://synthetic.test" project={project} />,
    ));
    const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "自动转写并匹配剧本");
    expect(action).toBeTruthy();
    await act(async () => action?.click());
    expect(submit).toHaveBeenCalledWith("project-1", {
      type: "incremental_analyze", targets: { visual_cross_check: true }, actor: "desktop-v2",
      idempotencyKey: expect.stringMatching(/^script-match:project-1:/),
    });
    expect(host.textContent).toContain("后台转写与匹配任务已提交");
  });

});
