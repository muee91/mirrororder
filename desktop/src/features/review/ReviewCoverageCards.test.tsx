// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../tests/fixtures/desktop-review/review-model.json";
import type { ReviewCandidate, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { SpeechEvidenceClient } from "../../api/speechEvidence";
import type { SlateRecord } from "../../api/production";
import { indexReviewSlates } from "./reviewFootageFacts";
import { ReviewCoverageCards, type ReviewCoverageCardsProps } from "./ReviewCoverageCards";
import { buildScriptTakeProjection } from "../material-script/model";

const base: ReviewTakeGroup = fixture.take_groups[0];
const line: ReviewScriptBlock = {
  segment_id: "line", type: "dialogue", scene_id: "room", episode: 1, order: 1,
  speaker: "江遥", text: "先把灯打开。", raw_text: "江遥：先把灯打开。", issues: [],
};
const candidate: ReviewCandidate = {
  candidate_id: "candidate", group_id: base.group_id, script_segment_id: line.segment_id,
  script_segment_ids: [], episode_ids: [1], confidence: "medium", total_score: 1,
  dialogue_score: 1, sequence_score: 0, context_score: 0, margin: 0, method: "speech",
  transcript_text: "", evidence: [], context_episodes: [],
};
const mapped: ReviewTakeGroup = {
  ...base, effective_mapping: { ...base.effective_mapping, source: "human", script_segment_ids: [line.segment_id] },
  transcript: { text: "别急，我们先开灯。", source: "asr" },
  angles: ["A", "B", "C"].map(camera => ({ ...base.angles[0], camera, clip_id: camera, name: camera + ".MOV" })),
};

describe("script and camera coverage cards", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: ReviewCoverageCardsProps;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      takes: [mapped], blocksById: new Map([[line.segment_id, line]]), selectedGroupId: mapped.group_id,
      connection: { mediaUrl: (_project, clip) => "/media/" + clip }, projectId: "project",
      takeLabel: take => "第 " + take.take_index + " 条", onWatch: vi.fn(), onCompare: vi.fn(),
      onChooseBlock: vi.fn(), onOpenScript: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(overrides: Partial<ReviewCoverageCardsProps> = {}) {
    act(() => root.render(<ReviewCoverageCards {...props} {...overrides} />));
  }

  it("shows the field record and its reason beside the correct angle and links to the original record", () => {
    const record: SlateRecord = { record_id: "only-B", source_group_id: "", status: "ng", note: "反光入镜",
      episode: 1, scene: "1", shot: "", script_scene_id: "", take_number: null, actor: "场记", updated_at: "", preferred_clip_id: "",
      attachments: [{ clip_id: "B", media_id: mapped.angles[1].media_id, camera: "B", display_name: "B.MOV", shot_type: "unknown", source_role: "", note: "" }] };
    const { facts } = indexReviewSlates([mapped], { version: 2, contract: "script_supervisor.v2", revision: 1,
      updated_at: "", records: { "only-B": record }, entries: {}, semantics: {} });
    const onOpenSlate = vi.fn();
    render({ slateFacts: facts, onOpenSlate });
    expect(container.querySelector(".review-coverage-card-head")?.textContent).toContain("场记按机位标记");
    expect(container.querySelector(".review-coverage-card-head")?.textContent).not.toContain("场记 NG");
    const cameras = container.querySelectorAll(".review-coverage-camera");
    expect(cameras[1].textContent).toContain("场记 NG");
    expect(cameras[1].textContent).toContain("反光入镜");
    expect(cameras[0].textContent).not.toContain("反光入镜");
    act(() => container.querySelector<HTMLButtonElement>(".review-open-slate")!.click());
    expect(onOpenSlate).toHaveBeenCalledWith(mapped.group_id, "B", "only-B");
  });

  it("only calls a shared Take confirmed when both the action and the dialogue have a direct human placement", () => {
    const action = { ...line, segment_id: "lift", type: "action", speaker: "", text: "她拿起杯子。", raw_text: "她拿起杯子。" };
    const copies = ["auto", "action-only", "confirmed"].map(group_id => ({ ...mapped, group_id, candidates: [candidate], effective_mapping: {
      ...mapped.effective_mapping, source: group_id === "auto" ? "automatic" : "human",
      script_segment_ids: group_id === "action-only" ? ["lift"] : ["line", "lift"],
    } }));
    const projection = buildScriptTakeProjection({ take_groups: copies, episodes: [
      { episode: 1, scenes: [{ scene_id: line.scene_id, heading: "房间", take_group_ids: [], script_blocks: [line, action] }] },
    ] });
    render({ takes: copies, activeBlock: action, blocksById: new Map([[line.segment_id, line],[action.segment_id, action]]), projection });
    expect([...container.querySelectorAll(".review-coverage-relation")].map(node => node.textContent))
      .toEqual(["自动归属 · 动作待核", "人工归属", "已确认同拍"]);
    expect([...container.querySelectorAll(".review-coverage-text-head button")].map(node => node.textContent))
      .toEqual(["去确认同拍","去确认同拍","打开剧本"]);
  });

  it("keeps the written line, whole-take speech, and camera-specific evidence distinct", () => {
    render({ angleEvidence: (_take, angle) => angle.camera === "B" ? { text: "B机录到的原话", sourceStart: 1 } : undefined });
    expect(container.querySelector('[aria-label="剧本原句"] p')?.textContent).toBe("江遥：先把灯打开。");
    expect(container.querySelector('[aria-label="现场对白摘录"] p')?.textContent).toBe("别急，我们先开灯。");
    expect(container.querySelectorAll(".review-coverage-angle-speech")).toHaveLength(1);
    expect(container.querySelector('[aria-label="B机现场转写"]')?.textContent).toContain("B机录到的原话");
    const camera = container.querySelector<HTMLButtonElement>('button[aria-label="查看B机 · B.MOV"]')!;
    const compare = container.querySelector<HTMLButtonElement>(".review-coverage-compare")!;
    const [choose, open] = container.querySelectorAll<HTMLButtonElement>('.review-coverage-text-head button');
    act(() => { camera.click(); compare.click(); choose.click(); open.click(); });
    expect(props.onWatch).toHaveBeenCalledWith(mapped, "B", 1);
    expect(props.onCompare).toHaveBeenCalledWith(mapped);
    expect(props.onChooseBlock).toHaveBeenCalledWith(line);
    expect(props.onOpenScript).toHaveBeenCalledWith(mapped, line.segment_id);
    expect(container.querySelector("video[controls]")).toBeNull();
  });

  it("sizes each camera from its own display metadata and forgets a replaced source", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const take = { ...mapped, angles: mapped.angles.map(angle => ({ ...angle })) };
    render({ takes: [take] });
    const cards = () => [...container.querySelectorAll<HTMLElement>(".review-coverage-camera")];
    const ratios = () => cards().map(card => Number(card.style.getPropertyValue("--review-camera-aspect")));
    const specs = [[360, 640], [320, 320], [640, 360]];
    act(() => {
      cards().forEach((card, index) => {
        const video = card.querySelector("video")!;
        Object.defineProperty(video, "videoWidth", { value: specs[index][0] });
        Object.defineProperty(video, "videoHeight", { value: specs[index][1] });
        video.dispatchEvent(new Event("resize"));
      });
    });
    expect(ratios()).toEqual([9 / 16, 1, 16 / 9]);
    expect(cards()[0].dataset.frame).toBe("portrait");

    render({ takes: [] });
    const refreshed = { ...take, angles: take.angles.map(angle => ({ ...angle })) };
    render({ takes: [refreshed] });
    expect(ratios()).toEqual([9 / 16, 1, 16 / 9]);
    const replaced = { ...refreshed, angles: refreshed.angles.map((angle, index) =>
      index === 0 ? { ...angle, media_id: "different-source" } : angle) };
    render({ takes: [replaced] });
    expect(cards()[0].dataset.frame).toBe("pending");
    expect(ratios()).toEqual([1, 1, 16 / 9]);
    render({ projectId: "other-project", takes: [{ ...take, angles: take.angles.map(angle => ({ ...angle })) }] });
    expect(cards().map(card => card.dataset.frame)).toEqual(["pending", "pending", "pending"]);
  });

  it("explains a preview failure while keeping its verified original available to open", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const take = { ...mapped, angles: mapped.angles.map(angle => ({
      ...angle, playback: { ...angle.playback, state: "verified" as const, available: true },
    })) };
    render({ takes: [take] });
    const camera = container.querySelector<HTMLButtonElement>(".review-coverage-camera > button")!;
    const frame = camera.querySelector<HTMLElement>(".mo-media-thumb")!;
    const video = frame.querySelector("video")!;
    expect(frame.dataset.previewState).toBe("loading");
    act(() => video.dispatchEvent(new Event("error")));
    expect(frame.dataset.previewState).toBe("failed");
    expect(document.getElementById(camera.getAttribute("aria-describedby")!)?.textContent).toBe("无法载入预览");
    expect(camera.textContent).not.toContain("文件缺失");
    act(() => camera.click());
    expect(props.onWatch).toHaveBeenCalledWith(take, take.angles[0].clip_id);
  });

  it("opens the exact source time from the visible camera's existing transcript without a semantic index", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const take = { ...mapped, angles: mapped.angles.map(a => ({ ...a, media_id: "M_" + a.clip_id,
      playback: { ...a.playback, state: "verified" as const, source_start: 5, source_end: 10 } })) };
    vi.spyOn(SpeechEvidenceClient.prototype, "evidence").mockImplementation(async (_project, clipId) => ({
      contract: "mirrororder.speech_evidence.v1", clip_id: clipId, media_id: clipId === "A" ? "wrong-media" : "M_" + clipId,
      status: "available", backend: "test", coordinate_space: "source-relative-seconds", outcome: "transcribed",
      segments: [{ start: 1, end: 2, text: "先把灯打开" }, { start: 7.39, end: 8, text: clipId === "C" ? "另外一句" : "先把灯打开呀" }],
    }));
    await act(async () => root.render(<ReviewCoverageCards {...props} takes={[take]} activeBlock={line}
      connection={{ ...props.connection, baseUrl: "http://host.test" }} />));
    const cues = container.querySelectorAll<HTMLButtonElement>(".review-cue-link");
    expect(cues).toHaveLength(1);
    expect(cues[0].getAttribute("aria-label")).toContain("B机对白 0:07.3");
    act(() => cues[0].click());
    expect(props.onWatch).toHaveBeenCalledWith(take, "B", 7.39);
  });

  it("distinguishes mapping, legacy single-segment candidates, context, and unrelated nearby takes", () => {
    const context = { episode_ids: [1], script_segment_ids: [line.segment_id] };
    const takes = [mapped,
      { ...mapped, group_id: "inherited", effective_mapping: { ...mapped.effective_mapping, inherited: true } },
      { ...mapped, group_id: "auto", effective_mapping: { ...mapped.effective_mapping, source: "automatic" } },
      { ...base, group_id: "candidate", candidates: [candidate], context },
      { ...base, group_id: "context", context }, { ...base, group_id: "nearby" }];
    render({ activeBlock: line, takes });
    expect([...container.querySelectorAll(".review-coverage-relation")].map(x => x.textContent))
      .toEqual(["人工归属", "继承人工归属", "自动归属", "候选匹配", "上下文关联", "待核对"]);
    const links = [...container.querySelectorAll<HTMLButtonElement>('.review-coverage-text-head button')];
    expect(links.map(button => button.textContent)).toEqual(["打开剧本", "打开剧本", "打开剧本", "去剧本关联", "去剧本关联", "去剧本关联"]);
    const unrelated = container.querySelectorAll("article")[5];
    expect(unrelated.querySelector('[aria-label="剧本原句"]')).toBeNull();
    expect(unrelated.querySelector('[aria-label="剧本关联"]')).toBeTruthy();
    act(() => links[5].click());
    expect(props.onOpenScript).toHaveBeenCalledWith(takes[5], line.segment_id);
    expect(container.querySelectorAll(".review-coverage-other-lines")).toHaveLength(0);
  });

  it("preserves unlinked set dialogue and separates absent camera data from a missing local file", () => {
    const missing = { ...base.angles[0], playback: { ...base.angles[0].playback, state: "missing" as const } };
    render({ takes: [{ ...base, group_id: "unscripted", angles: [], transcript: { text: "现场补了一句。", source: "asr" } },
      { ...base, angles: [missing] }] });
    const [first, second] = container.querySelectorAll("article");
    expect(first.textContent).toContain("尚未关联剧本原句");
    expect(first.textContent).toContain("现场补了一句。");
    expect(first.textContent).toContain("尚无机位文件");
    expect(second.textContent).toContain("暂无素材组对白摘录");
    expect(second.querySelector(".review-coverage-camera")?.getAttribute("data-frame")).toBe("unavailable");
    expect(second.querySelector(".review-coverage-camera-info")?.textContent).toContain("文件缺失");
    expect(second.querySelector(".review-coverage-compare")).toBeNull();
  });

  it("keeps long transcripts readable without mounting a long project's offscreen camera frames", () => {
    const text = "这句是现场的真实对白。".repeat(35);
    const takes = Array.from({ length: 90 }, (_, i) => ({ ...mapped, group_id: "g" + i, transcript: { text, source: "asr" } }));
    render({ takes, selectedGroupId: "g70", activeBlock: line });
    expect(container.querySelectorAll("article")).toHaveLength(4);
    const transcript = container.querySelector('article[aria-current] .review-coverage-passage')!;
    expect(transcript.querySelector("p")?.textContent).toBe(text);
    act(() => transcript.querySelector("summary")!.click());
    expect(transcript.hasAttribute("open")).toBe(true);
    expect(container.querySelector("video[controls]")).toBeNull();
  });
});
