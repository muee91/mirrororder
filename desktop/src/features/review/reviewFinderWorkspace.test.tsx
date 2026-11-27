// @vitest-environment jsdom
import { act, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModelPayload, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { SemanticSearchClient, type SemanticSearchResult } from "../../api/semantic";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import {
  readShowRoughCutPreference,
  saveShowRoughCutPreference,
} from "../../app/desktopPreferences";
import type { ProductionSelectionContext } from "../production/productionNavigation";
import { ReviewWorkspace, scriptBlockBadge } from "./ReviewWorkspace";
import { reviewLocationText } from "./reviewLocation";

const reviewMock = vi.hoisted(() => ({
  model: null as ReviewModelPayload | null,
  slateStatus: "usable",
  paper: {} as Record<string, Record<string, { state: string; value: string }>>,
}));

vi.mock("../material-script/useReviewModelSnapshot", () => ({
  useReviewModelSnapshot: () => ({
    connection: { baseUrl: "http://host.test", mediaUrl: () => "" },
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
          status: reviewMock.slateStatus,
          note: "夜戏临场改词",
          preferred_clip_id: "c2",
          attachments: [],
          actor: "",
          updated_at: "",
        },
      },
      entries: {},
      semantics: {},
      paper_suggestions: {
        groups: Object.fromEntries(Object.entries(reviewMock.paper).map(([id, fields]) => [id, { fields }])),
      },
    });
  },
}));

vi.mock("../material-script/TakeInspector", async (importOriginal) => ({
  ...await importOriginal<typeof import("../material-script/TakeInspector")>(),
  TakeInspector: (
    { afterPlayback, take, selectedClipId, playbackFocus, monitor }: {
      afterPlayback?: ReactNode;
      take: ReviewTakeGroup | null;
      selectedClipId: string | null;
      playbackFocus?: ProductionSelectionContext;
      monitor?: { relatedActions?: ReactNode; slateContext?: ReactNode; request?: object; videoRef: Ref<HTMLVideoElement> };
    },
  ) => (
    <div data-testid="take-inspector" data-range={JSON.stringify(playbackFocus?.sourceRange)} data-request={JSON.stringify(monitor?.request)}>
      {monitor && <video data-clip-id={selectedClipId ?? undefined} ref={monitor.videoRef} />}
      {take ? `${take.group_id}:${selectedClipId}` : "empty"}
      {afterPlayback}
      {monitor?.relatedActions}
      {monitor?.slateContext}
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
    cameras: ["A", "B"],
    angles: [
      angle(clipId, name, "A"),
      angle(`b${groupId.slice(1)}`, `B${name.slice(1)}`, "B"),
    ],
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
        scene_id: "SC_1_1",
        heading: "客厅·日",
        take_group_ids: ["g1"],
        script_blocks: [{
          segment_id: "seg-1",
          episode: 1,
          scene_id: "SC_1_1",
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
      take("g2", "临场改词", "c2", "A002C003.MOV", [], [2]),
    ],
    script_gaps: [],
    review_state: {},
  };
}

function searchFor(container: HTMLElement, query: string) {
  const input = container.querySelector<HTMLInputElement>(".review-search-input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Review Finder workspace", () => {
  let root: Root;
  let container: HTMLDivElement;

  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;
  const openWatch = async () => { await act(async () => button("逐条看片").click()); };

  beforeEach(async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    reviewMock.model = model();
    reviewMock.slateStatus = "usable";
    reviewMock.paper = { g1: { scene: { state: "suggested", value: "1-1" }, shot: { state: "suggested", value: "2" } } };
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

  it("starts on the script with every related group and keeps the selected missing line through recovery and camera inspection", async () => {
    const fixture = model();
    const original = fixture.episodes[0].scenes[0].script_blocks[0];
    fixture.episodes[0].scenes[0].script_blocks.push({ ...original, segment_id: "missing", text: "再走一遍", raw_text: "再走一遍" });
    fixture.episodes[1].scenes[0].script_blocks.push({ ...original, segment_id: "other", episode: 2, scene_id: "scene-2", text: "另一个场景", raw_text: "另一个场景" });
    fixture.take_groups.push(take("g3", "换个说法", "c3", "A003.MOV", ["seg-1"], [1]));
    reviewMock.model = fixture;
    const open = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    await act(async () => root.render(<ReviewWorkspace key="script-first" baseUrl="http://host.test" project={fixture.project} onOpenScript={open} />));
    expect(button("剧本对照").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".review-coverage-card")).toHaveLength(2);
    expect(container.querySelectorAll(".review-coverage-camera")).toHaveLength(4);
    await act(async () => button("多机位同看").click());
    expect(container.querySelector("dialog[open]")).toBeTruthy();
    await act(async () => button("返回审阅").click());
    await act(async () => button("待找素材 1").click());
    await act(async () => container.querySelector<HTMLButtonElement>(".review-outline-line")!.click());
    expect(container.textContent).toContain("这段剧本还没有关联素材");
    await act(async () => button("在本集找素材").click());
    expect(container.querySelectorAll(".review-coverage-card")).toHaveLength(2);
    await act(async () => button("在全项目找").click());
    expect(container.querySelectorAll(".review-coverage-card")).toHaveLength(3);
    const target = () => container.querySelector<HTMLElement>('article[aria-label*="A002C003"]')!;
    await act(async () => target().querySelector<HTMLButtonElement>('button[aria-label*="B002C003"]')!.click());
    expect(container.querySelector('[data-testid="take-inspector"]')?.textContent).toContain("g2:b2");
    await act(async () => button("剧本对照").click());
    expect(container.querySelector('.review-outline-line[aria-pressed="true"]')?.textContent).toContain("再走一遍");
    expect(container.querySelectorAll(".review-coverage-card")).toHaveLength(3);
    await act(async () => [...target().querySelectorAll("button")].find((node) => node.textContent?.includes("关联"))!.click());
    expect(open).toHaveBeenCalledWith("g2", "b2", expect.objectContaining({ scriptSegmentId: "missing", clipId: "b2" }));
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索全剧原句或角色"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "另一个");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".review-outline-line")).toHaveLength(1);
    expect(container.querySelector(".review-outline-line")?.textContent).toContain("另一个场景");
  });

  it("opens the watch queue directly on a scriptless project", async () => {
    const fixture = model();
    fixture.episodes = [];
    reviewMock.model = fixture;
    await act(async () => root.render(<ReviewWorkspace key="without-script" baseUrl="http://host.test" project={fixture.project} />));
    expect(container.querySelectorAll(".review-take-card")).toHaveLength(2);
    expect(button("多机位同看")).toBeTruthy();
    expect(container.querySelector(".review-outline-panel")).toBeNull();
  });

  it("labels action blocks and copies a verified source and master timecode together", () => {
    expect(scriptBlockBadge({ type: "action", speaker: "", text: "△走向门", raw_text: "△走向门" } as ReviewScriptBlock)).toBe("动作");
    const clip = angle("b1", "B001C001", "B");
    const rate = { numerator: 50, denominator: 1 };
    const timeline: MulticamSyncTimeline = {
      contract_version: "multicam_sync_timeline.v1", project_id: "p1", phase: "completed", ready: true,
      task: null, message: "", duration_seconds: 10, clip_count: 1, cameras: ["B"],
      timebase: { status: "confirmed", source: "fcpxml_sequence", ...rate },
      tracks: [{ kind: "video", track_id: "B", camera: "B", label: "B机", clip_count: 1, clips: [{
        clip_id: "c", media_clip_id: "b1", name: "B001C001.MOV", day: "day", camera: "B", timeline_start: 0,
        duration: 10, timecode: "", clip_number: "1", manual_offset_frames: 2,
      }] }],
    };
    expect(reviewLocationText(clip, 86.25, "B机", timeline, {
      clip_id: "b1", media_id: "m-b1", filename: "B001C001.MOV", start_timecode: "06:44:32:48", frame_rate: rate,
    })).toBe("B机 · B001C001.MOV\n原片时码 06:45:59:10\n同步母版时码 00:00:03:14");
  });

  it("uses sequential card numbers when take indexes repeat across scenes", async () => {
    await openWatch();
    const duplicateModel = model();
    duplicateModel.take_groups[1].take_index = 1;
    reviewMock.model = duplicateModel;
    await act(async () => root.render(
      <ReviewWorkspace
        baseUrl="http://host.test"
        project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }}
      />,
    ));
    expect(container.querySelector('[aria-label="Take #1 · A001C001"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Take #2 · A002C003"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Take #1 · A002C003");
  });

  it("keeps unnumbered Takes distinguishable in both the list and monitor", async () => {
    await openWatch();
    const oldModel = model();
    for (const take of oldModel.take_groups) take.take_index = 0;
    reviewMock.model = oldModel;
    await act(async () => root.render(<ReviewWorkspace baseUrl="http://host.test" project={oldModel.project} />));
    const rows = container.querySelectorAll<HTMLButtonElement>(".review-take-select");
    expect([...rows].map(row => row.querySelector("strong")?.textContent)).toEqual(["Take #1", "Take #2"]);
    await act(async () => rows[1].click());
    expect(container.querySelector(".review-monitor-title strong")?.textContent).toBe("Take #2");
  });

  it("opens the script outline on demand and filters Takes from it", async () => {
    await openWatch();
    expect(container.querySelector(".review-script-rail")).toBeNull();
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "按剧本找")!;
    await act(async () => toggle.click());
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
    await act(async () => searchFor(container, "夜戏临场改词"));
    expect(container.querySelector(".review-take-card .review-take-select")?.textContent).toContain("12场");
    expect(container.querySelector(".review-script-rail h3")?.textContent).toContain("第 2 集");
  });

  it("orders a scene naturally by shot and logged take, and navigates in the chosen order", async () => {
    await openWatch();
    const fixture = model();
    const [first, otherEpisode] = fixture.take_groups;
    const shotTen = { ...take("g3", "", "c3", "A003C001.MOV", ["seg-1"], [1]), start: 1 };
    const earlierTake = { ...take("g4", "", "c4", "A004C001.MOV", ["seg-1"], [1]), start: 10 };
    fixture.take_groups = [shotTen, { ...first, start: 5 }, earlierTake, { ...otherEpisode, start: 20 }];
    reviewMock.model = fixture;
    for (const [id, shot, number] of [["g1", "2", "2"], ["g3", "10", "1"], ["g4", "2", "1"]]) {
      reviewMock.paper[id] = {
        scene: { state: "suggested", value: "1-1" }, shot: { state: "suggested", value: shot }, take: { state: "suggested", value: number },
      };
    }
    await act(async () => root.render(<ReviewWorkspace key="order" baseUrl="http://host.test"
      project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} />));
    await openWatch();
    const episode = container.querySelector<HTMLSelectElement>('select[aria-label="按集筛选"]')!;
    await act(async () => { episode.value = "1"; episode.dispatchEvent(new Event("change", { bubbles: true })); });
    const sort = container.querySelector<HTMLSelectElement>('select[aria-label="排序方式"]')!;
    expect(sort?.value).toBe("script");
    const rows = () => [...container.querySelectorAll<HTMLElement>(".review-take-card")];
    expect(rows().map((row) => row.getAttribute("aria-label")?.split(" · ").at(-1)))
      .toEqual(["A004C001", "A001C001", "A003C001"]);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>(".review-take-select")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一条"]')!.click());
    expect(container.querySelector('[data-testid="take-inspector"]')?.textContent).toContain("g1:c1");
    await act(async () => { sort.value = "shooting"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(rows().map((row) => row.getAttribute("aria-label")?.split(" · ").at(-1)))
      .toEqual(["A003C001", "A001C001", "A004C001"]);
    expect(container.querySelector('[data-testid="take-inspector"]')?.textContent).toContain("g1:c1");
  });

  it("searches spoken dialogue, filenames, and slate notes across episodes", async () => {
    await openWatch();
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
    expect(container.querySelector(".review-take-card")?.getAttribute("aria-label")).toContain("A002C003");
    await act(async () => {
      setInputValue("夜戏临场改词");
    });
    expect(container.querySelector(".review-take-card")?.getAttribute("aria-label")).toContain("A002C003");
    await act(async () => {
      setInputValue("1—1 2镜");
    });
    const cards = container.querySelectorAll(".review-take-card");
    expect(cards).toHaveLength(1);
    expect(container.querySelector(".review-queue-scene")?.textContent).toBe("第 1 集 · 1-1 场");
    expect(cards[0].textContent).toContain("2镜");
    expect(cards[0].textContent).not.toContain("1次");
  });

  it("keeps another episode's candidate out of the regular episode filter", async () => {
    await openWatch();
    const fixture = model();
    fixture.take_groups[0].context.episode_ids = [1, 2];
    reviewMock.model = fixture;
    await act(async () => root.render(<ReviewWorkspace baseUrl="http://host.test"
      project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} />));
    await act(async () => searchFor(container, "2集 A001C001.MOV"));
    expect(container.querySelector(".review-take-card")).toBeNull();
    const include = [...container.querySelectorAll("button")].find((button) => button.textContent === "跨集候选")!;
    await act(async () => include.click());
    expect(container.querySelector(".review-take-card")?.getAttribute("aria-label")).toContain("A001C001");
    await act(async () => searchFor(container, "1集 A001C001.MOV"));
    expect(include.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".review-take-card")?.getAttribute("aria-label")).toContain("A001C001");
  });

  it("hides slate NG without hiding an editor's reject", async () => {
    await openWatch();
    const fixture = model();
    fixture.take_groups[0].editorial_state.editorial_decision = { state: "reject" };
    reviewMock.model = fixture;
    reviewMock.slateStatus = "ng";
    await act(async () => root.render(<ReviewWorkspace key="ng" baseUrl="http://host.test"
      project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} />));
    await openWatch();
    await act(async () => container.querySelector<HTMLButtonElement>(".review-hide-ng")!.click());
    const cards = container.querySelectorAll(".review-take-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("废弃");
    expect(cards[0].getAttribute("aria-label")).toContain("A001C001");
  });

  it("opens a script line at a bounded ASR hit on the actual matching angle", async () => {
    await openWatch();
    const fixture = model();
    fixture.take_groups[0].angles[1].playback.state = "verified";
    reviewMock.model = fixture;
    const match: SemanticSearchResult = {
      document_id: "spoken-line", group_id: "g1", clip_id: "b1", media_id: "m-b1",
      source: "speech", source_label: "对白", score: 1, vector_similarity: null,
      keyword_rank: 1, vector_rank: null, start: 3.2, end: 4.6, snippet: "小林，你回来了。",
      metadata: { time_basis: "take_relative", precision: "asr_segment" },
    };
    vi.useFakeTimers();
    try {
      const search = vi.spyOn(SemanticSearchClient.prototype, "searchLocal").mockResolvedValue({
        contract: "semantic_search.v1", query: "你回来了", mode: "keyword", summary: {}, semantics: {},
        results: [{ ...match, document_id: "wrong-words", start: 1, end: 2, snippet: "你走了" }, match],
      });
      await act(async () => root.render(<ReviewWorkspace baseUrl="http://host.test"
        project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} />));
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "按剧本找")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".review-script-block")!.click());
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(search).toHaveBeenCalledWith("p1", "你回来了", expect.objectContaining({ sources: ["speech"], groupIds: ["g1"] }));
      const inspector = container.querySelector("[data-testid='take-inspector']")!;
      expect(inspector.textContent).toContain("g1:b1");
      expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ basis: "take", start: 3.2, end: 4.6 });
      expect(JSON.parse(inspector.getAttribute("data-request")!)).toMatchObject({ autoplay: false, bounded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows each timed match for a Take and returns from a fragment to the right camera and source time", async () => {
    await openWatch();
    const result: SemanticSearchResult = {
      document_id: "speech-c1-8", group_id: "g1", clip_id: "c1", media_id: "m-c1",
      source: "speech", source_label: "对白", score: 1, vector_similarity: null,
      keyword_rank: 1, vector_rank: null, start: 8, end: 9, snippet: "只在同期声里的台词",
      metadata: { time_basis: "take_relative" },
    };
    const frame: SemanticSearchResult = {
      ...result, document_id: "visual-b1-85", clip_id: "b1", media_id: "m-b1",
      source: "visual", source_label: "画面", start: 85, end: 85, snippet: "杯子放到桌上",
      metadata: { time_basis: "source", precision: "sampled_frame" },
    };
    vi.useFakeTimers();
    try {
      const search = vi.spyOn(SemanticSearchClient.prototype, "searchLocal").mockResolvedValue({
        contract: "semantic_search.v1", query: "同期声", mode: "keyword", results: [result, frame], summary: {}, semantics: {},
      });
      const compute = vi.spyOn(SemanticSearchClient.prototype, "searchCompute");
      const open = vi.fn();
      await act(async () => root.render(<ReviewWorkspace baseUrl="http://host.test"
        project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} onOpenEvidence={open} />));
      await act(async () => searchFor(container, "1-1 同期声"));
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(search).toHaveBeenCalledOnce();
      expect(search).toHaveBeenCalledWith("p1", "同期声", expect.objectContaining({ groupIds: ["g1"] }));
      expect(compute).not.toHaveBeenCalled();
      const fragments = container.querySelectorAll(".review-fragment-card");
      expect(fragments).toHaveLength(2);
      expect(fragments[0].textContent).toContain("条内 8.00–9.00s");
      expect(fragments[1].textContent).toContain("B001C001.MOV");
      expect(fragments[1].textContent).toContain("原片 85.00s");
      await act(async () => fragments[1].querySelector<HTMLButtonElement>(".review-evidence-hit")!.click());
      const inspector = container.querySelector("[data-testid='take-inspector']")!;
      expect(inspector.textContent).toContain("g1:b1");
      expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ start: 85, basis: "source" });
      const preview = JSON.parse(inspector.getAttribute("data-request")!);
      expect(preview).toMatchObject({ autoplay: true, bounded: true });
      expect(open).not.toHaveBeenCalled();
      expect(container.querySelector(".review-transport-actions > span")?.textContent).toContain("2 / 2");
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="上一条"]')!.click());
      expect(inspector.textContent).toContain("g1:c1");
      expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ start: 8, end: 9, basis: "take" });
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="下一条"]')!.click());
      expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ start: 85, basis: "source" });
      const returned = JSON.parse(inspector.getAttribute("data-request")!);

      const video = inspector.querySelector("video")!;
      Object.defineProperty(video, "readyState", { value: 2 });
      video.currentTime = 86.25;
      await act(async () => container.querySelector<HTMLButtonElement>(".review-location-copy")!.click());
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("B机 · B001C001.MOV\n原片位置 00:01:26.250\n项目内位置 00:00:03.250");

      await act(async () => fragments[1].querySelector<HTMLButtonElement>(".review-fragment-take")!.click());
      expect(container.querySelector<HTMLInputElement>(".review-search-input")!.value).toBe("1-1 同期声");
      expect(container.querySelectorAll(".review-take-card")).toHaveLength(1);
      const allHits = container.querySelector(".review-take-hits")!;
      expect(allHits.querySelector("summary")?.textContent).toBe("其他 1 条命中");
      expect(allHits.querySelectorAll(".review-evidence-hit")).toHaveLength(2);
      expect(JSON.parse(inspector.getAttribute("data-request")!)).toMatchObject({ nonce: returned.nonce, bounded: false });
      expect(inspector.querySelector("video")?.currentTime).toBe(86.25);
      await act(async () => container.querySelector<HTMLButtonElement>(".review-take-cameras button")!.click());
      expect(inspector.textContent).toContain("g1:c1");
      expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ start: 86.25, basis: "source" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps two Takes available across searches and restores each viewed position", async () => {
    await openWatch();
    const firstCamera = container.querySelectorAll<HTMLButtonElement>(".review-monitor-cameras button")[1];
    await act(async () => firstCamera.click());
    const toggles = container.querySelectorAll<HTMLButtonElement>(".review-compare-toggle");
    await act(async () => toggles[0].click());
    await act(async () => searchFor(container, "夜戏临场改词"));
    expect(container.querySelectorAll(".review-take-card")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".review-compare-toggle")!.click());

    const compared = container.querySelectorAll<HTMLButtonElement>(".review-comparison-item button:first-child");
    expect(compared).toHaveLength(2);
    const inspector = container.querySelector("[data-testid='take-inspector']")!;
    const video = inspector.querySelector("video")!;
    Object.defineProperty(video, "readyState", { value: 2 });
    video.currentTime = 85.75;
    await act(async () => compared[1].click());
    expect(inspector.textContent).toContain("g2:b2");
    video.currentTime = 88.25;
    await act(async () => compared[0].click());
    expect(inspector.textContent).toContain("g1:b1");
    expect(JSON.parse(inspector.getAttribute("data-request")!)).toMatchObject({
      autoplay: false, resume: { groupId: "g1", clipId: "b1", sourceRange: { basis: "source", start: 85.75 } },
    });
    video.currentTime = 85.75;
    await act(async () => compared[1].click());
    expect(JSON.parse(inspector.getAttribute("data-request")!)).toMatchObject({
      autoplay: false, resume: { groupId: "g2", clipId: "b2", sourceRange: { basis: "source", start: 88.25 } },
    });
    await act(async () => compared[0].click());
    await act(async () => container.querySelector<HTMLButtonElement>(".review-comparison-item button:last-child")!.click());
    expect(inspector.textContent).toContain("g1:b1");
    expect(container.querySelectorAll(".review-comparison-item")).toHaveLength(1);
  });

  it("opens only the matching camera for a filename search even when there is no semantic hit", async () => {
    await openWatch();
    const open = vi.fn();
    const search = vi.spyOn(SemanticSearchClient.prototype, "searchLocal");
    await act(async () => root.render(<ReviewWorkspace baseUrl="http://host.test"
      project={{ project_id: "p1", name: "测试", input_kind: "media-directory" }} onOpenEvidence={open} />));
    await act(async () => searchFor(container, "B001C001.MOV"));
    const hits = container.querySelectorAll<HTMLButtonElement>(".review-fragment-card .review-evidence-hit");
    expect(hits).toHaveLength(1);
    expect(hits[0].textContent).toContain("B001C001.MOV");
    await act(async () => hits[0].click());
    const inspector = container.querySelector("[data-testid='take-inspector']")!;
    expect(inspector.textContent).toContain("g1:b1");
    expect(JSON.parse(inspector.getAttribute("data-range")!)).toEqual({ basis: "source", start: 83, end: 93 });
    expect(search).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("copies both positions for an older project without detected timecode", async () => {
    await openWatch();
    await act(async () =>
      (container.querySelector<HTMLButtonElement>(
        ".review-location-copy",
      )!).click()
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "A机 · A001C001.MOV\n原片位置 00:01:23.000\n项目内位置 00:00:00.000",
    );
    expect(container.textContent).toContain("已复制");
  });

  it("keeps rough cut hidden by default and exposes it after the preference is enabled", async () => {
    await openWatch();
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
          onOpenTimeline={vi.fn()}
        />,
      )
    );
    expect(container.textContent).toContain("到时间线");
  });
});
