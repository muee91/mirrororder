import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectSummary,
  ReviewAngle,
  ReviewScene,
  ReviewScriptBlock,
  ReviewTakeGroup,
} from "../../api/host";
import {
  ProductionClient,
  type SlateBoard,
  type SlateStatus,
} from "../../api/production";
import { SemanticSearchClient, type SemanticSearchPayload } from "../../api/semantic";
import { DesktopClient } from "../../api/desktop";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import { takeCameraSlots, takeDisplayLabel } from "../material-script/TakeCard";
import { projectionOf } from "../material-script/model";
import { TakeInspector, takePlaybackBounds } from "../material-script/TakeInspector";
import { useReviewModelSnapshot } from "../material-script/useReviewModelSnapshot";
import { isPlaceableScriptBlock } from "../script/scriptSemantics";
import { evidenceLocation, type EvidenceReference } from "../production/evidenceLocation";
import type { ProductionNavigationIntent, ProductionSelectionContext } from "../production/productionNavigation";
import { cameraPresentation } from "../media/cameraPresentation";
import { canPreviewReviewPlayback } from "../media/mediaPlaybackProjection";
import { StudioIcon } from "../../components/StudioIcons";
import { adjacentPaperSceneContext, deriveSlateTakeFields, prettySceneId } from "../slate/slateTakeFields";
import { ReviewCoverageCards } from "./ReviewCoverageCards";
import { ReviewScriptOutline } from "./ReviewScriptOutline";
import { ReviewMulticamMonitor } from "./ReviewMulticamMonitor";
import { ReviewCompareDialog } from "./ReviewCompareDialog";
import { ReviewQueueRow } from "./ReviewQueueRow";
import { ReviewAngleStatus, ReviewFootageStatus, ReviewSlateReference } from "./ReviewFootageStatus";
import { finalDecision, indexReviewSlates, matchesSlateStatus, slateLabels, type ReviewSlateFacts, type SlateReadState } from "./reviewFootageFacts";
import { ReviewDecisionPanel } from "./ReviewDecisionPanel";
import { indexReviewHits, isLocatedReviewHit, reviewExcerpt, reviewFragments, ReviewAngleFrame, ReviewEvidenceHit, sameReviewEvidence, type ReviewFragment } from "./ReviewFragmentList";
import { reviewTakeAttention } from "./reviewAttention";
import { browseEpisodeIds, isScriptSpeechHit, normalizedQuery } from "./reviewFinderEvidence";
import { scriptSpeechClauses, spokenScriptText } from "../material-script/scriptSpeech";
import { reviewLocationText, reviewMasterOffset } from "./reviewLocation";
import {
  compareReviewStory, compareReviewTakeNumber, reviewSceneHeading, reviewTakePlaces,
  type ReviewSortOrder, type ReviewTakeFields, type ReviewTakePlace,
} from "./reviewQueueOrder";
import "../material-script/material-script.css";
import "./review-workspace.css";
import "./review-coverage.css";

type ReviewQueueFilter =
  | "all"
  | "unreviewed"
  | "attention"
  | `slate_${SlateStatus}`
  | "slate_missing"
  | "best"
  | "keep"
  | "reject";
type SearchScope = "all" | "speech" | "visual";
type ResultView = "take" | "fragment";
const COMPARISON_LIMIT = 2;

type FinderState = {
  mode: "coverage" | "watch" | null;
  recovery: "episode" | "all" | null;
  outlineEpisode: number | null;
  watchedFromLine?: { groupId: string; segmentId: string };
  coverageScope?: { segmentId: string | null; recovery: "episode" | "all" | null };
  outlineQuery: string;
  onlyMissing: boolean;
  filter: ReviewQueueFilter;
  query: string;
  searchScope: SearchScope;
  viewPreference: ResultView | null;
  takeViewQuery: string | null;
  episode: number | null;
  includeEpisodeCandidates: boolean;
  hideNg: boolean;
  showScriptRail: boolean;
  sortPreference: ReviewSortOrder | null;
  activeScene: { episode: number; sceneId: string } | null;
  activeSegmentId: string | null;
  unmappedActive: boolean;
  comparisonIds: string[];
};

const INITIAL_FINDER: FinderState = {
  mode: null, recovery: null, outlineEpisode: null, outlineQuery: "", onlyMissing: false,
  filter: "all", query: "", searchScope: "all", viewPreference: null, takeViewQuery: null,
  episode: null, includeEpisodeCandidates: false, hideNg: false, showScriptRail: false, activeSegmentId: null,
  sortPreference: null, activeScene: null, unmappedActive: false, comparisonIds: [],
};

type ReviewLookup = { key: string; payload?: SemanticSearchPayload; pending?: boolean; failed?: boolean };
type ReviewPreview = {
  reference?: EvidenceReference;
  nonce: number;
  autoplay: boolean;
  bounded?: boolean;
  fragmentId?: string;
  resume?: ProductionSelectionContext;
};

export interface ReviewSession {
  snapshot?: {
    finder: FinderState;
    lookup?: ReviewLookup;
    appliedIntent?: number;
    queueScrollTop?: number;
    queueRowHeights: Map<string, number>;
    takePositions: Map<string, ProductionSelectionContext>;
    monitor?: {
      location: ProductionSelectionContext;
      focus?: ProductionSelectionContext;
      preview: ReviewPreview;
      preferredCamera: string;
    };
  };
  currentLocation?: () => ProductionSelectionContext;
}

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  syncTimeline?: MulticamSyncTimeline;
  initialGroupId?: string | null;
  initialClipId?: string | null;
  playbackFocus?: ProductionSelectionContext;
  focusIntent?: ProductionNavigationIntent | null;
  session?: ReviewSession;
  onSelectionChange?: (groupId: string | null, clipId: string | null) => void;
  onOpenMaterial?: (groupId: string, clipId?: string | null, location?: ProductionSelectionContext) => void;
  onOpenSlate?: (groupId: string, clipId?: string | null, recordId?: string) => void;
  onOpenScript?: (groupId: string, clipId?: string | null, location?: ProductionSelectionContext) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null, location?: ProductionSelectionContext) => void;
  onOpenRepair?: () => void;
  onOpenEvidence?: (reference: EvidenceReference) => void;
  showRoughCut?: boolean;
}

const FILTERS: Array<{ value: ReviewQueueFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "unreviewed", label: "未决定" },
  { value: "attention", label: "需关注" },
  { value: "best", label: "首选" },
  { value: "keep", label: "保留" },
  { value: "reject", label: "废弃" },
];

export function scriptBlockBadge(block: ReviewScriptBlock): string {
  return block.speaker || (
    block.type === "action" ? "动作" : block.type === "narration" ? "旁白" : "对白"
  );
}

type TakeFields = Pick<ReviewTakeFields, "episode" | "scene" | "shot" | "take_number">;

function slateCoordinates(record: TakeFields | null | undefined, insideScene = false): string {
  if (!record) return "";
  return [
    record.episode && !insideScene ? `${record.episode}集` : "",
    record.scene && !insideScene ? `${record.scene}场` : "",
    record.shot ? `${record.shot}镜` : "",
    record.take_number ? `${record.take_number}次` : "",
  ].filter(Boolean).join(" · ");
}

function sameShotKey(fields?: TakeFields): string {
  const scene = normalizedQuery(fields?.scene ?? "");
  const shot = normalizedQuery(fields?.shot ?? "");
  return fields?.episode && scene && shot ? JSON.stringify([fields.episode, scene, shot]) : "";
}

const SCENE_TERM = /^(?:场)?(\d+-\d+[a-z]?)(?:场)?$/;

function coordinateTerm(term: string): [keyof TakeFields, string] | null {
  const scene = SCENE_TERM.exec(term)?.[1];
  if (scene) return ["scene", scene];
  const suffix = /^(?:第)?(\d+[a-z]?)(集|场|镜|次)$/.exec(term);
  const prefix = /^(场|镜|次)(\d+[a-z]?)$/.exec(term);
  const fields = { 集: "episode", 场: "scene", 镜: "shot", 次: "take_number" } as const;
  const unit = (suffix?.[2] ?? prefix?.[1]) as keyof typeof fields | undefined;
  const value = suffix?.[1] ?? prefix?.[2];
  return unit && value ? [fields[unit], value] : null;
}

function takeSearchText(
  take: ReviewTakeGroup,
  facts: ReviewSlateFacts | undefined,
  fields: TakeFields | null,
  scriptText: string,
): string {
  return normalizedQuery([
    take.transcript.text,
    fields?.episode && `第${fields.episode}集 ${fields.episode}集`,
    fields?.scene && `${fields.scene} ${fields.scene}场 场${fields.scene}`,
    fields?.shot && `${fields.shot}镜 镜${fields.shot}`,
    fields?.take_number && `第${fields.take_number}次 ${fields.take_number}次`,
    facts?.take?.note,
    facts?.take && slateLabels[facts.take.status],
    ...Array.from(facts?.angles.values() ?? [], angle => [angle.note, angle.status && slateLabels[angle.status], angle.preferred && "场记首选机位"].filter(Boolean).join(" ")),
    scriptText,
    ...take.angles.flatMap((angle) => [angle.name, angle.camera]),
  ].filter(Boolean).join(" "));
}

function reviewTakeLabel(
  take: ReviewTakeGroup,
  needsSequentialTakeNumbers: boolean,
  takeSequenceByGroupId: Map<string, number>,
): string {
  if (!needsSequentialTakeNumbers) return takeDisplayLabel(take);
  const sequence = takeSequenceByGroupId.get(take.group_id) ?? 1;
  const clipStem = take.angles[0]?.name?.replace(/\.[^.]+$/, "").trim();
  return clipStem ? `Take #${sequence} · ${clipStem}` : `Take #${sequence}`;
}

function preferredAngle(take: ReviewTakeGroup, cameraKey = ""): ReviewAngle | undefined {
  const sameCamera = cameraKey ? take.angles.filter((angle) => cameraPresentation(angle.camera).key === cameraKey) : [];
  return sameCamera.find((angle) => canPreviewReviewPlayback(angle.playback))
    ?? take.angles.find((angle) => canPreviewReviewPlayback(angle.playback)) ?? sameCamera[0] ?? take.angles[0];
}

function cameraAngleLabel(angle: ReviewAngle, angles: ReviewAngle[]): string {
  const camera = cameraPresentation(angle.camera);
  const clips = angles.filter((item) => cameraPresentation(item.camera).key === camera.key);
  return clips.length > 1 ? `${camera.label} ${clips.indexOf(angle) + 1}` : camera.label;
}

export function ReviewWorkspace({
  baseUrl,
  project,
  syncTimeline,
  initialGroupId = null,
  initialClipId = null,
  playbackFocus,
  focusIntent,
  session,
  onSelectionChange,
  onOpenMaterial,
  onOpenSlate,
  onOpenScript,
  onOpenTimeline,
  onOpenRepair,
  onOpenEvidence,
  showRoughCut = false,
}: Props) {
  const { connection, loadState, message, model, refresh, retryLoad } =
    useReviewModelSnapshot(baseUrl, project.project_id);
  const saved = session?.snapshot;
  const savedMonitor = saved?.monitor;
  const initializedOutline = useRef(Boolean(saved));
  const [multicam, setMulticam] = useState<{ groupId: string; clipId?: string; time?: number } | null>(null);
  const slateSource = JSON.stringify([baseUrl, project.project_id]);
  const [slateResult, setSlateResult] = useState<{ source: string; board: SlateBoard | null }>();
  const slateBoard = slateResult?.source === slateSource ? slateResult.board : null;
  const slateReadState: SlateReadState = slateResult?.source !== slateSource ? "loading" : slateBoard ? "ready" : "error";
  const [finder, setFinder] = useState(saved?.finder ?? INITIAL_FINDER);
  const { filter, query, searchScope, viewPreference, takeViewQuery, episode, includeEpisodeCandidates, hideNg,
    activeScene, activeSegmentId, sortPreference, unmappedActive, comparisonIds, showScriptRail } = finder;
  function updateFinder(values: Partial<FinderState>) {
    setFinder((previous) => ({ ...previous, ...values }));
  }
  const needle = normalizedQuery(query);
  const terms = useMemo(() => needle.split(/\s+/), [needle]);
  const coordinates = useMemo(() => terms.map(coordinateTerm).filter((term) => term !== null), [terms]);
  const contentQuery = coordinates.length ? terms.filter((term) => !coordinateTerm(term)).join(" ") : needle;
  const firstBlock = useMemo(() => model?.episodes.flatMap((entry) => entry.scenes)
    .flatMap((scene) => scene.script_blocks).find(isPlaceableScriptBlock), [model]);
  const hasScript = Boolean(firstBlock);
  const isCoverage = hasScript && (finder.mode ?? (focusIntent?.groupId || playbackFocus?.sourceRange ? "watch" : "coverage")) === "coverage";
  const resultView = isCoverage ? "take" : takeViewQuery === needle ? "take" : viewPreference ?? (contentQuery && onOpenEvidence ? "fragment" : "take");
  const filenameQuery = searchScope === "all" && /^[a-z\d][a-z\d._-]*$/i.test(contentQuery) && /\d/.test(contentQuery);
  const [semanticRequest, setSemanticRequest] = useState<{ query: string } | null>(null);
  const [lookup, setLookup] = useState<ReviewLookup | undefined>(saved?.lookup);
  const searchClient = useMemo(() => new SemanticSearchClient(baseUrl), [baseUrl]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    savedMonitor?.location.groupId ?? initialGroupId,
  );
  const [selectedClipId, setSelectedClipId] = useState<string | null>(
    savedMonitor?.location.clipId ?? initialClipId,
  );
  const [pendingScriptSeek, setPendingScriptSeek] = useState<string | null>(null);
  const [angleNotice, setAngleNotice] = useState("");
  const [fragmentFocus, setFragmentFocus] = useState(savedMonitor ? savedMonitor.focus : playbackFocus);
  const [preview, setPreview] = useState<ReviewPreview | undefined>(savedMonitor?.preview);
  const [revealedTakeId, setRevealedTakeId] = useState<string | null>(null);
  const [monitorGroupId, setMonitorGroupId] = useState<string | null>(savedMonitor?.location.groupId ?? initialGroupId);
  const [copyState, setCopyState] = useState("");
  const [copyPending, setCopyPending] = useState(false);
  const appliedIntent = useRef(saved?.appliedIntent);
  const captureSession = useRef<(() => void) | undefined>(undefined);
  const selectedCard = useRef<HTMLElement>(null);
  const scrollToSelection = useRef(false);
  const queueList = useRef<HTMLDivElement>(null);
  const queueId = useId();
  const focusQueueRow = useRef<number | null>(null);
  const [queueRowHeights] = useState(() => saved?.queueRowHeights ?? new Map<string, number>());
  const restoreScrollTop = useRef(saved?.queueScrollTop);
  const player = useRef<HTMLVideoElement>(null);
  const presentedFrame = useRef<number | null>(null);
  const bindPlayer = useCallback((video: HTMLVideoElement | null) => {
    player.current = video;
    presentedFrame.current = null;
    if (!video || typeof video.requestVideoFrameCallback !== "function") return;
    // WebKit's clock can stop at its previous update while the compositor
    // presents several more frames. Remember what the editor actually paused on.
    let played = !video.paused;
    const onPlay = () => { played = true; };
    const onSeek = () => { played = !video.paused; presentedFrame.current = null; };
    const frame: VideoFrameRequestCallback = (_, metadata) => {
      if (player.current !== video) return;
      if (played && !video.seeking) presentedFrame.current = metadata.mediaTime;
      callback = video.requestVideoFrameCallback(frame);
    };
    let callback = video.requestVideoFrameCallback(frame);
    video.addEventListener("play", onPlay);
    video.addEventListener("seeking", onSeek);
    return () => {
      video.cancelVideoFrameCallback(callback);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("seeking", onSeek);
      player.current = null;
      presentedFrame.current = null;
    };
  }, []);
  const playbackNonce = useRef(savedMonitor?.preview.nonce ?? 0);
  const preferredCamera = useRef(savedMonitor?.preferredCamera ?? "");
  const [takePositions] = useState(() => saved?.takePositions ?? new Map<string, ProductionSelectionContext>());
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void new ProductionClient(baseUrl).scriptSupervisor(project.project_id)
      .then((board) => {
        if (active) setSlateResult({ source: slateSource, board });
      }).catch(() => {
        if (active) setSlateResult({ source: slateSource, board: null });
      });
    return () => {
      active = false;
    };
  }, [baseUrl, project.project_id, slateSource]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const takesById = useMemo(() => new Map(model?.take_groups.map((take) => [take.group_id, take])), [model]);

  const { facts: slateFacts, coordinates: slateByGroup } = useMemo(
    () => indexReviewSlates(model?.take_groups ?? [], slateBoard), [model, slateBoard]);

  const slateSuggestions = useMemo(() => {
    if (!model) return new Map<string, ReturnType<typeof deriveSlateTakeFields>>();
    const paper = slateBoard?.paper_suggestions;
    const context = adjacentPaperSceneContext(model, paper);
    return new Map(model.take_groups.filter((take) => !slateByGroup.has(take.group_id))
      .map((take) => [take.group_id, deriveSlateTakeFields(model, take, paper, context)]));
  }, [model, slateBoard?.paper_suggestions, slateByGroup]);

  const fieldsById = useMemo<ReadonlyMap<string, ReviewTakeFields>>(
    () => new Map<string, ReviewTakeFields>([...slateSuggestions, ...slateByGroup]),
    [slateByGroup, slateSuggestions],
  );
  const placesById = useMemo(() => model ? reviewTakePlaces(model, fieldsById) : new Map<string, ReviewTakePlace>(), [model, fieldsById]);
  const episodesByTake = useMemo(() => new Map((model?.take_groups ?? []).map((take) => [
    take.group_id, browseEpisodeIds(take, fieldsById.get(take.group_id)?.episode, includeEpisodeCandidates),
  ])), [fieldsById, includeEpisodeCandidates, model]);

  const projection = useMemo(
    () => model ? projectionOf(model) : null,
    [model],
  );
  const scriptBlocksById = useMemo(() => {
    const blocks = new Map<string, ReviewScriptBlock>();
    for (const ep of model?.episodes ?? []) {
      for (const scene of ep.scenes) {
        for (const block of scene.script_blocks) blocks.set(block.segment_id, block);
      }
    }
    return blocks;
  }, [model]);
  function recoveryForBlock(block: ReviewScriptBlock): FinderState["recovery"] {
    if (!model?.take_groups.length || projection?.relatedTakeIds.has(block.segment_id)) return null;
    const inEpisode = model.take_groups.some((take) => browseEpisodeIds(take, fieldsById.get(take.group_id)?.episode, true).has(block.episode));
    return inEpisode ? "episode" : "all";
  }

  useEffect(() => {
    if (!model || initializedOutline.current) return;
    initializedOutline.current = true;
    if (!isCoverage || !firstBlock) return;
    const block = scriptBlocksById.get(playbackFocus?.scriptSegmentId ?? "") ?? firstBlock;
    updateFinder({ mode: "coverage", recovery: recoveryForBlock(block), outlineEpisode: block.episode, activeSegmentId: block.segment_id,
      activeScene: { episode: block.episode, sceneId: block.scene_id } });
  }, [firstBlock, isCoverage, model, playbackFocus?.scriptSegmentId, scriptBlocksById]);
  const activeScriptBlock = scriptBlocksById.get(activeSegmentId ?? "");
  const episodeTerm = coordinates.find(([field]) => field === "episode");
  const sceneTerm = coordinates.find(([field]) => field === "scene")?.[1];
  const termEpisode = episodeTerm ? Number(episodeTerm[1]) : undefined;
  const sceneEpisode = sceneTerm ? model?.episodes.find((ep) =>
    ep.scenes.some((scene) => normalizedQuery(prettySceneId(scene.scene_id)) === sceneTerm))?.episode : undefined;
  const sortOptions: Array<{ value: ReviewSortOrder; label: string }> = [
    ...(contentQuery ? [{ value: "relevance" as const, label: "相关度" }] : []),
    ...(model?.episodes.length ? [{ value: "script" as const, label: "剧本顺序" }] : []),
    { value: "shooting", label: "拍摄顺序" },
    ...(filter === "attention" ? [{ value: "attention" as const, label: "关注优先" }] : []),
  ];
  const scriptBrowsing = Boolean(model?.episodes.length && (episode !== null || activeSegmentId || activeScene || coordinates.length));
  const defaultSort: ReviewSortOrder = filter === "attention" ? "attention"
    : contentQuery && (resultView === "fragment" || !scriptBrowsing) ? "relevance"
    : scriptBrowsing ? "script" : "shooting";
  const sortOrder = sortPreference && sortOptions.some(({ value }) => value === sortPreference) ? sortPreference : defaultSort;
  const scriptClauses = useMemo(() => scriptSpeechClauses(activeScriptBlock), [activeScriptBlock]);
  const scriptQuery = !contentQuery && scriptClauses.length && activeScriptBlock ? spokenScriptText(activeScriptBlock.text) : "";
  const scriptScoped = (groupId: string, scriptEpisode: number) => {
    const episodes = episodesByTake.get(groupId);
    return includeEpisodeCandidates || !episodes?.size || episodes.has(scriptEpisode);
  };

  const scriptTextByTake = useMemo(() => {
    const next = new Map<string, string>();
    for (const take of model?.take_groups ?? []) {
      const ids = [
        ...take.effective_mapping.script_segment_ids,
        ...take.context.script_segment_ids,
        ...take.candidates.flatMap((candidate) =>
          candidate.script_segment_ids ?? [candidate.script_segment_id]
        ),
      ];
      next.set(
        take.group_id,
        ids.map((id) => scriptBlocksById.get(id)).filter(Boolean).map((block) =>
          `${block?.speaker || ""} ${block?.text || ""}`
        ).join(" "),
      );
    }
    return next;
  }, [model, scriptBlocksById]);

  const textByTake = useMemo(() => new Map((model?.take_groups ?? []).map((take) => {
    const record = slateByGroup.get(take.group_id) ?? null;
    return [take.group_id, takeSearchText(take, slateFacts.get(take.group_id), record ?? slateSuggestions.get(take.group_id) ?? null,
      scriptTextByTake.get(take.group_id) ?? "")];
  })), [model, slateByGroup, slateFacts, slateSuggestions, scriptTextByTake]);

  const attentionTiers = useMemo(() => {
    const tiers = { blocking: 0, stale: 0, watch: 0 };
    for (const take of model?.take_groups ?? []) {
      const attention = reviewTakeAttention(take);
      if (attention.hasAttention) tiers[attention.tier] += 1;
    }
    return tiers;
  }, [model]);

  const eligibleTakes = useMemo(() => {
    if (!model) return [];
    const segmentTakeIds = activeSegmentId && !finder.recovery && projection
      ? new Set(projection.relatedTakeIds.get(activeSegmentId) ?? [])
      : null;
    return model.take_groups.filter((take) => {
      const facts = slateFacts.get(take.group_id);
      const fields = fieldsById.get(take.group_id);
      const place = placesById.get(take.group_id);
      if (coordinates.some(([field, value]) => field === "episode"
        ? !episodesByTake.get(take.group_id)?.has(Number(value))
        : normalizedQuery(field === "scene" ? place?.scene ?? "" : String(fields?.[field] ?? "")) !== value)) return false;
      if (filter === "attention" && !reviewTakeAttention(take).hasAttention) {
        return false;
      }
      if (filter === "slate_missing") {
        if (facts || slateReadState !== "ready") return false;
      } else if (filter.startsWith("slate_")) {
        if (!matchesSlateStatus(facts, filter.slice(6) as SlateStatus)) return false;
      } else if (filter !== "all" && filter !== "attention" && finalDecision(take).state !== filter) return false;
      if (
        episode !== null &&
        !episodesByTake.get(take.group_id)?.has(episode)
      ) return false;
      if (
        unmappedActive && take.effective_mapping.script_segment_ids.length > 0
      ) return false;
      if (activeScene && !activeSegmentId
        && (place?.episode !== activeScene.episode || place?.sceneId !== activeScene.sceneId)) return false;
      if (finder.recovery === "episode" && activeScriptBlock
        && !browseEpisodeIds(take, fields?.episode, true).has(activeScriptBlock.episode)) return false;
      if (segmentTakeIds && (!segmentTakeIds.has(take.group_id) || (!isCoverage && activeScriptBlock
        && !scriptScoped(take.group_id, activeScriptBlock.episode)))) return false;
      if (hideNg && facts?.take?.status === "ng") return false;
      return true;
    });
  }, [activeScene, activeScriptBlock, activeSegmentId, coordinates, episode, episodesByTake, fieldsById, filter,
    finder.recovery, hideNg, includeEpisodeCandidates, isCoverage, model, placesById, projection, slateFacts, slateReadState, unmappedActive]);

  const groupIds = useMemo(() => eligibleTakes.length === model?.take_groups.length
    ? undefined : eligibleTakes.map((take) => take.group_id), [eligibleTakes, model]);
  const lookupQuery = contentQuery || scriptQuery;
  const lookupScope = scriptQuery ? "speech" : searchScope;
  const searchKey = `${baseUrl}\n${project.project_id}\n${lookupScope}\n${activeSegmentId ?? ""}\n${lookupQuery}\n${groupIds?.join(",") ?? "*"}`;
  const lookupEnabled = Boolean((onOpenEvidence || scriptQuery) && lookupQuery && !filenameQuery && eligibleTakes.length);
  const currentLookup = lookup?.key === searchKey ? lookup : null;
  const searching = lookupEnabled && (!currentLookup || currentLookup.pending);
  const canRequestConfiguredSearch = contentQuery && lookupEnabled && currentLookup && !currentLookup.pending
    && currentLookup.payload?.summary.vector_available !== true;
  useEffect(() => {
    if (!lookupEnabled) return;
    const controller = new AbortController();
    const explicit = semanticRequest?.query === searchKey;
    const timer = window.setTimeout(() => {
      setLookup((previous) => ({ key: searchKey,
        payload: previous?.key === searchKey ? previous.payload : undefined, pending: true }));
      const sources = lookupScope === "all" ? ["speech", "visual", "slate"] : [lookupScope];
      const options = { limit: 60, sources, groupIds, signal: controller.signal };
      const request = explicit ? searchClient.searchCompute(project.project_id, lookupQuery, options)
        : searchClient.searchLocal(project.project_id, lookupQuery, options);
      void request.then((payload) => {
        if (!controller.signal.aborted) setLookup({ key: searchKey, payload });
      }).catch(() => {
        if (!controller.signal.aborted) setLookup((previous) => ({ key: searchKey,
          payload: previous?.key === searchKey ? previous.payload : undefined, failed: true }));
      });
    }, explicit ? 0 : 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [groupIds, lookupEnabled, lookupQuery, lookupScope, project.project_id, searchClient, searchKey, semanticRequest]);

  const hitsByGroup = useMemo(() => indexReviewHits(
    lookupEnabled ? (currentLookup?.payload?.results ?? []).filter((hit) => !scriptQuery || isScriptSpeechHit(hit, scriptClauses)) : [],
    takesById,
  ), [currentLookup?.payload, lookupEnabled, scriptClauses, scriptQuery, takesById]);
  const filteredTakes = useMemo(() => {
    const words = contentQuery.split(/\s+/);
    const priority = new Map<string, number>();
    if (isCoverage && activeScriptBlock?.type === "action" && !finder.recovery && !sortPreference && projection) {
      const id = activeScriptBlock.segment_id;
      for (const groupId of projection.dialogueByActionTake.get(id)?.keys() ?? []) priority.set(groupId, 2);
      for (const groupId of projection.candidateTakeIds.get(id) ?? []) priority.set(groupId, 1);
      for (const groupId of projection.mappedTakeIds.get(id) ?? []) priority.set(groupId, 0);
      for (const groupId of projection.confirmedActionTakeIds.get(id) ?? []) priority.set(groupId, -1);
    }
    return eligibleTakes.filter((take) => {
      if (
        contentQuery &&
        !hitsByGroup.has(take.group_id)
      ) {
        if (searchScope === "visual") return false;
        const searchable = searchScope === "speech" ? normalizedQuery(take.transcript.text) : textByTake.get(take.group_id);
        if (!words.every((term) => searchable?.includes(term))) return false;
      }
      return true;
    }).sort((left, right) => {
      const rank = (priority.get(left.group_id) ?? 3) - (priority.get(right.group_id) ?? 3);
      if (rank) return rank;
      const shooting = left.start - right.start;
      if (sortOrder === "script") return compareReviewStory(placesById.get(left.group_id), placesById.get(right.group_id),
        fieldsById.get(left.group_id), fieldsById.get(right.group_id)) || shooting;
      if (sortOrder === "attention") return reviewTakeAttention(right).priority - reviewTakeAttention(left).priority || shooting;
      if (sortOrder !== "relevance") return shooting;
      return (hitsByGroup.get(left.group_id)?.[0].rank ?? Number.MAX_SAFE_INTEGER)
        - (hitsByGroup.get(right.group_id)?.[0].rank ?? Number.MAX_SAFE_INTEGER) || shooting;
    });
  }, [activeScriptBlock, contentQuery, eligibleTakes, fieldsById, finder.recovery, hitsByGroup, isCoverage, placesById, projection, searchScope, sortOrder, sortPreference, textByTake]);

  const fragments = useMemo(() => {
    if (resultView !== "fragment") return [];
    const words = searchScope === "all" && contentQuery ? contentQuery.split(/\s+/) : [];
    function matchesFilename(angle: ReviewAngle): boolean {
      const filename = normalizedQuery(angle.name);
      return words.length > 0 && words.every((word) => filename.includes(word));
    }
    return reviewFragments(filteredTakes, hitsByGroup, matchesFilename, sortOrder, syncTimeline);
  }, [contentQuery, filteredTakes, hitsByGroup, resultView, searchScope, sortOrder, syncTimeline]);
  const resultCount = resultView === "fragment" ? fragments.length : filteredTakes.length;
  const selectedTake = takesById.get(selectedGroupId ?? "") ?? null;
  const incomingFocus = focusIntent?.projectId === project.project_id && focusIntent.nonce !== appliedIntent.current
    && takesById.has(focusIntent.groupId ?? "") ? focusIntent : null;
  const comparedTakes = comparisonIds.flatMap((id) => takesById.get(id) ?? []);
  const selectedSlate = selectedTake ? slateFacts.get(selectedTake.group_id) : undefined;
  const selectedSlateSuggestion = selectedTake ? slateSuggestions.get(selectedTake.group_id) : undefined;
  const selectedFields = fieldsById.get(selectedGroupId ?? "");
  const selectedPlace = placesById.get(selectedGroupId ?? "");
  const selectedShotKey = sameShotKey(selectedFields);
  const relatedShotTakes = useMemo(() => {
    if (!selectedShotKey || !model) return [];
    return model.take_groups.filter((take) => {
      if (take.group_id === selectedGroupId) return false;
      const record = slateFacts.get(take.group_id)?.take;
      if (hideNg && record?.status === "ng") return false;
      return sameShotKey(fieldsById.get(take.group_id)) === selectedShotKey;
    }).sort((left, right) => compareReviewTakeNumber(fieldsById.get(left.group_id), fieldsById.get(right.group_id))
      || left.start - right.start);
  }, [fieldsById, hideNg, model, selectedGroupId, selectedShotKey, slateFacts]);
  const canCompareShot = relatedShotTakes.length > 0 && (comparedTakes.length === 0
    || (comparedTakes.length === 1 && comparedTakes[0].group_id === selectedGroupId));
  const filteredIndex = filteredTakes.findIndex((take) => take.group_id === selectedGroupId);
  const comparing = (comparedTakes.length === COMPARISON_LIMIT || filteredIndex < 0)
    && comparisonIds.includes(selectedGroupId ?? "");
  const transportTakes = comparing ? comparedTakes : filteredTakes;
  const navigatingFragments = !comparing && resultView === "fragment";
  const selectedFragmentIndex = fragments.findIndex((fragment) => preview?.fragmentId === fragment.id
    || sameReviewEvidence(preview?.reference, fragment.reference));
  const selectedIndex = navigatingFragments ? selectedFragmentIndex
    : transportTakes.findIndex((take) => take.group_id === selectedGroupId);
  const transportCount = navigatingFragments ? fragments.length : transportTakes.length;
  // When a decision removes the current Take from a filtered list, keep the
  // picture and continue on either side of its former position.
  const lastQueueIndex = useRef<{ groupId: string; index: number } | null>(null);
  useLayoutEffect(() => {
    if (selectedGroupId && filteredIndex >= 0) lastQueueIndex.current = { groupId: selectedGroupId, index: filteredIndex };
  }, [filteredIndex, selectedGroupId]);
  const outsideQueue = Boolean(selectedTake && !comparing && !navigatingFragments && filteredIndex < 0);
  const insertionIndex = lastQueueIndex.current?.groupId === selectedGroupId
    ? Math.min(lastQueueIndex.current.index, transportCount) : 0;
  const previousIndex = outsideQueue ? insertionIndex - 1 : selectedIndex - 1;
  const nextIndex = outsideQueue ? insertionIndex : selectedIndex + 1;
  const selectedAttention = selectedTake
    ? reviewTakeAttention(selectedTake)
    : null;
  const activeAngle = selectedTake?.angles.find((item) => item.clip_id === selectedClipId) ?? selectedTake?.angles[0] ?? null;
  const activeAngleSlate = activeAngle ? selectedSlate?.angles.get(activeAngle.clip_id) : undefined;

  const { needsSequentialTakeNumbers, takeSequenceByGroupId } = useMemo(() => {
    const recordedIndices = new Set<number>();
    const sequenceByGroupId = new Map<string, number>();
    for (const [index, take] of (model?.take_groups ?? []).entries()) {
      sequenceByGroupId.set(take.group_id, index + 1);
      if (Number.isInteger(take.take_index) && take.take_index > 0) recordedIndices.add(take.take_index);
    }
    return {
      needsSequentialTakeNumbers: recordedIndices.size !== sequenceByGroupId.size,
      takeSequenceByGroupId: sequenceByGroupId,
    };
  }, [model]);
  const currentTakeLabel = selectedTake ? reviewTakeLabel(selectedTake, needsSequentialTakeNumbers, takeSequenceByGroupId) : "";

  useEffect(() => {
    if (!model || incomingFocus) return;
    if (!selectedTake) {
      setSelectedClipId(null);
      return;
    }
    if (
      !selectedClipId ||
      !selectedTake.angles.some((item) => item.clip_id === selectedClipId)
    ) setSelectedClipId(preferredAngle(selectedTake, preferredCamera.current)?.clip_id ?? null);
  }, [incomingFocus, model, selectedClipId, selectedTake]);

  useEffect(() => {
    if (!model || searching || incomingFocus) return;
    if (selectedGroupId && takesById.has(selectedGroupId)
      && (selectedGroupId === monitorGroupId || selectedGroupId === revealedTakeId
        || comparisonIds.includes(selectedGroupId) || filteredIndex >= 0)) return;
    const next = filteredTakes[0]?.group_id ?? null;
    if (next === selectedGroupId) return;
    setSelectedGroupId(next);
    setFragmentFocus(undefined);
    setPreview(undefined);
    setAngleNotice("");
  }, [comparisonIds, filteredIndex, filteredTakes, incomingFocus, model, monitorGroupId, revealedTakeId, searching, selectedGroupId, takesById]);

  useEffect(() => {
    if (!focusIntent || focusIntent.nonce === appliedIntent.current || focusIntent.projectId !== project.project_id) return;
    const take = takesById.get(focusIntent.groupId ?? "");
    if (!take) return;
    appliedIntent.current = focusIntent.nonce;
    updateFinder({ mode: "watch", ...(focusIntent.scriptSegmentId && scriptBlocksById.has(focusIntent.scriptSegmentId)
      ? { activeSegmentId: focusIntent.scriptSegmentId, recovery: null } : {}) });
    const angle = take.angles.find((item) => focusIntent.clipId ? item.clip_id === focusIntent.clipId : item.media_id === focusIntent.mediaId);
    setSelectedGroupId(take.group_id);
    setSelectedClipId(angle?.clip_id ?? preferredAngle(take, preferredCamera.current)?.clip_id ?? null);
    if (angle) preferredCamera.current = cameraPresentation(angle.camera).key;
    setFragmentFocus(focusIntent.sourceRange ? focusIntent : undefined);
    setPreview(undefined);
    setMonitorGroupId(take.group_id);
    setRevealedTakeId(resultView === "take" ? take.group_id : null);
  }, [focusIntent, project.project_id, resultView, scriptBlocksById, takesById]);

  useEffect(() => {
    if (resultView === "take" && selectedGroupId && selectedGroupId === revealedTakeId) {
      selectedCard.current?.focus({ preventScroll: true });
      selectedCard.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    }
  }, [resultView, revealedTakeId, selectedGroupId]);

  useEffect(() => {
    if (incomingFocus || !selectedTake || (selectedTake.angles.length > 0 && !selectedTake.angles.some((angle) => angle.clip_id === selectedClipId))) return;
    onSelectionChange?.(selectedTake.group_id, selectedClipId);
  }, [incomingFocus, onSelectionChange, selectedClipId, selectedTake]);

  useEffect(() => {
    if (isCoverage || !pendingScriptSeek || pendingScriptSeek !== activeSegmentId || searching) return;
    setPendingScriptSeek(null);
    const first = filteredTakes[0];
    if (!first) return;
    const match = filteredTakes.flatMap((take) => hitsByGroup.get(take.group_id) ?? [])
      .sort((left, right) => left.rank - right.rank)
      .find(({ angle }) => angle && canPreviewReviewPlayback(angle.playback));
    scrollToSelection.current = true;
    if (scriptQuery && match) playFragment(match.result, false);
    else selectTake(first);
  }, [activeSegmentId, filteredTakes, hitsByGroup, pendingScriptSeek, scriptQuery, searching, isCoverage]);

  useLayoutEffect(() => {
    const list = queueList.current;
    if (list && !searching && restoreScrollTop.current !== undefined) {
      list.scrollTop = restoreScrollTop.current;
      restoreScrollTop.current = undefined;
    }
  }, [loadState, resultCount, resultView, searching]);

  useLayoutEffect(() => {
    if (!scrollToSelection.current || searching) return;
    scrollToSelection.current = false;
    if (focusQueueRow.current !== null) {
      queueList.current?.querySelector<HTMLButtonElement>(`[data-queue-index="${focusQueueRow.current}"]`)?.focus({ preventScroll: true });
      focusQueueRow.current = null;
    }
    queueList.current?.querySelector(".review-take-card.is-selected, .review-fragment-card.is-selected")
      ?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [resultView, searching, selectedGroupId, selectedIndex, sortOrder]);

  useLayoutEffect(() => {
    if (!session) return;
    session.currentLocation = loadState === "ready" && selectedTake ? currentLocation : undefined;
    captureSession.current = () => {
      const location = session.currentLocation?.();
      session.snapshot = {
        finder,
        lookup: lookup?.payload ? { key: lookup.key, payload: lookup.payload } : undefined,
        appliedIntent: appliedIntent.current,
        queueRowHeights,
        queueScrollTop: restoreScrollTop.current ?? queueList.current?.scrollTop,
        takePositions,
        monitor: location ? {
          location,
          focus: fragmentFocus,
          preview: { ...preview, nonce: preview?.nonce ?? 0, autoplay: false, resume: location },
          preferredCamera: preferredCamera.current,
        } : loadState === "ready" ? undefined : savedMonitor,
      };
    };
  });

  useLayoutEffect(() => {
    if (!session) return;
    return () => {
      captureSession.current?.();
      session.currentLocation = undefined;
      const video = player.current;
      if (video && !video.paused) video.pause();
    };
  }, [session]);

  function selectTake(take: ReviewTakeGroup, clipId?: string): void {
    setPendingScriptSeek(null);
    setAngleNotice("");
    if (player.current && selectedTake && selectedTake.group_id !== take.group_id && activeAngle) {
      takePositions.set(selectedTake.group_id, currentLocation());
    }
    const angle = clipId ? take.angles.find((item) => item.clip_id === clipId) : undefined;
    if (angle) preferredCamera.current = cameraPresentation(angle.camera).key;
    setSelectedGroupId(take.group_id);
    setMonitorGroupId(take.group_id);
    setSelectedClipId(angle?.clip_id ?? (take.group_id === selectedGroupId ? selectedClipId : null)
      ?? preferredAngle(take, preferredCamera.current || cameraPresentation(activeAngle?.camera ?? "").key)?.clip_id ?? null);
    setFragmentFocus(undefined);
    setPreview(undefined);
    setRevealedTakeId(null);
  }

  function playFragment(reference: EvidenceReference, autoplay = true, fragmentId?: string): void {
    const take = takesById.get(reference.group_id ?? "");
    const angle = reference.clip_id || reference.media_id ? take?.angles.find((item) =>
      (!reference.clip_id || item.clip_id === reference.clip_id) && (!reference.media_id || item.media_id === reference.media_id)) : undefined;
    if (!take || !angle) { onOpenEvidence?.(reference); return; }
    selectTake(take, angle.clip_id);
    setFragmentFocus(evidenceLocation(project.project_id, reference));
    setPreview({ reference, nonce: ++playbackNonce.current, autoplay, bounded: true, fragmentId });
  }

  function scriptCueForAngle(take: ReviewTakeGroup, angle: ReviewAngle) {
    const hits = scriptQuery ? hitsByGroup.get(take.group_id) ?? [] : [];
    const hit = hits.find((match) => match.angle?.clip_id === angle.clip_id) ?? hits[0];
    if (!hit?.angle) return undefined;
    const focus = evidenceLocation(project.project_id, hit.result);
    const { start, end } = takePlaybackBounds(hit.angle, project.project_id, take.group_id, focus);
    const range = end === undefined ? undefined : cameraRangeAt(hit.angle, angle, start, end);
    return range ? { range, reference: hit.result } : undefined;
  }

  function playTakeAngle(take: ReviewTakeGroup, angle: ReviewAngle): void {
    if (selectedGroupId === take.group_id) {
      if (activeAngle?.clip_id === angle.clip_id) {
        setPendingScriptSeek(null);
        setAngleNotice("");
        void player.current?.play()?.catch(() => undefined);
      } else selectAngle(angle.clip_id, true);
      return;
    }
    const cue = scriptCueForAngle(take, angle);
    selectTake(take, angle.clip_id);
    if (cue) setFragmentFocus({ projectId: project.project_id, groupId: take.group_id, clipId: angle.clip_id, sourceRange: cue.range });
    setPreview({ reference: cue?.reference, nonce: ++playbackNonce.current, autoplay: true, bounded: cue?.range.end !== undefined });
  }

  function revealFragmentTake(fragment: ReviewFragment): void {
    if (preview && sameReviewEvidence(preview.reference, fragment.reference) && selectedTake?.group_id === fragment.take.group_id) {
      setPreview({ ...preview, bounded: false });
    } else {
      selectTake(fragment.take, fragment.angle.clip_id);
      setFragmentFocus(evidenceLocation(project.project_id, fragment.reference));
      setPreview({ reference: fragment.reference, fragmentId: fragment.id, nonce: ++playbackNonce.current, autoplay: false, bounded: false });
    }
    setRevealedTakeId(fragment.take.group_id);
    updateFinder({ takeViewQuery: needle });
  }

  function currentSourceTime(): number {
    const bounds = takePlaybackBounds(activeAngle, project.project_id, selectedTake?.group_id, fragmentFocus);
    const video = player.current;
    if (video && video.dataset.clipId === activeAngle?.clip_id && video.readyState >= 1 && Number.isFinite(video.currentTime)) {
      // Seek just inside the displayed frame. At an exact fractional frame
      // boundary WebKit can otherwise decode its predecessor.
      const visibleTime = video.paused && !video.seeking && presentedFrame.current !== null
        ? presentedFrame.current + 0.0001 : video.currentTime;
      return Math.min(bounds.sourceOut ?? Infinity, Math.max(bounds.sourceIn, visibleTime));
    }
    const resume = preview?.resume;
    return resume && resume.clipId === activeAngle?.clip_id && resume.mediaId === activeAngle?.media_id
      ? resume.sourceRange?.start ?? bounds.start : bounds.start;
  }

  function currentLocation(): ProductionSelectionContext {
    return { projectId: project.project_id, groupId: selectedTake?.group_id, clipId: activeAngle?.clip_id,
      mediaId: activeAngle?.media_id, scriptSegmentId: activeSegmentId ??
        (finder.watchedFromLine?.groupId === selectedGroupId ? finder.watchedFromLine?.segmentId : undefined),
      sourceRange: { basis: "source", start: currentSourceTime() } };
  }

  function cameraRangeAt(from: ReviewAngle, to: ReviewAngle, time: number, end?: number): ProductionSelectionContext["sourceRange"] {
    const fromStart = from.timeline_start + reviewMasterOffset(from, syncTimeline);
    const toStart = to.timeline_start + reviewMasterOffset(to, syncTimeline);
    const position = fromStart + time - (from.playback.source_start ?? from.source_start);
    const relative = position - toStart;
    const duration = to.timeline_end - to.timeline_start;
    if (relative < -1e-7 || relative >= duration) return undefined;
    const start = (to.playback.source_start ?? to.source_start) + Math.max(0, relative);
    return { basis: "source", start, end: end !== undefined && end > time
      ? start + Math.min(end - time, duration - relative) : undefined };
  }

  function selectAngle(clipId: string, autoplay?: boolean): void {
    if (!selectedTake || !activeAngle || clipId === activeAngle.clip_id) return;
    const angle = selectedTake.angles.find((item) => item.clip_id === clipId);
    if (!angle) return;
    const time = currentSourceTime();
    const { end } = takePlaybackBounds(activeAngle, project.project_id, selectedTake.group_id, fragmentFocus);
    const range = cameraRangeAt(activeAngle, angle, time, preview?.bounded ? end : undefined);
    if (!range) {
      setPendingScriptSeek(null);
      setAngleNotice(`${cameraPresentation(angle.camera).label}此处无素材`);
      return;
    }
    const playing = Boolean(player.current && !player.current.paused);
    selectTake(selectedTake, clipId);
    setFragmentFocus({ projectId: project.project_id, groupId: selectedTake.group_id, clipId,
      sourceRange: range });
    setPreview({ fragmentId: preview?.fragmentId, autoplay: autoplay ?? playing,
      nonce: ++playbackNonce.current, bounded: range.end !== undefined });
  }

  function toggleComparison(groupId: string): void {
    const available = comparedTakes.map((take) => take.group_id);
    if (available.includes(groupId)) {
      updateFinder({ comparisonIds: available.filter((id) => id !== groupId) });
    } else if (available.length < COMPARISON_LIMIT) {
      updateFinder({ comparisonIds: [...available, groupId] });
    }
  }

  function selectRememberedTake(take: ReviewTakeGroup): void {
    if (take.group_id === selectedGroupId) return;
    const position = takePositions.get(take.group_id);
    selectTake(take, position?.clipId);
    if (position) {
      setPreview({ nonce: ++playbackNonce.current, autoplay: false, resume: position });
    }
  }

  function chooseMode(mode: "watch" | "coverage"): void {
    if (mode === "coverage" && player.current && selectedTake && activeAngle) {
      const resume = currentLocation();
      takePositions.set(selectedTake.group_id, resume);
      setPreview({ ...preview, nonce: ++playbackNonce.current, resume, autoplay: false });
      player.current.pause();
    }
    if ((mode === "coverage") === isCoverage) return;
    if (mode === "watch") {
      updateFinder({ mode, watchedFromLine: undefined, coverageScope: { segmentId: activeSegmentId, recovery: finder.recovery },
        activeScene: null, activeSegmentId: null, recovery: null, takeViewQuery: null, sortPreference: null });
    } else {
      const block = scriptBlocksById.get(finder.coverageScope?.segmentId ?? activeSegmentId ?? "") ?? firstBlock;
      updateFinder({ mode, activeSegmentId: block?.segment_id ?? null, episode: null, unmappedActive: false,
        activeScene: block ? { episode: block.episode, sceneId: block.scene_id } : null,
        recovery: finder.coverageScope?.recovery ?? null });
    }
    setPendingScriptSeek(null);
  }

  function watchCoverageAngle(take: ReviewTakeGroup, clipId?: string, time?: number): void {
    const savedPosition = takePositions.get(take.group_id);
    const angle = take.angles.find((item) => item.clip_id === (clipId ?? savedPosition?.clipId)) ?? preferredAngle(take);
    selectTake(take, angle?.clip_id);
    chooseMode("watch");
    if (isCoverage && activeSegmentId) updateFinder({ watchedFromLine: { groupId: take.group_id, segmentId: activeSegmentId } });
    if (!angle) return;
    const cue = scriptCueForAngle(take, angle);
    const resumeTime = time ?? (savedPosition?.clipId === angle.clip_id ? savedPosition?.sourceRange?.start : undefined);
    const resume = { projectId: project.project_id, groupId: take.group_id, clipId: angle.clip_id, mediaId: angle.media_id,
      sourceRange: { basis: "source" as const, start: resumeTime ?? cue?.range.start ?? angle.source_start } };
    setPreview({ nonce: ++playbackNonce.current, autoplay: false, resume });
  }

  function openMulticam(take: ReviewTakeGroup): void {
    const position = take.group_id === selectedGroupId && player.current ? currentLocation() : takePositions.get(take.group_id);
    if (position) takePositions.set(take.group_id, position);
    player.current?.pause();
    setMulticam({ groupId: take.group_id, clipId: position?.clipId, time: position?.sourceRange?.start });
  }

  function openScriptForTake(take: ReviewTakeGroup, segmentId: string): void {
    const position = take.group_id === selectedGroupId && player.current ? currentLocation() : takePositions.get(take.group_id);
    const angle = take.angles.find((item) => item.clip_id === position?.clipId) ?? preferredAngle(take);
    selectTake(take, angle?.clip_id);
    onOpenScript?.(take.group_id, angle?.clip_id, { ...position, projectId: project.project_id,
      groupId: take.group_id, clipId: angle?.clip_id, mediaId: angle?.media_id, scriptSegmentId: segmentId });
  }

  function compareShot(groupId: string): void {
    const other = relatedShotTakes.find((take) => take.group_id === groupId);
    if (!selectedTake || !canCompareShot || !other) return;
    updateFinder({ comparisonIds: [selectedTake.group_id, groupId] });
    selectRememberedTake(other);
  }

  function selectQueueTake(take: ReviewTakeGroup): void {
    const namedAngle = filenameQuery ? take.angles.find((angle) => normalizedQuery(angle.name).includes(contentQuery)) : undefined;
    if (take.group_id === selectedGroupId && (!namedAngle || namedAngle.clip_id === selectedClipId)) return;
    const hit = !namedAngle && hitsByGroup.get(take.group_id)?.find(({ angle, result }) =>
      angle && canPreviewReviewPlayback(angle.playback) && isLocatedReviewHit(result));
    if (hit) playFragment(hit.result, false);
    else if (namedAngle) selectTake(take, namedAngle.clip_id);
    else selectRememberedTake(take);
  }

  function selectRelative(delta: number): void {
    const index = delta < 0 ? previousIndex : nextIndex;
    if (index < 0 || index >= transportCount) return;
    scrollToSelection.current = !comparing;
    if (navigatingFragments) {
      const fragment = fragments[index];
      playFragment(fragment.reference, false, fragment.id);
      return;
    }
    const next = transportTakes[index];
    if (!next) return;
    if (comparing) selectRememberedTake(next);
    else selectQueueTake(next);
  }

  function resetScopeSelection(): void {
    setMonitorGroupId(null);
    setRevealedTakeId(null);
    if (queueList.current) queueList.current.scrollTop = 0;
  }

  function chooseScriptScene(scene: ReviewScene, episode: number): void {
    const alreadySelected = activeScene?.episode === episode && activeScene.sceneId === scene.scene_id && !activeSegmentId;
    updateFinder({ query: "", takeViewQuery: "", viewPreference: null, sortPreference: null,
      recovery: null, activeScene: alreadySelected ? null : { episode, sceneId: scene.scene_id },
      activeSegmentId: null, unmappedActive: false, includeEpisodeCandidates: false });
    setPendingScriptSeek(null);
    resetScopeSelection();
  }

  function chooseScriptBlock(block: ReviewScriptBlock): void {
    updateFinder({ query: "", takeViewQuery: "", viewPreference: null, sortPreference: null,
      recovery: isCoverage ? recoveryForBlock(block) : null, outlineEpisode: block.episode, ...(isCoverage ? { episode: null, filter: "all", hideNg: false } as const : {}),
      activeScene: { episode: block.episode, sceneId: block.scene_id }, activeSegmentId: block.segment_id,
      unmappedActive: false, includeEpisodeCandidates: false });
    setPendingScriptSeek(isCoverage ? null : block.segment_id);
    resetScopeSelection();
  }

  function clearScriptScope(): void {
    updateFinder({ activeScene: null, activeSegmentId: null, recovery: null, unmappedActive: false, includeEpisodeCandidates: false });
    setPendingScriptSeek(null);
    resetScopeSelection();
  }

  function changeSearch(values: Partial<Pick<FinderState, "query" | "searchScope">>): void {
    const leavingScript = !isCoverage && values.query !== undefined && Boolean(normalizedQuery(values.query));
    const switchContext = values.query !== undefined && Boolean(normalizedQuery(values.query)) !== Boolean(needle);
    updateFinder({ ...values, takeViewQuery: null, includeEpisodeCandidates: false,
      ...(leavingScript ? { activeScene: null, activeSegmentId: null, unmappedActive: false } : {}),
      ...(switchContext ? { sortPreference: null } : {}) });
    setPendingScriptSeek(null);
    setSemanticRequest(null);
    resetScopeSelection();
  }

  async function copyLocation(): Promise<void> {
    if (!activeAngle || copyPending) return;
    const angle = activeAngle;
    const position = currentSourceTime();
    const camera = cameraPresentation(angle.camera).label;
    const fallback = () => reviewLocationText(angle, position, camera, syncTimeline);
    const readTiming = Boolean(angle.media_id && canPreviewReviewPlayback(angle.playback));
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    setCopyPending(true);
    try {
      if (!readTiming) {
        await navigator.clipboard.writeText(fallback());
      } else {
        const value = new DesktopClient(baseUrl).sourceTimecode(project.project_id, angle.clip_id)
          .then((timing) => reviewLocationText(angle, position, camera, syncTimeline, timing), fallback);
        if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })) })]);
        } else {
          await navigator.clipboard.writeText(await value);
        }
      }
      setCopyState("已复制定位");
    } catch {
      setCopyState("复制失败");
    } finally {
      setCopyPending(false);
      copyTimer.current = window.setTimeout(() => setCopyState(""), 1600);
    }
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="review-workspace">
        <div
          className={`projection-status ${
            loadState === "error" ? "is-error" : ""
          }`}
        >
          <span role={loadState === "error" ? "alert" : "status"}>{message}</span>
          {loadState === "error" && <button type="button" className="secondary" onClick={retryLoad}>重新读取审阅队列</button>}
        </div>
      </section>
    );
  }

  const railEpisodeId = episode ?? activeScene?.episode ?? termEpisode ?? sceneEpisode ?? selectedPlace?.episode;
  const railEpisode = model.episodes.find((item) => item.episode === railEpisodeId) ?? model.episodes[0];
  const railSceneId = activeScene?.sceneId ?? (sceneTerm ? railEpisode?.scenes.find((scene) =>
    normalizedQuery(prettySceneId(scene.scene_id)) === sceneTerm)?.scene_id : undefined)
    ?? (selectedPlace?.episode === railEpisode?.episode ? selectedPlace?.sceneId || undefined : undefined)
    ?? railEpisode?.scenes[0]?.scene_id;
  const scriptScopeLabel = activeScriptBlock ? activeScriptBlock.text || scriptBlockBadge(activeScriptBlock)
    : activeScene ? `${prettySceneId(activeScene.sceneId)} 场` : unmappedActive ? "未关联剧本" : "";
  const canBrowseUnmapped = model.take_groups.some((take) => !take.effective_mapping.script_segment_ids.length
    && (episode === null || episodesByTake.get(take.group_id)?.has(episode)));
  const multicamTake = multicam && takesById.get(multicam.groupId);
  const monitorCoordinates = slateCoordinates(selectedFields && {
    ...selectedFields, episode: selectedPlace?.episode ?? selectedFields.episode, scene: selectedPlace?.scene || selectedFields.scene,
  });

  return (
    <section className="review-workspace">
      <header className="review-workspace-toolbar">
        {hasScript && <div className="review-mode-switch mo-segmented" role="group" aria-label="审阅方式">
          <button type="button" aria-pressed={isCoverage} onClick={() => chooseMode("coverage")}><StudioIcon name="script" size={15} />剧本对照</button>
          <button type="button" aria-pressed={!isCoverage} onClick={() => chooseMode("watch")}><StudioIcon name="play" size={14} />逐条看片</button>
        </div>}
        <form className="review-search-form" onSubmit={(event) => {
          event.preventDefault();
          if (canRequestConfiguredSearch) setSemanticRequest({ query: searchKey });
        }}>
          {onOpenEvidence && <select className="mo-select review-search-scope" aria-label="搜索范围" value={searchScope}
            onChange={(event) => changeSearch({ searchScope: event.target.value as SearchScope })}>
            <option value="all">全部内容</option>
            <option value="speech">对白</option>
            <option value="visual">画面</option>
          </select>}
          <div className="review-search-wrap">
            <StudioIcon name="search" size={15} />
            <input className="review-search-input" value={query} aria-label="搜索审阅素材"
              placeholder="搜台词、画面、场号或文件名"
              onChange={(event) => changeSearch({ query: event.target.value })} />
            {query && <button type="button" className="review-search-clear" aria-label="清除搜索"
              onClick={() => changeSearch({ query: "" })}>
              <StudioIcon name="close" size={14} />
            </button>}
            {canRequestConfiguredSearch && <button type="submit" className="secondary review-search-submit" title="用已配置的模型搜索">语义搜索</button>}
          </div>
        </form>
        <div className="review-filters" role="group" aria-label="看片筛选">
          <select className="mo-select" aria-label="选片状态" title="按场记状态或剪辑决定筛选" value={filter} onChange={(event) => {
            const value = event.target.value as ReviewQueueFilter;
            updateFinder({ filter: value, hideNg: value === "slate_ng" ? false : hideNg, sortPreference: null });
            resetScopeSelection();
          }}>
            <option value="all">全部状态</option>
            <optgroup label="场记状态">
              {(["ng", "partial", "usable", "unmarked"] as const).map(state => <option key={state} value={`slate_${state}`}>场记 {slateLabels[state]}</option>)}
              <option value="slate_missing">暂无场记</option>
            </optgroup>
            <optgroup label="选片与核对">{FILTERS.filter(item => item.value !== "all").map(({ value, label }) => <option key={value} value={value} title={value === "attention"
              ? `阻断 ${attentionTiers.blocking} · 证据过期 ${attentionTiers.stale} · 待关注 ${attentionTiers.watch}` : undefined}>
              {label}
            </option>)}</optgroup>
          </select>
          <button type="button" className="secondary mo-toolbar-button review-hide-ng" aria-pressed={hideNg} title="仅隐藏整条被场记标为 NG 的 Take"
            onClick={() => { updateFinder({ hideNg: !hideNg, filter: !hideNg && filter === "slate_ng" ? "all" : filter }); resetScopeSelection(); }}>隐藏场记 NG</button>
        </div>
      </header>

      {isCoverage && projection ? <main className="review-coverage-layout">
        <ReviewScriptOutline episodes={model.episodes} projection={projection} selected={activeScriptBlock}
          episode={finder.outlineEpisode} query={finder.outlineQuery} onlyMissing={finder.onlyMissing}
          onQuery={(outlineQuery) => updateFinder({ outlineQuery })} onMissing={(onlyMissing) => updateFinder({ onlyMissing })}
          onEpisode={(next) => {
            const block = model.episodes.find((item) => item.episode === next)?.scenes.flatMap((scene) => scene.script_blocks)
              .find((item) => isPlaceableScriptBlock(item) && (!finder.onlyMissing || !projection.relatedTakeIds.has(item.segment_id)));
            if (block) chooseScriptBlock(block);
            else { clearScriptScope(); updateFinder({ outlineEpisode: next }); }
          }} onChoose={chooseScriptBlock} />
        <section className="review-coverage-results" aria-label="剧本对应素材">
          <header className="review-coverage-results-head">
            <h2>{finder.recovery === "episode" ? "本集素材组" : !activeScriptBlock || finder.recovery === "all" ? "全部素材组" : "本段相关素材"}
              <span aria-live="polite">{filteredTakes.length} 组</span></h2>
            {activeScriptBlock && model.take_groups.length > 0 && <div className="review-coverage-range mo-segmented" role="group" aria-label="查找素材范围">
              <button type="button" aria-pressed={!finder.recovery} onClick={() => updateFinder({ recovery: null })}>本段相关</button>
              <button type="button" aria-pressed={finder.recovery === "episode"} onClick={() => updateFinder({ recovery: "episode" })}>在本集找素材</button>
              <button type="button" aria-pressed={finder.recovery === "all"} onClick={() => updateFinder({ recovery: "all" })}>在全项目找</button>
            </div>}
            {activeScriptBlock && <div className="review-coverage-context">
              <span>第 {activeScriptBlock.episode} 集 · {prettySceneId(activeScriptBlock.scene_id)} 场 · {scriptBlockBadge(activeScriptBlock)}</span>
              {finder.recovery && !projection.relatedTakeIds.has(activeScriptBlock.segment_id) &&
                <span className="review-recovery-hint" title="这段剧本还没有关联素材，可从下方找到对应画面。">这段剧本还没有关联素材，可从下方找到对应画面。</span>}
            </div>}
          </header>
          {filteredTakes.length ? <ReviewCoverageCards takes={filteredTakes} activeBlock={activeScriptBlock} blocksById={scriptBlocksById} projection={projection}
            slateFacts={slateFacts} slateReadState={slateReadState} onOpenSlate={onOpenSlate}
            selectedGroupId={selectedGroupId} connection={connection} projectId={project.project_id}
            takeLabel={(take) => reviewTakeLabel(take, needsSequentialTakeNumbers, takeSequenceByGroupId)}
            onWatch={watchCoverageAngle} onCompare={openMulticam} onOpenScript={onOpenScript ? openScriptForTake : undefined}
            onChooseBlock={chooseScriptBlock} angleEvidence={(take, angle) => {
              const hit = hitsByGroup.get(take.group_id)?.find((item) => item.angle?.clip_id === angle.clip_id && item.result.source === "speech"
                && item.result.metadata.precision === "asr_segment" && isLocatedReviewHit(item.result));
              return hit ? { text: hit.result.snippet, sourceStart: takePlaybackBounds(angle, project.project_id,
                take.group_id, evidenceLocation(project.project_id, hit.result)).start } : undefined;
            }} /> : <div className="review-coverage-empty" role="status">
            <strong>{!model.take_groups.length ? "项目中还没有素材组" : query || filter !== "all" || hideNg ? "当前筛选没有匹配的素材"
              : finder.recovery ? "这个范围还没有素材组" : "这段剧本还没有关联素材"}</strong>
            <p>{!model.take_groups.length ? "导入原片并生成素材组后，可以在这里逐段核对。"
              : query || filter !== "all" || hideNg ? "清除素材筛选后，可以继续核对当前剧本段。"
              : finder.recovery === "all" ? "可以从左侧选择其他剧本段。" : "可以扩大查找范围，找到对应画面后再关联到这段剧本。"}</p>
            {(query || filter !== "all" || hideNg) && <button className="secondary" onClick={() => updateFinder({ query: "", filter: "all", hideNg: false })}>清除素材筛选</button>}
          </div>}
        </section>
      </main> : <main
        className={`review-primary-canvas${
          hasScript && showScriptRail ? " has-script-rail" : ""
        }${!model.take_groups.length ? " is-empty" : ""}`}
      >
        {railEpisode && showScriptRail && model.take_groups.length > 0
          ? (
            <aside id="review-script-rail" className="review-script-rail" aria-label="按剧本找素材">
              <div className="review-rail-heading">
                <h3>第 {railEpisode.episode} 集剧本</h3>
              </div>
              <div className="review-script-outline">
                {railEpisode.scenes.map((scene) => (
                  <section className="review-script-scene" key={scene.scene_id}>
                    <button type="button" className="review-script-scene-select"
                      aria-pressed={activeScene?.episode === railEpisode.episode && activeScene.sceneId === scene.scene_id}
                      onClick={() => chooseScriptScene(scene, railEpisode.episode)}>
                      {scene.heading || prettySceneId(scene.scene_id)}
                    </button>
                    {scene.scene_id === railSceneId && scene.script_blocks.filter(isPlaceableScriptBlock).map((block) => {
                      const matched = projection?.relatedTakeIds.get(block.segment_id)
                        ?.filter((groupId) => scriptScoped(groupId, block.episode)) ?? [];
                      return (
                        <button type="button" className="review-script-block" key={block.segment_id}
                          aria-pressed={activeSegmentId === block.segment_id} onClick={() => chooseScriptBlock(block)}>
                          <span className="review-script-block-copy">
                            <strong>{scriptBlockBadge(block)}</strong>
                            <span>{block.text || block.raw_text || "（空白剧本段）"}</span>
                          </span>
                          <span className="review-script-count" aria-label={`${matched.length} 条相关 Take`}>{matched.length || ""}</span>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
              {canBrowseUnmapped && <button type="button" className="review-unmapped-pill"
                aria-pressed={unmappedActive} onClick={() => {
                  if (unmappedActive) { clearScriptScope(); return; }
                  updateFinder({ query: "", activeScene: null, activeSegmentId: null, unmappedActive: true,
                    includeEpisodeCandidates: false, sortPreference: null, takeViewQuery: "" });
                  setPendingScriptSeek(null);
                  resetScopeSelection();
                }}>未关联剧本</button>}
            </aside>
          )
          : null}

        <section className="review-queue" aria-label={resultView === "fragment" ? "素材片段" : "候选 Take 队列"}>
          {hasScript && <div className="review-watch-filters" role="group" aria-label="剧本筛选">
            <select className="mo-select" aria-label="按集筛选" value={episode ?? ""} onChange={(event) => {
              updateFinder({ episode: event.target.value ? Number(event.target.value) : null, activeScene: null,
                activeSegmentId: null, sortPreference: null, unmappedActive: false, includeEpisodeCandidates: false });
              setPendingScriptSeek(null);
              resetScopeSelection();
            }}>
              <option value="">全部集</option>
              {model.episodes.map((item) => <option key={item.episode} value={item.episode}>第 {item.episode} 集</option>)}
            </select>
            <button type="button" className="secondary mo-toolbar-button" aria-pressed={includeEpisodeCandidates}
              disabled={episode === null && !activeSegmentId && !coordinates.some(([field]) => field === "episode")}
              onClick={() => { updateFinder({ includeEpisodeCandidates: !includeEpisodeCandidates }); resetScopeSelection(); }}>跨集候选</button>
            <button type="button" className="secondary mo-toolbar-button" aria-expanded={showScriptRail}
              aria-controls="review-script-rail" onClick={() => updateFinder({ showScriptRail: !showScriptRail })}>
              <StudioIcon name="script" size={14} /> 按剧本找
            </button>
          </div>}
          <div className="review-queue-heading">
            <h3 aria-live="polite">{searching && !resultCount ? "搜索中…" : `${resultCount} ${resultView === "fragment" ? "个片段" : "条 Take"}`}</h3>
            {onOpenEvidence && <div className="review-result-view mo-segmented" role="group" aria-label="结果视图">
              {(["fragment", "take"] as const).map((view) => (
                <button type="button" key={view} aria-pressed={resultView === view}
                  onClick={() => updateFinder({ viewPreference: view, takeViewQuery: null })}>{view === "fragment" ? "片段" : "Take"}</button>
              ))}
            </div>}
          </div>
          {(sortOptions.length > 1 || scriptScopeLabel) && <div className="review-queue-controls">
            {sortOptions.length > 1 && <select className="mo-select" aria-label="排序方式" value={sortOrder} onChange={(event) => {
              scrollToSelection.current = Boolean(queueList.current?.querySelector(".is-selected"));
              if (!scrollToSelection.current && queueList.current) queueList.current.scrollTop = 0;
              updateFinder({ sortPreference: event.target.value as ReviewSortOrder });
            }}>
              {sortOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>}
            {resultView === "take" && resultCount > 1 && !scriptScopeLabel && <span className="review-queue-keys" title="聚焦 Take 后用上下方向键切换">↑↓ 切换</span>}
            {scriptScopeLabel && <button type="button" className="review-scope-clear" aria-label="取消剧本筛选" title={scriptScopeLabel}
              onClick={clearScriptScope}><span>{scriptScopeLabel}</span><StudioIcon name="close" size={12} /></button>}
          </div>}
          {searching && resultCount > 0 && <div className="review-search-status" role="status">搜索中…</div>}
          {currentLookup?.failed && <div className="review-search-status" role="status">搜索失败</div>}
          {resultView === "fragment" && fragments.length > 0 ? (
            <div className="review-take-card-list" key="fragments" ref={queueList}>
              {fragments.map((fragment, index) => {
                const takeLabel = reviewTakeLabel(fragment.take, needsSequentialTakeNumbers, takeSequenceByGroupId);
                const fields = fieldsById.get(fragment.take.group_id);
                const scene = sortOrder === "script" ? reviewSceneHeading(placesById.get(fragment.take.group_id)) : "";
                const showScene = scene && (index === 0 || scene !== reviewSceneHeading(placesById.get(fragments[index - 1].take.group_id)));
                return (
                  <Fragment key={fragment.id}>
                    {showScene && <h4 className="review-queue-scene">{scene}</h4>}
                    <ReviewQueueRow count={fragments.length} index={index} selectedIndex={selectedFragmentIndex}
                      queueId={`${queueId}-fragments`} rowKey={`fragment:${fragment.id}`} heights={queueRowHeights} estimate={90} pinLast>
                      {() => <article className={`review-fragment-card${selectedFragmentIndex === index ? " is-selected" : ""}`}>
                        <ReviewEvidenceHit reference={fragment.reference} angle={fragment.angle} label={fragment.label}
                          active={selectedFragmentIndex === index} poster
                          mediaUrl={connection.mediaUrl(project.project_id, fragment.angle.clip_id)}
                          onOpen={(reference) => playFragment(reference, true, fragment.id)} />
                        <div className="review-fragment-context">
                          <span>{slateCoordinates(fields, Boolean(scene)) || takeLabel.split(" · ")[0]}</span>
                          <ReviewFootageStatus take={fragment.take} facts={slateFacts.get(fragment.take.group_id)} readState={slateReadState} />
                          <button type="button" className="review-fragment-take" aria-label={`查看 ${takeLabel}`}
                            onClick={() => revealFragmentTake(fragment)}>查看 Take <StudioIcon name="arrow-up-right" size={12} /></button>
                        </div>
                        <ReviewAngleStatus fact={slateFacts.get(fragment.take.group_id)?.angles.get(fragment.angle.clip_id)} camera={cameraPresentation(fragment.angle.camera).label} compact />
                      </article>}
                    </ReviewQueueRow>
                  </Fragment>
                );
              })}
            </div>
          ) : resultView === "take" && filteredTakes.length > 0 ? (
            <div className="review-take-card-list" key="takes" ref={queueList}>
              {filteredTakes.map((take, index) => {
                const fields = fieldsById.get(take.group_id);
                const scene = sortOrder === "script" ? reviewSceneHeading(placesById.get(take.group_id)) : "";
                const showScene = scene && (index === 0 || scene !== reviewSceneHeading(placesById.get(filteredTakes[index - 1].group_id)));
                const coordinates = slateCoordinates(fields, Boolean(scene));
                const takeLabel = reviewTakeLabel(take, needsSequentialTakeNumbers, takeSequenceByGroupId);
                const missingShot = Boolean(scene && placesById.get(take.group_id)?.scene && !fields?.shot);
                const rowCoordinates = [missingShot && "未标镜号", coordinates].filter(Boolean).join(" · ");
                const hits = hitsByGroup.get(take.group_id) ?? [];
                const comparing = comparisonIds.includes(take.group_id);
                const facts = slateFacts.get(take.group_id);
                const state = finalDecision(take).state;
                const selected = selectedGroupId === take.group_id;
                const ng = facts?.take?.status === "ng";
                const namedAngle = filenameQuery ? take.angles.find((angle) => normalizedQuery(angle.name).includes(contentQuery)) : undefined;
                const rowFile = (namedAngle ?? take.angles[0])?.name;
                const excerpt = take.transcript.text;
                return (
                  <Fragment key={take.group_id}>
                    {showScene && <h4 className="review-queue-scene">{scene}</h4>}
                    <ReviewQueueRow count={filteredTakes.length} index={index} selectedIndex={filteredIndex}
                      queueId={`${queueId}-takes`} rowKey={`take:${take.group_id}`} heights={queueRowHeights} estimate={110}>
                      {() => <article className={`review-take-card${selected ? " is-selected" : ""}${ng || state === "reject" ? " is-ng" : ""}`}
                        ref={selected ? selectedCard : undefined} tabIndex={-1} aria-label={takeLabel}>
                        <div className="review-take-card-heading">
                          <button type="button" className="review-take-select" aria-pressed={selected} data-queue-index={index}
                            tabIndex={selected || (filteredIndex < 0 && index === 0) ? 0 : -1}
                            aria-keyshortcuts="ArrowUp ArrowDown Home End" title={takeLabel} onClick={() => selectQueueTake(take)}
                            onKeyDown={(event) => {
                              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
                              let next: number;
                              switch (event.key) {
                                case "ArrowDown": next = index + 1; break;
                                case "ArrowUp": next = index - 1; break;
                                case "Home": next = 0; break;
                                case "End": next = filteredTakes.length - 1; break;
                                default: return;
                              }
                              event.preventDefault();
                              if (next === index || !filteredTakes[next]) return;
                              scrollToSelection.current = true;
                              focusQueueRow.current = next;
                              selectQueueTake(filteredTakes[next]);
                            }}>
                            <strong>{takeLabel.split(" · ")[0]}</strong>
                            {rowCoordinates && <span className="review-row-coordinates">{rowCoordinates}</span>}
                            {rowFile && <span className="review-row-file" title={rowFile}>{rowFile}</span>}
                          </button>
                          <button type="button" className="review-compare-toggle" aria-pressed={comparing} tabIndex={selected ? 0 : -1}
                            aria-label={`${comparing ? "移出对比" : "加入对比"} ${takeLabel}`} disabled={!comparing && comparedTakes.length >= COMPARISON_LIMIT}
                            onClick={() => toggleComparison(take.group_id)}>{comparing ? "已加入" : "对比"}</button>
                        </div>
                        <ReviewFootageStatus take={take} facts={facts} readState={slateReadState} />
                        {take.angles.length > 0 && <div className="review-take-cameras" role="group" aria-label={`${takeLabel} 机位`}>
                          {takeCameraSlots(take.angles).map((slot) => (
                            <div className="review-camera-slot" key={slot.key}>
                              {slot.angles.map((angle) => {
                                const cameraLabel = cameraAngleLabel(angle, take.angles);
                                return <button className="review-take-camera" key={angle.clip_id} type="button"
                                  title={angle.name} tabIndex={selected ? 0 : -1} aria-label={`播放 ${cameraLabel} · ${angle.name}`}
                                  data-camera-tone={slot.tone}
                                  aria-pressed={selected && activeAngle?.clip_id === angle.clip_id}
                                  onClick={() => playTakeAngle(take, angle)}>
                                  <ReviewAngleFrame angle={angle} sourceStart={scriptCueForAngle(take, angle)?.range.start}
                                    mediaUrl={connection.mediaUrl(project.project_id, angle.clip_id)} />
                                  <span className="review-camera-label" aria-hidden="true">{cameraLabel}</span>
                                </button>;
                              })}
                            </div>
                          ))}
                        </div>}
                        <ReviewSlateReference record={facts?.take} />
                        {facts && take.angles.map(angle => {
                          const fact = facts.angles.get(angle.clip_id);
                          if (!fact) return null;
                          const camera = cameraAngleLabel(angle, take.angles);
                          return <div className="review-queue-angle-fact" key={angle.clip_id}><b>{camera}</b><ReviewAngleStatus fact={fact} camera={camera} compact /></div>;
                        })}
                        {hits[0] ? <div className="review-take-hits">
                          <ReviewEvidenceHit reference={hits[0].result} angle={hits[0].angle} label={hits[0].result.source_label}
                            active={sameReviewEvidence(preview?.reference, hits[0].result)} onOpen={playFragment} />
                          {hits.length > 1 && <details>
                            <summary>其他 {hits.length - 1} 条命中</summary>
                            <div>{hits.slice(1).map(({ result, angle }) => <ReviewEvidenceHit key={result.document_id}
                              reference={result} angle={angle} label={result.source_label}
                              active={sameReviewEvidence(preview?.reference, result)} onOpen={playFragment} />)}</div>
                          </details>}
                        </div> : excerpt && <p className="review-take-dialogue">{reviewExcerpt(excerpt)}</p>}
                      </article>}
                    </ReviewQueueRow>
                  </Fragment>
                );
              })}
            </div>
          ) : !searching ? (
            <div className="review-empty-state" role="status">
              <strong>{model.take_groups.length ? resultView === "fragment" ? "没有找到片段" : "没有找到 Take" : "没有可审阅的素材"}</strong>
              {model.take_groups.length > 0 && <button type="button" className="secondary" onClick={() => {
                changeSearch({ query: "", searchScope: "all" });
                updateFinder({ filter: "all", activeScene: null, activeSegmentId: null, sortPreference: null,
                  viewPreference: null, unmappedActive: false, hideNg: false, episode: null });
              }}>清除筛选</button>}
            </div>
          ) : null}
        </section>

        {model.take_groups.length > 0 && <section className="review-viewer-pane" aria-label="看片与人工决定">
          <div className="review-viewer-controls">
            {comparedTakes.length > 0 && (
              <div className="review-comparison" role="group" aria-label="对比 Take">
                <strong>对比</strong>
                {comparedTakes.map((take) => {
                  const takeLabel = reviewTakeLabel(take, needsSequentialTakeNumbers, takeSequenceByGroupId);
                  const position = takePositions.get(take.group_id);
                  const selected = take.group_id === selectedGroupId;
                  const angle = (selected ? activeAngle : take.angles.find((item) => item.clip_id === position?.clipId))
                    ?? preferredAngle(take, preferredCamera.current);
                  const focus = selected ? preview?.resume ?? fragmentFocus : position;
                  return <div className="review-comparison-item" key={take.group_id}>
                    <button type="button" aria-label={takeLabel} title={angle?.name ?? takeLabel} aria-pressed={selected}
                      onClick={() => selectRememberedTake(take)}>
                      {angle && <ReviewAngleFrame angle={angle} sourceStart={takePlaybackBounds(angle, project.project_id, take.group_id, focus).start} />}
                      <span>{takeLabel.split(" · ")[0]}</span>
                    </button>
                    <button type="button" aria-label={`移出对比 ${takeLabel}`} onClick={() => toggleComparison(take.group_id)}><StudioIcon name="close" size={13} /></button>
                  </div>;
                })}
              </div>
            )}
            {selectedTake && <div className="review-viewer-toolbar">
              <div className="review-monitor-heading">
                <div className="review-monitor-title">
                  <strong>{currentTakeLabel.split(" · ")[0]}</strong>
                  {monitorCoordinates && <span title={monitorCoordinates}>{monitorCoordinates}</span>}
                </div>
                {activeAngle && <h3 title={activeAngle.name}>{activeAngle.name}</h3>}
              </div>
              <div className="review-monitor-strip">
                <div className="review-monitor-cameras" role="group" aria-label="机位选择">
                  {selectedTake.angles.map((angle) => {
                    const camera = cameraPresentation(angle.camera);
                    const label = cameraAngleLabel(angle, selectedTake.angles);
                    return <button type="button" key={angle.clip_id} data-camera-tone={camera.tone}
                      aria-pressed={activeAngle?.clip_id === angle.clip_id} aria-label={`选择 ${label} · ${angle.name}`} title={angle.name}
                      onClick={() => selectAngle(angle.clip_id)}>{label}</button>;
                  })}
                </div>
                {selectedTake.angles.length > 1 && <button type="button" className="secondary mo-toolbar-button review-multicam-open" onClick={() => openMulticam(selectedTake)}>多机位同看</button>}
                {activeAngle && <button type="button" className="secondary mo-toolbar-button review-location-copy" disabled={copyPending} onClick={() => void copyLocation()}>
                  {copyPending ? "读取时码…" : copyState || "复制定位"}
                </button>}
              </div>
              <div className="review-monitor-context">
                <div className="review-monitor-facts">
                  <ReviewFootageStatus take={selectedTake} facts={selectedSlate} readState={slateReadState} />
                  {outsideQueue && <span role="status">当前 Take 不在筛选结果中</span>}
                  {angleNotice && <span role="status" className="review-angle-notice">{angleNotice}</span>}
                </div>
                {resultView === "fragment" && !comparisonIds.includes(selectedTake.group_id) && comparedTakes.length < COMPARISON_LIMIT && (
                  <button type="button" className="mo-toolbar-button review-compare-toggle"
                    aria-label={`加入对比 ${currentTakeLabel}`} onClick={() => toggleComparison(selectedTake.group_id)}>对比 Take</button>
                )}
                {canCompareShot && <select className="mo-select review-shot-compare" aria-label="对比同镜 Take" value=""
                  onChange={(event) => compareShot(event.target.value)}>
                  <option value="" disabled>对比同镜</option>
                  {relatedShotTakes.map((take) => {
                    const number = fieldsById.get(take.group_id)?.take_number;
                    const label = reviewTakeLabel(take, needsSequentialTakeNumbers, takeSequenceByGroupId);
                    return <option key={take.group_id} value={take.group_id}>{number ? `第 ${number} 次 · ${label}` : label}</option>;
                  })}
                </select>}
              </div>
            </div>}
          </div>
          <div className="review-viewer-body">{selectedTake ? <TakeInspector
            connection={connection}
            projectId={project.project_id}
            take={selectedTake}
            selectedClipId={selectedClipId}
            playbackFocus={fragmentFocus}
            onSelectClip={selectAngle}
            retainCameraOnTakeChange={false}
            writeSaving={false}
            hideHeader
            monitor={{
              videoRef: bindPlayer,
              scriptBlock: activeScriptBlock ?? (finder.watchedFromLine?.groupId === selectedGroupId
                ? scriptBlocksById.get(finder.watchedFromLine?.segmentId ?? "") : undefined),
              request: preview,
              onOpenRepair,
              relatedActions: <div className="review-cross-actions" aria-label="素材定位">
                {onOpenSlate && <button type="button" className="secondary"
                  onClick={() => onOpenSlate(selectedTake.group_id, activeAngle?.clip_id, activeAngleSlate?.record.record_id || selectedSlate?.take?.record_id)}>查看场记</button>}
                {onOpenMaterial && <button type="button" className="secondary"
                  onClick={() => onOpenMaterial(selectedTake.group_id, selectedClipId, currentLocation())}>打开素材</button>}
                {onOpenScript && <button type="button" className="secondary"
                  onClick={() => onOpenScript(selectedTake.group_id, selectedClipId, currentLocation())}>打开剧本</button>}
                {showRoughCut && onOpenTimeline && <button type="button" className="secondary"
                  onClick={() => onOpenTimeline(selectedTake.group_id, selectedClipId, currentLocation())}>到时间线</button>}
              </div>,
              footageNotes: (selectedSlate?.take?.note || selectedSlate?.take?.usable_range || selectedSlate?.take?.status === "partial" || activeAngleSlate) ? <>
                <ReviewSlateReference record={selectedSlate?.take} />
                {activeAngle && <ReviewAngleStatus fact={activeAngleSlate} camera={cameraPresentation(activeAngle.camera).label} />}
              </> : undefined,
              slateContext: selectedSlateSuggestion?.derivedSource && (
                <div className="review-slate-bridge">
                  <strong>场记</strong>
                  <p>{selectedSlateSuggestion.derivedSource}</p>
                </div>
              ),
            }}
            afterPlayback={
              <div className="review-decision-stack">
                {preview?.reference && preview.reference.group_id === selectedTake.group_id && (
                  <div className="review-preview-context">
                    {preview.reference.snippet && <details>
                      <summary>{preview.reference.source === "visual" ? "画面描述" : "命中内容"}</summary>
                      <p>{preview.reference.snippet}</p>
                    </details>}
                    {preview.bounded && <button type="button" className="secondary" onClick={() => {
                      setPreview({ ...preview, bounded: false });
                      updateFinder({ takeViewQuery: needle });
                      setRevealedTakeId(selectedTake.group_id);
                    }}>看整条 Take</button>}
                  </div>
                )}
                {selectedAttention?.hasAttention && (
                  <details className="take-attention-summary" open={selectedAttention.tier === "blocking" || undefined}>
                    <summary>需关注 <span>{selectedAttention.labels.length} 项</span></summary>
                    <div className="take-attention-labels">
                      {selectedAttention.labels.slice(0, 4).map((label) => <span key={label}>{label}</span>)}
                    </div>
                    {selectedAttention.context && <p>{selectedAttention.context}</p>}
                  </details>
                )}
              </div>
            }
          /> : <div className="review-monitor-empty">选择素材看片</div>}</div>
          {selectedTake && <footer className="review-action-dock">
            <ReviewDecisionPanel
              baseUrl={baseUrl}
              projectId={project.project_id}
              groupId={selectedTake.group_id}
              onDecisionChange={async (groupId) => {
                if (groupId === selectedGroupId) setMonitorGroupId(groupId);
                await refresh();
              }}
            />
            {transportCount > 0 && <div className="review-transport-actions" role="group"
              aria-label={comparing ? "对比条次" : navigatingFragments ? "片段浏览" : "审阅条次"}>
              <button type="button" className="secondary mo-toolbar-button" aria-label="上一条"
                disabled={previousIndex < 0} onClick={() => selectRelative(-1)}>
                <StudioIcon name="back" size={14} />上一条
              </button>
              <span>{comparing ? "对比 " : navigatingFragments ? "片段 " : ""}{selectedIndex >= 0 ? selectedIndex + 1 : "—"} / {transportCount}</span>
              <button type="button" className="secondary mo-toolbar-button" aria-label="下一条"
                disabled={nextIndex >= transportCount} onClick={() => selectRelative(1)}>
                下一条<StudioIcon name="back" size={14} className="review-forward-icon" />
              </button>
            </div>}
          </footer>}
        </section>}
      </main>}
      {multicamTake && <ReviewCompareDialog title={reviewTakeLabel(multicamTake, needsSequentialTakeNumbers, takeSequenceByGroupId) + " · 多机位同看"}
        onClose={() => setMulticam(null)}>
        <ReviewMulticamMonitor take={multicamTake} connection={connection} projectId={project.project_id}
          slate={slateFacts.get(multicamTake.group_id)} slateReadState={slateReadState}
          scriptBlock={isCoverage && !finder.recovery ? activeScriptBlock : undefined}
          adjacentDialogue={isCoverage && activeSegmentId ? projection?.dialogueByActionTake.get(activeSegmentId)?.get(multicamTake.group_id) : undefined}
          preferredClipId={multicam?.clipId} initialSourceTime={multicam?.time} onOpenRepair={onOpenRepair}
          onWatchAngle={(clipId, time) => { setMulticam(null); watchCoverageAngle(multicamTake, clipId, time); }} />
      </ReviewCompareDialog>}
    </section>
  );
}
