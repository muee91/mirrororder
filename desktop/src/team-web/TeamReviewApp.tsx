import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewAngle, ReviewModelPayload, ReviewScriptBlock, ReviewTakeGroup } from "../api/host";
import type { SlateBoard } from "../api/production";
import type { SpeechEvidence } from "../api/speechEvidence";
import { cameraPresentation } from "../features/media/cameraPresentation";
import { projectionOf } from "../features/material-script/model";
import { indexReviewSlates, slateLabels } from "../features/review/reviewFootageFacts";
import {
  TeamApiError,
  getStableReviewerId,
  teamApi,
  teamMediaUrl,
  type TeamProjectSummary,
  type TeamUserMe,
  type TeamWorkspaceSummary,
} from "./teamApi";
import {
  angleSourceWindow,
  formatClock,
  hasTakeOpinionConflict,
  myTakeOpinion,
  reviewProgress,
  syncAngleTime,
  takeCollaborationSummary,
  takeScriptContext,
} from "./teamModel";
import { TeamMulticamModal } from "./TeamMulticamModal";
import { TeamCompactDecisionBar, TeamOpinionDrawer } from "./TeamOpinionDrawer";
import { TeamVideoFrame } from "./TeamVideoFrame";

type ReviewMode = "coverage" | "watch";
type ReviewFilter = "all" | "my_unreviewed" | "team_opinions" | "team_conflict" | "slate_usable";

export function TeamReviewApp() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [bootState, setBootState] = useState<"loading" | "pairing" | "disabled" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState("");

  const [workspaces, setWorkspaces] = useState<TeamWorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projects, setProjects] = useState<TeamProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [me, setMe] = useState<TeamUserMe | null>(null);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");

  const [model, setModel] = useState<ReviewModelPayload | null>(null);
  const [slateBoard, setSlateBoard] = useState<SlateBoard | null>(null);
  const [collabOnline, setCollabOnline] = useState(true);
  const [toast, setToast] = useState("");

  const [mode, setMode] = useState<ReviewMode>("coverage");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [hideNg, setHideNg] = useState(false);
  const [query, setQuery] = useState("");
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [multicamGroupId, setMulticamGroupId] = useState<string | null>(null);
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [scriptDrawerOpen, setScriptDrawerOpen] = useState(false);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [mobileQueueOpen, setMobileQueueOpen] = useState(false);

  const playerRef = useRef<HTMLVideoElement>(null);
  const [playerTime, setPlayerTime] = useState(0);
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [angleNotice, setAngleNotice] = useState("");
  const [angleSpeech, setAngleSpeech] = useState<SpeechEvidence | null>(null);
  const speechCacheRef = useRef<Map<string, SpeechEvidence>>(new Map());
  const revisionsRef = useRef<{ analysis: string; review: number; editorial: number; supervisor: number }>({
    analysis: "",
    review: 0,
    editorial: 0,
    supervisor: 0,
  });

  const reviewerId = getStableReviewerId();
  const canWrite = me?.status === "active" && (me.role === "reviewer" || me.role === "manager");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? "" : cur)), 2600);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mirrororder-team-theme", next);
    } catch {
      // Ignore storage failure.
    }
  };

  const loadProjectData = useCallback(async (wsId: string, projId: string, silent = false) => {
    const [nextModel, nextSlate] = await Promise.all([
      teamApi.getReviewModel(wsId, projId),
      teamApi.getSlateBoard(wsId, projId).catch(() => null),
    ]);
    setModel(nextModel);
    setSlateBoard(nextSlate);
    const revs = (nextModel.revisions ?? {}) as Record<string, unknown>;
    revisionsRef.current = {
      analysis: String(revs.analysis || ""),
      review: Number(revs.review || 0),
      editorial: Number(revs.editorial || 0),
      supervisor: Number(revs.script_supervisor || 0),
    };
    const firstEp = nextModel.episodes?.[0] ?? null;
    const firstSeg = firstEp?.scenes?.[0]?.script_blocks?.find((b: ReviewScriptBlock) => b.type !== "scene_heading") ?? null;
    setActiveEpisode((cur) => (cur !== null ? cur : firstEp?.episode ?? null));
    setActiveSegmentId((cur) => (cur ? cur : firstSeg?.segment_id ?? null));
    if (!firstSeg) setMode("watch");
    if (!silent && nextModel.take_groups.length > 0) {
      setSelectedGroupId((cur) =>
        cur && nextModel.take_groups.some((t: ReviewTakeGroup) => t.group_id === cur)
          ? cur
          : nextModel.take_groups[0].group_id,
      );
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setBootState("loading");
    setBootError("");
    try {
      const pairing = await teamApi.getPairingStatus();
      if (pairing.required && !pairing.paired) {
        setBootState("pairing");
        return;
      }
      const wsPayload = await teamApi.listWorkspaces();
      const wsList = wsPayload.workspaces || [];
      setWorkspaces(wsList);
      if (!wsList.length) {
        setBootState("ready");
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const reqWs = params.get("workspace_id") || "";
      const chosenWs = wsList.find((w) => w.workspace_id === reqWs) ?? wsList[0];
      setWorkspaceId(chosenWs.workspace_id);

      const [wsDetail, userRes] = await Promise.all([
        teamApi.getWorkspace(chosenWs.workspace_id),
        teamApi.getMe(chosenWs.workspace_id),
      ]);
      setMe(userRes.user);
      setNicknameDraft(userRes.user.nickname || "");
      if (!userRes.user.nickname.trim()) setNicknameOpen(true);

      const projList = wsDetail.projects || [];
      setProjects(projList);
      const reqProj = params.get("project_id") || "";
      const chosenProj =
        projList.find((p) => p.project_id === reqProj) ??
        projList.find((p) => (p.stats?.groups ?? 0) > 0) ??
        projList[0];
      if (chosenProj) {
        setProjectId(chosenProj.project_id);
        await loadProjectData(chosenWs.workspace_id, chosenProj.project_id);
      }
      setBootState("ready");
      setCollabOnline(true);
    } catch (error) {
      if (error instanceof TeamApiError) {
        if (error.status === 401) {
          setBootState("pairing");
          return;
        }
        if (error.status === 403 && error.message.includes("停用")) {
          setBootState("disabled");
          return;
        }
      }
      setBootError(error instanceof Error ? error.message : "连接团队审阅服务失败");
      setBootState("error");
    }
  }, [loadProjectData]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (bootState !== "ready" || !workspaceId || !projectId) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void teamApi
        .getState(workspaceId, projectId)
        .then(async (next) => {
          setCollabOnline(true);
          const prev = revisionsRef.current;
          const changed =
            (next.analysis_revision && next.analysis_revision !== prev.analysis) ||
            Number(next.review_revision || 0) !== prev.review ||
            Number(next.editorial_revision || 0) !== prev.editorial ||
            Number(next.script_supervisor_revision || 0) !== prev.supervisor;
          if (changed) {
            await loadProjectData(workspaceId, projectId, true);
            showToast("协作状态已同步");
          }
        })
        .catch(() => setCollabOnline(false));
    }, 3500);
    return () => window.clearInterval(timer);
  }, [bootState, workspaceId, projectId, loadProjectData, showToast]);

  const projection = useMemo(() => (model ? projectionOf(model) : null), [model]);
  const { facts: slateFacts } = useMemo(
    () => indexReviewSlates(model?.take_groups ?? [], slateBoard),
    [model, slateBoard],
  );

  const blocksById = useMemo(() => {
    const map = new Map<string, ReviewScriptBlock>();
    for (const ep of model?.episodes ?? []) {
      for (const sc of ep.scenes ?? []) {
        for (const blk of sc.script_blocks ?? []) map.set(blk.segment_id, blk);
      }
    }
    return map;
  }, [model]);

  const activeBlock = activeSegmentId ? blocksById.get(activeSegmentId) ?? null : null;
  const hasScript = Boolean(
    model?.episodes?.some((ep) => ep.scenes?.some((sc) => sc.script_blocks?.some((b) => b.type !== "scene_heading"))),
  );

  const progress = useMemo(
    () => reviewProgress(model?.take_groups ?? [], reviewerId),
    [model, reviewerId],
  );

  const filteredTakes = useMemo(() => {
    if (!model) return [];
    const q = query.trim().toLowerCase();
    const segmentTakeIds =
      mode === "coverage" && activeSegmentId && projection
        ? new Set(projection.relatedTakeIds.get(activeSegmentId) ?? [])
        : null;

    return model.take_groups.filter((take) => {
      const slate = slateFacts.get(take.group_id);
      if (hideNg && slate?.take?.status === "ng") return false;
      if (segmentTakeIds && !segmentTakeIds.has(take.group_id)) return false;
      if (filter === "my_unreviewed") {
        const mine = myTakeOpinion(take, mode === "coverage" ? activeSegmentId : null, reviewerId);
        if (mine && mine.state !== "unreviewed") return false;
      } else if (filter === "team_opinions") {
        const summary = takeCollaborationSummary(take);
        if (summary.opinionCount === 0 && summary.commentCount === 0) return false;
      } else if (filter === "team_conflict") {
        if (!hasTakeOpinionConflict(take)) return false;
      } else if (filter === "slate_usable") {
        if (slate?.take?.status !== "usable" && slate?.take?.status !== "partial") return false;
      }
      if (q) {
        const haystack = [
          take.transcript?.text || "",
          slate?.take?.note || "",
          ...take.angles.map((a) => `${a.name} ${a.camera}`),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [model, query, mode, activeSegmentId, projection, slateFacts, hideNg, filter, reviewerId]);

  const selectedTake = useMemo(
    () => filteredTakes.find((t) => t.group_id === selectedGroupId) ?? filteredTakes[0] ?? null,
    [filteredTakes, selectedGroupId],
  );

  const activeAngle: ReviewAngle | null = useMemo(() => {
    if (!selectedTake) return null;
    return (
      selectedTake.angles.find((a) => a.clip_id === selectedClipId) ??
      selectedTake.angles.find((a) => a.playback?.available !== false) ??
      selectedTake.angles[0] ??
      null
    );
  }, [selectedTake, selectedClipId]);

  useEffect(() => {
    if (!workspaceId || !projectId || !activeAngle?.clip_id) {
      setAngleSpeech(null);
      return;
    }
    const cacheKey = `${projectId}:${activeAngle.clip_id}`;
    const cached = speechCacheRef.current.get(cacheKey);
    if (cached) {
      setAngleSpeech(cached);
      return;
    }
    let active = true;
    setAngleSpeech(null);
    void teamApi
      .getSpeechEvidence(workspaceId, projectId, activeAngle.clip_id)
      .then((res) => {
        speechCacheRef.current.set(cacheKey, res);
        if (active) setAngleSpeech(res);
      })
      .catch(() => {
        if (active) setAngleSpeech(null);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, projectId, activeAngle?.clip_id]);

  const selectTakeAndAngle = useCallback((take: ReviewTakeGroup, clipId?: string, seekTime?: number): void => {
    setAngleNotice("");
    setSelectedGroupId(take.group_id);
    const targetAngle =
      (clipId ? take.angles.find((a) => a.clip_id === clipId) : undefined) ??
      take.angles.find((a) => a.playback?.available !== false) ??
      take.angles[0];
    setSelectedClipId(targetAngle?.clip_id ?? null);
    if (seekTime !== undefined) {
      setPendingSeek(seekTime);
      setPlayerTime(seekTime);
    } else if (targetAngle) {
      const { start } = angleSourceWindow(targetAngle);
      setPendingSeek(start);
      setPlayerTime(start);
    }
  }, []);

  const switchAngleSynced = useCallback(
    (nextAngle: ReviewAngle): void => {
      if (!activeAngle || nextAngle.clip_id === activeAngle.clip_id) return;
      const current = playerRef.current?.currentTime ?? playerTime;
      const synced = syncAngleTime(activeAngle, nextAngle, current);
      if (synced === null) {
        setAngleNotice(`${cameraPresentation(nextAngle.camera).label} 在当前时间点无覆盖`);
        return;
      }
      setAngleNotice("");
      setSelectedClipId(nextAngle.clip_id);
      setPendingSeek(synced);
      setPlayerTime(synced);
    },
    [activeAngle, playerTime],
  );

  // Desktop keyboard quick-review shortcuts in watch mode.
  useEffect(() => {
    if (bootState !== "ready" || mode !== "watch" || !selectedTake) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || nicknameOpen || multicamGroupId) return;
      if (event.key === " ") {
        const video = playerRef.current;
        if (!video) return;
        event.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
        return;
      }
      const idx = filteredTakes.findIndex((t) => t.group_id === selectedTake.group_id);
      if (event.key === "ArrowDown" && idx >= 0 && idx < filteredTakes.length - 1) {
        event.preventDefault();
        selectTakeAndAngle(filteredTakes[idx + 1]);
        return;
      }
      if (event.key === "ArrowUp" && idx > 0) {
        event.preventDefault();
        selectTakeAndAngle(filteredTakes[idx - 1]);
        return;
      }
      if (["1", "2", "3", "4"].includes(event.key)) {
        const target = selectedTake.angles[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          switchAngleSynced(target);
        }
        return;
      }
      if (event.key.toLowerCase() === "m" && selectedTake.angles.length > 1) {
        event.preventDefault();
        setMulticamGroupId(selectedTake.group_id);
        return;
      }
      const voteMap: Record<string, "best" | "keep" | "reject" | "unreviewed"> = {
        b: "best",
        k: "keep",
        x: "reject",
        u: "unreviewed",
      };
      const vote = voteMap[event.key.toLowerCase()];
      if (vote && canWrite && me?.nickname.trim()) {
        event.preventDefault();
        void teamApi
          .submitOpinion(workspaceId, projectId, {
            targetKind: "group",
            groupId: selectedTake.group_id,
            state: vote,
            actor: me.nickname,
          })
          .then(() => loadProjectData(workspaceId, projectId, true));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bootState,
    mode,
    selectedTake,
    filteredTakes,
    nicknameOpen,
    multicamGroupId,
    canWrite,
    me?.nickname,
    workspaceId,
    projectId,
    selectTakeAndAngle,
    switchAngleSynced,
    loadProjectData,
  ]);

  async function handlePairingSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setPairingError("");
    try {
      await teamApi.submitPairing(pairingCode);
      setPairingCode("");
      await bootstrap();
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "配对失败");
    }
  }

  async function handleNicknameSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!workspaceId || !nicknameDraft.trim()) return;
    try {
      const res = await teamApi.saveNickname(workspaceId, nicknameDraft);
      setMe(res.user);
      setNicknameOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存昵称失败");
    }
  }

  if (bootState === "loading") {
    return <div className="tw-center-state">正在连接镜序团队审阅…</div>;
  }
  if (bootState === "disabled") {
    return (
      <div className="tw-center-state">
        <div className="tw-dialog-card">
          <h2>访问已停用</h2>
          <p>制作主机管理员已停用当前浏览器的团队审阅权限。如需恢复，请联系主剪。</p>
        </div>
      </div>
    );
  }
  if (bootState === "pairing") {
    return (
      <div className="tw-center-state">
        <form className="tw-dialog-card" onSubmit={(e) => void handlePairingSubmit(e)}>
          <h2>加入团队审阅</h2>
          <p>请输入制作主机「局域网共享」页面显示的配对码。</p>
          <input
            type="text"
            value={pairingCode}
            autoFocus
            placeholder="输入配对码"
            onChange={(e) => setPairingCode(e.target.value)}
          />
          {pairingError ? <p className="tw-error-text">{pairingError}</p> : null}
          <button type="submit" className="tw-btn-primary">
            连接审片室
          </button>
        </form>
      </div>
    );
  }
  if (bootState === "error") {
    return (
      <div className="tw-center-state">
        <div className="tw-dialog-card">
          <h2>连接失败</h2>
          <p>{bootError}</p>
          <button type="button" className="tw-btn-primary" onClick={() => void bootstrap()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (!projects.length || !model) {
    return (
      <div className="tw-center-state">
        <div className="tw-dialog-card">
          <h2>暂无可审阅项目</h2>
          <p>请在制作主机导入素材并完成同步后再开启团队审阅。</p>
          <button type="button" className="tw-btn-secondary" onClick={() => void bootstrap()}>
            刷新
          </button>
        </div>
      </div>
    );
  }

  const multicamTake = multicamGroupId ? model.take_groups.find((t) => t.group_id === multicamGroupId) ?? null : null;
  const currentIndex = selectedTake ? filteredTakes.findIndex((t) => t.group_id === selectedTake.group_id) : -1;
  const selectedSlate = selectedTake ? slateFacts.get(selectedTake.group_id) : undefined;
  const selectedScriptCtx = selectedTake ? takeScriptContext(selectedTake, blocksById) : null;
  const speechSegments =
    angleSpeech?.status === "available" && activeAngle
      ? angleSpeech.segments.filter((s) => {
          const { start, end } = angleSourceWindow(activeAngle);
          return s.text.trim() && s.start < end && s.end > start;
        })
      : [];

  return (
    <div className="tw-shell">
      <header className="tw-topbar">
        <div className="tw-brand">
          <strong>镜序 · 团队审阅</strong>
          {projects.length > 1 ? (
            <select
              aria-label="切换项目"
              value={projectId}
              onChange={(e) => {
                const nextId = e.target.value;
                setProjectId(nextId);
                void loadProjectData(workspaceId, nextId);
              }}
            >
              {projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.name || p.project || p.project_id}
                </option>
              ))}
            </select>
          ) : (
            <span className="tw-project-name">{model.project?.name || projectId}</span>
          )}
          <span className="tw-progress-pill" title="我的审阅进度">
            已判断 {progress.reviewed}/{progress.total}
          </span>
        </div>

        <div className={`tw-topbar-center${mobileFilterOpen ? " is-open" : ""}`}>
          {hasScript ? (
            <div className="tw-segmented" role="group" aria-label="审阅模式">
              <button type="button" aria-pressed={mode === "coverage"} onClick={() => setMode("coverage")}>
                剧本对照
              </button>
              <button type="button" aria-pressed={mode === "watch"} onClick={() => setMode("watch")}>
                逐条看片
              </button>
            </div>
          ) : null}
          <input
            type="search"
            className="tw-search"
            aria-label="搜索台词、场号或文件名"
            placeholder="搜台词、场号或文件名"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="筛选素材" value={filter} onChange={(e) => setFilter(e.target.value as ReviewFilter)}>
            <option value="all">全部状态</option>
            <option value="my_unreviewed">我未判断</option>
            <option value="team_opinions">有团队意见</option>
            <option value="team_conflict">团队有分歧</option>
            <option value="slate_usable">场记可用</option>
          </select>
          <button
            type="button"
            className={`tw-btn-secondary${hideNg ? " is-active" : ""}`}
            aria-pressed={hideNg}
            onClick={() => setHideNg((v) => !v)}
          >
            隐藏场记 NG
          </button>
        </div>

        <div className="tw-topbar-right">
          <button
            type="button"
            className="tw-btn-secondary tw-mobile-filter-btn"
            aria-expanded={mobileFilterOpen}
            onClick={() => setMobileFilterOpen((v) => !v)}
          >
            筛选
          </button>
          <span className={`tw-collab-dot${collabOnline ? "" : " is-offline"}`}>
            {collabOnline ? "已同步" : "重连中"}
          </span>
          <button type="button" className="tw-btn-secondary tw-theme-btn" onClick={toggleTheme} title="切换深浅主题">
            {theme === "dark" ? "浅色" : "深色"}
          </button>
          <button type="button" className="tw-btn-secondary" onClick={() => setNicknameOpen(true)}>
            {me?.nickname ? `${me.nickname}${me.role === "viewer" ? " (只读)" : ""}` : "设置昵称"}
          </button>
        </div>
      </header>

      {mode === "coverage" && hasScript ? (
        <main className="tw-coverage-layout">
          <aside className={`tw-script-rail${scriptDrawerOpen ? " is-open" : ""}`} aria-label="剧本大纲">
            <div className="tw-episode-tabs">
              {model.episodes.map((ep) => (
                <button
                  key={ep.episode}
                  type="button"
                  className={activeEpisode === ep.episode ? "is-active" : ""}
                  onClick={() => {
                    setActiveEpisode(ep.episode);
                    const first = ep.scenes?.[0]?.script_blocks?.find((b) => b.type !== "scene_heading");
                    if (first) setActiveSegmentId(first.segment_id);
                  }}
                >
                  第{ep.episode}集
                </button>
              ))}
            </div>
            <div className="tw-script-list">
              {(model.episodes.find((e) => e.episode === activeEpisode) ?? model.episodes[0])?.scenes.map((scene) => (
                <section key={scene.scene_id} className="tw-script-scene">
                  <h4>{scene.heading || scene.scene_id}</h4>
                  {scene.script_blocks
                    .filter((b) => b.type !== "scene_heading")
                    .map((blk) => {
                      const relatedCount = projection?.relatedTakeIds.get(blk.segment_id)?.length ?? 0;
                      return (
                        <button
                          key={blk.segment_id}
                          type="button"
                          className={`tw-script-line${activeSegmentId === blk.segment_id ? " is-active" : ""}`}
                          onClick={() => {
                            setActiveSegmentId(blk.segment_id);
                            setScriptDrawerOpen(false);
                          }}
                        >
                          <span className="tw-line-text">{blk.text || blk.raw_text}</span>
                          {relatedCount > 0 ? <span className="tw-line-count">{relatedCount}</span> : null}
                        </button>
                      );
                    })}
                </section>
              ))}
            </div>
          </aside>

          <section className="tw-coverage-main">
            {activeBlock ? (
              <div className="tw-active-script-bar">
                <button
                  type="button"
                  className="tw-btn-secondary tw-mobile-script-btn"
                  onClick={() => setScriptDrawerOpen((v) => !v)}
                >
                  {scriptDrawerOpen ? "收起剧本" : "选剧本句"}
                </button>
                <p>{activeBlock.text || activeBlock.raw_text}</p>
                <span>{filteredTakes.length} 条</span>
              </div>
            ) : null}

            <div className="tw-coverage-cards">
              {filteredTakes.map((take) => {
                const slate = slateFacts.get(take.group_id);
                const isExpanded = Boolean(expandedComments[take.group_id]);
                return (
                  <article key={take.group_id} className="tw-take-card">
                    <header className="tw-take-card-head">
                      <div className="tw-take-title">
                        <strong>Take #{take.take_index || 1}</strong>
                        {slate?.take?.status && slate.take.status !== "unmarked" ? (
                          <span className={`tw-slate-pill is-${slate.take.status}`}>
                            场记 {slateLabels[slate.take.status]}
                          </span>
                        ) : null}
                      </div>
                      <div className="tw-take-actions">
                        {take.angles.length > 1 ? (
                          <button
                            type="button"
                            className="tw-btn-secondary"
                            onClick={() => setMulticamGroupId(take.group_id)}
                          >
                            多机位同看
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="tw-btn-secondary"
                          onClick={() => {
                            selectTakeAndAngle(take);
                            setMode("watch");
                          }}
                        >
                          大屏审片
                        </button>
                      </div>
                    </header>

                    <div className="tw-camera-strip">
                      {take.angles.map((angle) => (
                        <TeamVideoFrame
                          key={angle.clip_id}
                          angle={angle}
                          mediaUrl={teamMediaUrl(workspaceId, projectId, angle.clip_id)}
                          slateStatus={slate?.angles.get(angle.clip_id)?.status}
                          onSelect={() => {
                            selectTakeAndAngle(take, angle.clip_id);
                            setMode("watch");
                          }}
                        />
                      ))}
                    </div>

                    {take.transcript?.text ? <p className="tw-transcript">{take.transcript.text}</p> : null}

                    <TeamCompactDecisionBar
                      workspaceId={workspaceId}
                      projectId={projectId}
                      take={take}
                      segmentId={activeSegmentId}
                      actor={me?.nickname || ""}
                      canWrite={Boolean(canWrite)}
                      expanded={isExpanded}
                      onToggleExpand={() =>
                        setExpandedComments((prev) => ({ ...prev, [take.group_id]: !prev[take.group_id] }))
                      }
                      onRequestNickname={() => setNicknameOpen(true)}
                      onUpdated={() => loadProjectData(workspaceId, projectId, true)}
                    />

                    {isExpanded ? (
                      <TeamOpinionDrawer
                        workspaceId={workspaceId}
                        projectId={projectId}
                        take={take}
                        segmentId={activeSegmentId}
                        activeAngle={take.angles[0] ?? null}
                        actor={me?.nickname || ""}
                        canWrite={Boolean(canWrite)}
                        onRequestNickname={() => setNicknameOpen(true)}
                        onUpdated={() => loadProjectData(workspaceId, projectId, true)}
                        onSeekTo={(clipId, sourceTime) => {
                          selectTakeAndAngle(take, clipId, sourceTime);
                          setMode("watch");
                        }}
                      />
                    ) : null}
                  </article>
                );
              })}
              {filteredTakes.length === 0 ? <div className="tw-empty-box">当前筛选下没有匹配的素材组</div> : null}
            </div>
          </section>
        </main>
      ) : (
        <main className="tw-watch-layout">
          <aside className={`tw-watch-queue${mobileQueueOpen ? " is-open" : ""}`} aria-label="Take 队列">
            {filteredTakes.map((take, idx) => {
              const collab = takeCollaborationSummary(take);
              const active = selectedTake?.group_id === take.group_id;
              return (
                <button
                  key={take.group_id}
                  type="button"
                  className={`tw-queue-row${active ? " is-active" : ""}`}
                  onClick={() => {
                    selectTakeAndAngle(take);
                    setMobileQueueOpen(false);
                  }}
                >
                  <div className="tw-queue-row-top">
                    <strong>Take #{take.take_index || idx + 1}</strong>
                    <span>{formatClock(take.duration)}</span>
                  </div>
                  <p>{take.transcript?.text || take.angles.map((a) => a.name).join(" / ")}</p>
                  {collab.summaryText ? (
                    <small className={collab.hasConflict ? "is-conflict" : ""}>{collab.summaryText}</small>
                  ) : null}
                </button>
              );
            })}
          </aside>

          <section className="tw-watch-stage">
            {selectedTake && activeAngle ? (
              <>
                <div className="tw-watch-context">
                  <div className="tw-watch-context-top">
                    <button
                      type="button"
                      className="tw-btn-secondary tw-mobile-queue-btn"
                      onClick={() => setMobileQueueOpen((v) => !v)}
                    >
                      {mobileQueueOpen ? "收起选条" : `选条 (${currentIndex + 1}/${filteredTakes.length})`}
                    </button>
                    <strong>Take #{selectedTake.take_index || currentIndex + 1}</strong>
                    {selectedSlate?.take?.scene || selectedSlate?.take?.shot ? (
                      <span className="tw-context-coord">
                        {selectedSlate.take.episode ? `${selectedSlate.take.episode}集 · ` : ""}
                        {selectedSlate.take.scene ? `${selectedSlate.take.scene}场 · ` : ""}
                        {selectedSlate.take.shot ? `${selectedSlate.take.shot}镜` : ""}
                      </span>
                    ) : null}
                    {selectedSlate?.take?.status && selectedSlate.take.status !== "unmarked" ? (
                      <span className={`tw-slate-pill is-${selectedSlate.take.status}`}>
                        场记 {slateLabels[selectedSlate.take.status]}
                      </span>
                    ) : null}
                  </div>
                  {selectedScriptCtx ? <p className="tw-watch-script-line">{selectedScriptCtx.text}</p> : null}
                </div>

                <div className="tw-player-wrap">
                  <video
                    ref={playerRef}
                    key={activeAngle.clip_id}
                    src={teamMediaUrl(workspaceId, projectId, activeAngle.clip_id)}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (pendingSeek !== null) {
                        video.currentTime = Math.min(pendingSeek, video.duration || pendingSeek);
                        setPendingSeek(null);
                      }
                    }}
                    onTimeUpdate={(event) => setPlayerTime(event.currentTarget.currentTime)}
                  />
                </div>

                <div className="tw-player-bar">
                  <div className="tw-angle-tabs">
                    {selectedTake.angles.map((angle) => {
                      const cam = cameraPresentation(angle.camera);
                      return (
                        <button
                          key={angle.clip_id}
                          type="button"
                          data-camera-tone={cam.tone}
                          className={angle.clip_id === activeAngle.clip_id ? "is-active" : ""}
                          onClick={() => switchAngleSynced(angle)}
                        >
                          {cam.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="tw-transport-btns">
                    {selectedTake.angles.length > 1 ? (
                      <button
                        type="button"
                        className="tw-btn-secondary"
                        onClick={() => setMulticamGroupId(selectedTake.group_id)}
                      >
                        多机位同看
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="tw-btn-secondary"
                      disabled={currentIndex <= 0}
                      onClick={() => currentIndex > 0 && selectTakeAndAngle(filteredTakes[currentIndex - 1])}
                    >
                      上一条
                    </button>
                    <button
                      type="button"
                      className="tw-btn-secondary"
                      disabled={currentIndex < 0 || currentIndex >= filteredTakes.length - 1}
                      onClick={() =>
                        currentIndex >= 0 &&
                        currentIndex < filteredTakes.length - 1 &&
                        selectTakeAndAngle(filteredTakes[currentIndex + 1])
                      }
                    >
                      下一条
                    </button>
                  </div>
                </div>

                {angleNotice ? <p className="tw-angle-notice">{angleNotice}</p> : null}

                {speechSegments.length > 0 ? (
                  <div className="tw-speech-strip" aria-label="实拍对白时码直跳">
                    {speechSegments.slice(0, 12).map((seg, idx) => (
                      <button
                        key={`${seg.start}-${idx}`}
                        type="button"
                        onClick={() => {
                          if (playerRef.current) playerRef.current.currentTime = seg.start;
                          setPlayerTime(seg.start);
                        }}
                      >
                        <time>{formatClock(seg.start)}</time>
                        <span>{seg.text}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <p className="tw-kbd-hint">Space 播停 · ↑↓ 切条 · 1-4 切机位 · B/K/X 表态 · M 多机位</p>
              </>
            ) : (
              <div className="tw-empty-box">请选择一条 Take 开始看片</div>
            )}
          </section>

          <aside className="tw-watch-sidebar">
            {selectedTake ? (
              <TeamOpinionDrawer
                workspaceId={workspaceId}
                projectId={projectId}
                take={selectedTake}
                segmentId={activeSegmentId}
                activeAngle={activeAngle}
                currentSourceTime={playerTime}
                actor={me?.nickname || ""}
                canWrite={Boolean(canWrite)}
                onRequestNickname={() => setNicknameOpen(true)}
                onUpdated={() => loadProjectData(workspaceId, projectId, true)}
                onSeekTo={(clipId, sourceTime) => {
                  if (clipId && selectedTake.angles.some((a) => a.clip_id === clipId)) {
                    setSelectedClipId(clipId);
                  }
                  if (sourceTime !== undefined) {
                    setPendingSeek(sourceTime);
                    if (playerRef.current && (!clipId || clipId === activeAngle?.clip_id)) {
                      playerRef.current.currentTime = sourceTime;
                    }
                  }
                }}
              />
            ) : null}
          </aside>
        </main>
      )}

      {multicamTake ? (
        <TeamMulticamModal
          workspaceId={workspaceId}
          projectId={projectId}
          take={multicamTake}
          initialClipId={selectedClipId}
          initialTime={playerTime}
          onClose={() => setMulticamGroupId(null)}
          onWatchAngle={(clipId, time) => {
            selectTakeAndAngle(multicamTake, clipId, time);
            setMode("watch");
          }}
        />
      ) : null}

      {nicknameOpen ? (
        <div className="tw-modal-backdrop" role="dialog" aria-modal="true" aria-label="设置审阅人昵称">
          <form className="tw-dialog-card" onSubmit={(e) => void handleNicknameSubmit(e)}>
            <h2>设置审阅人昵称</h2>
            <p>团队成员会看到你的昵称与审阅意见，仅用于本工作区协作显示。</p>
            <input
              type="text"
              value={nicknameDraft}
              autoFocus
              maxLength={40}
              placeholder="例如：导演 / 制片 / 小王"
              onChange={(e) => setNicknameDraft(e.target.value)}
            />
            <div className="tw-dialog-actions">
              {me?.nickname ? (
                <button type="button" className="tw-btn-secondary" onClick={() => setNicknameOpen(false)}>
                  取消
                </button>
              ) : null}
              <button type="submit" className="tw-btn-primary" disabled={!nicknameDraft.trim()}>
                保存
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {toast ? (
        <div className="tw-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
