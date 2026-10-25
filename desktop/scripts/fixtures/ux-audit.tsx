// Dev-only fixture for scripts/ux-audit.mjs: synthetic review model plus a
// window.__uxFetch interceptor the runner installs before app code loads.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkbench } from "../../src/features/production/ProjectWorkbench";
import { initializeDesktopAppearance } from "../../src/app/desktopAppearance";
import "../../src/styles.css";
import "../../src/desktop-theme.css";
import "../../src/desktop-theme-tools.css";
import "../../src/desktop-theme-slate.css";
import "../../src/desktop-theme-frozen-surfaces.css";
import "../../src/features/media/media-binding-recovery.css";
import "../../src/app/mirrororder-redesign.css";
import "../../src/app/mirrororder-workspaces-redesign.css";
import "../../src/app/app-chrome.css";
import "../../src/design-system-v2.css";

initializeDesktopAppearance();

const DIALOGUE = [
  "你少吓唬我，我这人从来不吃这一套。",
  "账本呢？把账本给我看。",
  "他要是敢动我妹妹，我让他整个市场都开不了门。",
  "三百万，一分都不能少。",
  "你以为我怕你？",
  "这批货今晚必须出库，出了事我担着。",
  "别冲动，有话好好说。",
  "我数到三，把门打开。",
  "她根本不是你想的那个意思。",
  "签名吧，签了这事就了了。",
];
const ACTION = ["王强推门进入，环视仓库", "李娜低头擦泪，攥紧衣角", "两人在走廊对峙，镜头缓慢推进", "特写：手机屏幕亮起", "仓库灯忽然熄灭"];

function block(episode: number, sceneId: string, sceneNo: number, order: number, type: string) {
  const dialogue = type === "dialogue";
  const text = dialogue ? DIALOGUE[(order + sceneNo) % DIALOGUE.length] : ACTION[(order + sceneNo) % ACTION.length];
  return {
    segment_id: `S_${episode}_${sceneNo}_${order}`,
    episode,
    scene_id: sceneId,
    order,
    type,
    speaker: dialogue ? ["王强", "李娜", "赵总"][(order + sceneNo) % 3] : "",
    text,
    raw_text: `${dialogue ? ["王强", "李娜", "赵总"][(order + sceneNo) % 3] + "：" : ""}${text}`,
    issues: [],
  };
}

const episodes = [1, 2].map((episode) => {
  const scenes = [1, 2, 3, 4, 5].map((sceneNo) => {
    const sceneId = `SC_${episode}_${sceneNo}`;
    return {
      scene_id: sceneId,
      heading: `${episode}-${sceneNo} ${["仓库", "办公室", "天台", "医院走廊", "夜市"][(sceneNo - 1) % 5]} 日/夜`,
      script_blocks: [
        block(episode, sceneId, sceneNo, 1, "action"),
        block(episode, sceneId, sceneNo, 2, "dialogue"),
        block(episode, sceneId, sceneNo, 3, "action"),
        block(episode, sceneId, sceneNo, 4, "dialogue"),
      ],
      take_group_ids: [] as string[],
    };
  });
  return { episode, scenes };
});

function take(index: number) {
  const episode = index % 2 === 0 ? 1 : 2;
  const sceneNo = (Math.floor(index / 8) % 5) + 1;
  const takeNo = (index % 8) + 1;
  const group_id = `G_${episode}_${sceneNo}_${takeNo}`;
  const angleFor = (camera: string) => ({
    clip_id: `C_${group_id}_${camera}`,
    media_id: `M_${group_id}_${camera}`,
    camera,
    name: `${camera}00${(index % 9) + 1}C0${(index % 7) + 1}.mov`,
    timeline_start: 0,
    timeline_end: 8.4,
    duration: 8.4,
    source_start: 0,
    source_end: 8.4,
    playback: { url: `/api/v1/projects/ux/C_${group_id}_${camera}`, available: true, source_start: 0 },
    shot_type: ["中景", "近景", "特写"][index % 3],
    coverage_role: "sync_camera",
  });
  const mapped = index % 10 < 6;
  const segmentId = `S_${episode}_${sceneNo}_${mapped ? 4 : 2}`;
  return {
    group_id,
    parent_group_id: "",
    kind: "multicam",
    take_index: takeNo,
    split_reason: "",
    start: 0,
    end: 8.4,
    duration: 8.4,
    cameras: ["A", "B", "C"],
    angles: [angleFor("A"), angleFor("B"), angleFor("C")],
    transcript: { text: DIALOGUE[index % DIALOGUE.length], source: "asr" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: [episode], script_segment_ids: [segmentId] },
    automatic_state: { status: "" },
    editorial_state: {},
    effective_mapping: mapped
      ? { source: "human", mapping_status: "confirmed", script_segment_ids: [segmentId], episode_ids: [episode], inherited: false }
      : { source: "none", mapping_status: "unresolved", script_segment_ids: [], episode_ids: [], inherited: false },
    issues: [],
  };
}

const takeGroups = Array.from({ length: 400 }, (_, index) => take(index));

const reviewModel = {
  contract_version: "review.v1",
  project: {
    project_id: "ux-audit",
    name: "人不狠，站不稳",
    input_kind: "fcpxml",
    stats: { takes: takeGroups.length, groups: takeGroups.length },
    local_media: { total: 0, resolved: 0, missing: 0 },
    issues: [],
  },
  revisions: { analysis: "ux-audit", automation_analysis: "ux-audit", automation_updated_at: "2026-09-06T00:00:00+00:00", review: 12 },
  capabilities: { legacy_review_v2: true, individual_opinions: false, editorial_decision: false, production_controls: false, host_paths: false },
  summary: { automation: {}, script_gaps: 0, take_groups: takeGroups.length },
  take_groups: takeGroups,
  episodes,
};

const board = {
  version: 2,
  contract: "script_supervisor.v2",
  revision: 4,
  updated_at: "2026-09-06T01:00:00+00:00",
  records: {},
  entries: {},
  semantics: {},
};

window.__uxFetch = (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
  if (url.includes("/review-model")) {
    return new Response(JSON.stringify(reviewModel), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/script-supervisor")) {
    return new Response(JSON.stringify(board), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "not mocked" }), { status: 404, headers: { "Content-Type": "application/json" } });
};

const project = {
  project_id: "ux-audit",
  name: "人不狠，站不稳",
  input_kind: "fcpxml",
  stats: { takes: takeGroups.length, attention: 0 },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="mirrororder-redesign-shell">
      <ProjectWorkbench baseUrl="http://127.0.0.1:9" project={project} />
    </div>
  </StrictMode>,
);
