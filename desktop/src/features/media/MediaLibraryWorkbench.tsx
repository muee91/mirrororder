import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewAngle, type ReviewTakeGroup, errorMessage } from "../../api/host";
import { takeDisplayLabel } from "../material-script/TakeCard";
import { classifyPlaybackFailure, type PlaybackFailure } from "./playbackFailure";
import {
  MediaRoleClient,
  type MediaInventory,
  type MediaInventoryItem,
  type MediaRole,
  type MediaRoleStore,
  type MediaSourceRole,
} from "../../api/mediaRoles";
import { MediaHealthIndicator } from "../../components/StatusIndicators";
import { cameraFilterKey, effectiveCamera, type CameraTone } from "./cameraPresentation";
import { mediaHealthState } from "./mediaHealthState";
import { useNearViewportGate } from "./nearViewport";
import { canPreviewReviewPlayback } from "./mediaPlaybackProjection";
import "./media-library.css";
import "./media-health-adoption.css";
import "./camera-presentation.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenMediaBinding?: () => void;
}

type Filter = "all" | "auxiliary" | "unindexed" | "labeled" | "needsCamera";
type ViewMode = "list" | "grid";
type PlaybackEntry = { clipId: string; url: string; sourceStart: number };
type CameraFilterItem = { key: string; label: string; tone: CameraTone; sortOrder: number; count: number };
type BulkResult = { actionLabel: string; count: number; camera: string; revision: number; mediaIds: string[] };
type MediaViewState = { query: string; filter: Filter; cameraFilter: string; sceneFilter: string; viewMode: ViewMode; showAllScenes: boolean };

const BULK_RESULT_STORAGE_KEY = "mirrororder.desktop-v2.media-bulk-result";
const MEDIA_VIEW_STATE_STORAGE_KEY = "mirrororder.desktop-v2.media-view-state";
const MEDIA_SELECTION_STORAGE_KEY = "mirrororder.desktop-v2.media-selection";

const ROLE_LABELS: Record<string, string> = {
  sync_camera: "同步机位",
  aerial: "航拍",
  broll: "空镜 / B-roll",
  gopro: "GoPro",
  insert: "细节 / Insert",
  custom: "自定义",
};

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem("mirrororder.desktop-v2.review-actor")?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveActor(actor: string): void {
  try { globalThis.localStorage?.setItem("mirrororder.desktop-v2.review-actor", actor.trim()); } catch { /* local convenience */ }
}

function storedBulkResult(projectId: string): BulkResult | null {
  if (!projectId.trim()) return null;
  try {
    const raw = globalThis.localStorage?.getItem(`${BULK_RESULT_STORAGE_KEY}:${projectId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<BulkResult>;
    if (typeof value.actionLabel !== "string" || typeof value.count !== "number" || !Number.isFinite(value.count) || value.count < 1 || typeof value.camera !== "string" || typeof value.revision !== "number" || !Number.isFinite(value.revision)) return null;
    const mediaIds = Array.isArray(value.mediaIds) ? value.mediaIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
    return { actionLabel: value.actionLabel, count: value.count, camera: value.camera, revision: value.revision, mediaIds };
  } catch {
    return null;
  }
}

function saveBulkResult(projectId: string, result: BulkResult): void {
  if (!projectId.trim()) return;
  try { globalThis.localStorage?.setItem(`${BULK_RESULT_STORAGE_KEY}:${projectId}`, JSON.stringify(result)); } catch { /* local recovery convenience */ }
}

function storedMediaViewState(projectId: string): MediaViewState {
  const fallback: MediaViewState = { query: "", filter: "all", cameraFilter: "all", sceneFilter: "all", viewMode: "list", showAllScenes: false };
  if (!projectId.trim()) return fallback;
  try {
    const raw = globalThis.localStorage?.getItem(`${MEDIA_VIEW_STATE_STORAGE_KEY}:${projectId}`);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<MediaViewState>;
    const filters: Filter[] = ["all", "auxiliary", "unindexed", "labeled", "needsCamera"];
    const modes: ViewMode[] = ["list", "grid"];
    return {
      query: typeof value.query === "string" ? value.query : fallback.query,
      filter: filters.includes(value.filter as Filter) ? value.filter as Filter : fallback.filter,
      cameraFilter: typeof value.cameraFilter === "string" && value.cameraFilter ? value.cameraFilter : fallback.cameraFilter,
      sceneFilter: typeof value.sceneFilter === "string" && value.sceneFilter ? value.sceneFilter : fallback.sceneFilter,
      viewMode: modes.includes(value.viewMode as ViewMode) ? value.viewMode as ViewMode : fallback.viewMode,
      showAllScenes: value.showAllScenes === true,
    };
  } catch {
    return fallback;
  }
}

function saveMediaViewState(projectId: string, state: MediaViewState): void {
  if (!projectId.trim()) return;
  try { globalThis.localStorage?.setItem(`${MEDIA_VIEW_STATE_STORAGE_KEY}:${projectId}`, JSON.stringify(state)); } catch { /* local convenience */ }
}

function storedMediaSelection(projectId: string): Set<string> {
  if (!projectId.trim()) return new Set();
  try {
    const raw = globalThis.localStorage?.getItem(`${MEDIA_SELECTION_STORAGE_KEY}:${projectId}`);
    if (!raw) return new Set();
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 200));
  } catch {
    return new Set();
  }
}

function saveMediaSelection(projectId: string, selectedIds: Set<string>): void {
  if (!projectId.trim()) return;
  try { globalThis.localStorage?.setItem(`${MEDIA_SELECTION_STORAGE_KEY}:${projectId}`, JSON.stringify([...selectedIds].slice(0, 200))); } catch { /* local convenience */ }
}

function roleFor(item: MediaInventoryItem, store: MediaRoleStore | null): MediaRole {
  return store?.media[item.media_id] ?? item.label ?? {};
}

function isAuxiliary(role: MediaRole): boolean {
  return Boolean((role.source_role && role.source_role !== "sync_camera") || role.sync_policy === "exclude");
}

function defaultDraft(item: MediaInventoryItem, store: MediaRoleStore | null): MediaRole {
  const role = roleFor(item, store);
  const sourceRole = role.source_role || "sync_camera";
  return {
    display_name: item.display_name,
    camera_override: role.camera_override || "",
    source_role: sourceRole,
    role_label: role.role_label || "",
    sync_policy: role.sync_policy || (sourceRole === "sync_camera" ? "auto" : "exclude"),
    scene_id: role.scene_id || "",
    note: role.note || "",
  };
}

export function resolutionLabel(width: number | null | undefined, height: number | null | undefined): string {
  if (!width || !height) return "";
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const p = longEdge >= 3840 ? "4K" : longEdge >= 2560 ? "2K" : shortEdge >= 1080 ? "1080p" : shortEdge >= 720 ? "720p" : "";
  return p ? `${p} ${width}×${height}` : `${width}×${height}`;
}

export interface SceneCameraReadiness {
  sceneId: string;
  mediaCount: number;
  cameraCount: number;
  cameras: string[];
  ready: boolean;
}

export function mediaInventoryReport(items: MediaInventoryItem[], store: MediaRoleStore | null): string {
  const lines = [`素材清单：${items.length} 条`];
  for (const item of items) {
    const role = roleFor(item, store);
    const camera = effectiveCamera(role.camera_override, item.inferred_camera).label;
    const scene = role.scene_id?.trim() ? `场 ${role.scene_id.trim()}` : "未分场";
    const status = item.indexed ? "已入索引" : "待恢复";
    lines.push(`${item.display_name} · ${camera} · ${scene} · ${ROLE_LABELS[role.source_role || "sync_camera"] || role.role_label || role.source_role || "同步机位"} · ${status}`);
  }
  return lines.join("\n");
}

/** Summarize scene-level multicam readiness from human scene assignments.
 * Unknown cameras and auxiliary footage are intentionally excluded: this is
 * a pre-edit signal, not an editorial decision or coverage authority.
 */
export function sceneCameraReadiness(
  items: MediaInventoryItem[],
  store: MediaRoleStore | null,
): SceneCameraReadiness[] {
  const groups = new Map<string, { media: number; cameras: Set<string> }>();
  for (const item of items) {
    const role = roleFor(item, store);
    if (role.source_role && role.source_role !== "sync_camera") continue;
    if (role.sync_policy === "exclude") continue;
    const sceneId = role.scene_id?.trim();
    if (!sceneId) continue;
    const group = groups.get(sceneId) ?? { media: 0, cameras: new Set<string>() };
    group.media += 1;
    const camera = effectiveCamera(role.camera_override, item.inferred_camera).label.trim();
    if (camera && camera !== "?") group.cameras.add(camera);
    groups.set(sceneId, group);
  }
  return [...groups.entries()]
    .map(([sceneId, group]) => ({
      sceneId,
      mediaCount: group.media,
      cameraCount: group.cameras.size,
      cameras: [...group.cameras].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })),
      ready: group.cameras.size >= 2,
    }))
    .sort((left, right) => left.sceneId.localeCompare(right.sceneId, "zh-CN", { numeric: true }));
}

function durationLabel(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) return "";
  const total = Math.round(Number(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, "0")}` : `${total}s`;
}

// 按 media_id 连接（与 playbackIndex 同键）：快照行的 clip_id 只有现代索引才有，
// 而 media_id 在扫描快照与 review angle 上都稳定存在。
function takeLabelIndex(takes: ReviewTakeGroup[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const take of takes) {
    const label = takeDisplayLabel(take);
    for (const angle of take.angles) {
      // 双键注册：media_id 与 clip_id 都可能是行侧唯一可用的连接键。
      for (const key of [angle.media_id?.trim(), angle.clip_id?.trim()]) {
        if (key && label && !result[key]) result[key] = label;
      }
    }
  }
  return result;
}

function inventoryUpdatedLabel(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function playbackIndex(host: HostConnection, projectId: string, takes: Array<{ angles: ReviewAngle[] }>): Record<string, PlaybackEntry> {
  const result: Record<string, PlaybackEntry> = {};
  for (const take of takes) {
    for (const angle of take.angles) {
      const mediaId = angle.media_id?.trim();
      const clipId = angle.clip_id?.trim();
      if (!mediaId || !clipId || !canPreviewReviewPlayback(angle.playback) || result[mediaId]) continue;
      result[mediaId] = {
        clipId,
        url: host.mediaUrl(projectId, clipId),
        sourceStart: angle.playback.source_start ?? angle.source_start ?? 0,
      };
    }
  }
  return result;
}

function playbackForItem(
  host: HostConnection,
  projectId: string,
  item: MediaInventoryItem,
  reviewFallback?: PlaybackEntry,
): PlaybackEntry | undefined {
  const indexedClipId = item.clip_id?.trim();
  if (indexedClipId && item.state === "verified") {
    return {
      clipId: indexedClipId,
      url: host.mediaUrl(projectId, indexedClipId),
      sourceStart: reviewFallback?.clipId === indexedClipId ? reviewFallback.sourceStart : 0,
    };
  }
  // An explicit inventory state wins over an older Review compatibility
  // fallback. A missing/unknown row must never mount a speculative URL.
  if (item.state === "missing" || item.state === "unknown") return undefined;
  return reviewFallback;
}

function MediaLibraryRow({
  item,
  selected,
  roles,
  preview,
  takeLabel,
  onSelect,
}: {
  item: MediaInventoryItem;
  selected: boolean;
  roles: MediaRoleStore | null;
  preview: PlaybackEntry | undefined;
  takeLabel?: string;
  onSelect: () => void;
}) {
  // Viewport-gated preview：屏幕外的行保持静态占位，列表不再一次挂载
  // 上百个 <video> decoder surface（模式与 MirrorOrderMediaCard 一致）。
  const [rowRef, nearViewport] = useNearViewportGate<HTMLButtonElement>(true, "160px 0px");
  const role = roleFor(item, roles);
  const auxiliary = isAuxiliary(role);
  const camera = effectiveCamera(role.camera_override, item.inferred_camera);
  const manualCamera = Boolean(role.camera_override?.trim());
  const healthState = mediaHealthState({ indexed: item.indexed, state: item.state, playable: Boolean(preview) });
  return (
    <button
      ref={rowRef}
      type="button"
      className={`media-library-row ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="media-library-thumb" data-camera-tone={camera.tone} aria-hidden="true">
        {preview && nearViewport ? (
          <video
            src={preview.url}
            muted
            preload="metadata"
            playsInline
            onLoadedMetadata={(event) => {
              if (preview.sourceStart > 0) {
                try { event.currentTarget.currentTime = preview.sourceStart; } catch { /* metadata may still be settling */ }
              }
            }}
            onMouseEnter={(event) => { void event.currentTarget.play().catch(() => undefined); }}
            onMouseLeave={(event) => {
              event.currentTarget.pause();
              if (preview.sourceStart > 0) {
                try { event.currentTarget.currentTime = preview.sourceStart; } catch { /* keep hover scrub best-effort */ }
              }
            }}
          />
        ) : <span className="media-library-thumb-fallback">{camera.label}</span>}
      </span>
      <span className="media-library-camera-block" data-camera-tone={camera.tone}><strong>{camera.label}</strong><small>{manualCamera ? "人工" : "识别"}</small></span>
      <span className="media-library-name"><strong>{item.display_name}</strong><small>{[item.folder_label || "素材", resolutionLabel(item.width, item.height), durationLabel(item.duration_seconds)].filter(Boolean).join(" · ")}</small></span>
      <span className="media-library-role"><strong>{ROLE_LABELS[role.source_role || "sync_camera"] || role.role_label || role.source_role || "同步机位"}</strong><small>{[role.scene_id ? `场 ${role.scene_id}` : "", takeLabel].filter(Boolean).join(" · ") || (auxiliary ? "不参与主机位同步" : "")}</small></span>
      <span className="media-library-row-state"><em className={item.indexed ? "is-indexed" : "is-unindexed"}>{item.indexed ? "已入索引" : "待恢复"}</em><MediaHealthIndicator state={healthState} /></span>
    </button>
  );
}

export function MediaLibraryWorkbench({ baseUrl, projectId, onOpenMediaBinding }: Props) {
  const client = useMemo(() => new MediaRoleClient(baseUrl), [baseUrl]);
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [inventory, setInventory] = useState<MediaInventory | null>(null);
  const [roles, setRoles] = useState<MediaRoleStore | null>(null);
  const [playbackByMedia, setPlaybackByMedia] = useState<Record<string, PlaybackEntry>>({});
  const [takeLabelByClip, setTakeLabelByClip] = useState<Record<string, string>>({});
  const [playbackProjectionLoaded, setPlaybackProjectionLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => storedMediaSelection(projectId));
  const [bulkCamera, setBulkCamera] = useState("");
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(() => storedBulkResult(projectId));
  const [draft, setDraft] = useState<MediaRole>({});
  const [viewState, setViewState] = useState<MediaViewState>(() => storedMediaViewState(projectId));
  const { query, filter, cameraFilter, sceneFilter, viewMode, showAllScenes } = viewState;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取本机素材清单与共享素材角色…");
  const [busy, setBusy] = useState(false);
  const [playbackFailedMediaId, setPlaybackFailedMediaId] = useState("");
  const [playbackFailureDetail, setPlaybackFailureDetail] = useState<PlaybackFailure | null>(null);
  const [playbackRetry, setPlaybackRetry] = useState(0);
  // Inventory, roles, and the optional Review fallback are independent
  // requests. A project switch or a second refresh can otherwise let an
  // older response overwrite the current media browser with stale rows.
  const reloadToken = useRef(0);

  async function reload(preferredId = selectedId): Promise<void> {
    const token = ++reloadToken.current;
    setBusy(true);
    try {
      // Inventory is the playback authority. Review is only a compatibility
      // fallback for older Host snapshots and supplies a known source start.
      const reviewPromise = host.reviewModel(projectId).catch(() => null);
      const [nextInventory, nextRoles, review] = await Promise.all([client.inventory(projectId), client.roles(projectId), reviewPromise]);
      if (token !== reloadToken.current) return;
      setInventory(nextInventory);
      setRoles(nextRoles);
      setPlaybackProjectionLoaded(Boolean(review));
      setPlaybackByMedia(review ? playbackIndex(host, projectId, review.take_groups) : {});
      setTakeLabelByClip(review ? takeLabelIndex(review.take_groups) : {});
      const nextSelected = preferredId && nextInventory.items.some((item) => item.media_id === preferredId)
        ? preferredId
        : nextInventory.items[0]?.media_id ?? "";
      setSelectedId(nextSelected);
      setSelectedIds((current) => new Set([...current].filter((id) => nextInventory.items.some((item) => item.media_id === id))));
      const item = nextInventory.items.find((row) => row.media_id === nextSelected);
      setDraft(item ? defaultDraft(item, nextRoles) : {});
      setPlaybackFailedMediaId("");
      const updated = inventoryUpdatedLabel(nextInventory.inventory_updated_at);
      if (nextInventory.scan_required) {
        setMessage(updated
          ? `素材清单需要重新扫描 · 上次清单 ${updated}`
          : "素材清单尚未扫描 · 请打开本机素材恢复提交扫描任务");
      } else {
        setMessage(`${nextInventory.summary.files} 素材 · ${nextInventory.summary.indexed} 已入索引 · ${nextInventory.summary.auxiliary} 辅助素材${updated ? ` · 清单 ${updated}` : ""}`);
      }
    } catch (error) {
      if (token === reloadToken.current) setMessage(errorMessage(error));
    } finally {
      if (token === reloadToken.current) setBusy(false);
    }
  }

  useEffect(() => {
    setBulkResult(storedBulkResult(projectId));
    setViewState(storedMediaViewState(projectId));
    setSelectedIds(storedMediaSelection(projectId));
    void reload("");
    return () => { reloadToken.current += 1; };
  }, [client, host, projectId]);

  useEffect(() => { saveMediaViewState(projectId, viewState); }, [projectId, viewState]);

  useEffect(() => { saveMediaSelection(projectId, selectedIds); }, [projectId, selectedIds]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent): void {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    }
    function clearSelection(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !selectedIds.size) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      setSelectedIds(new Set());
    }
    function resetFiltersOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "f" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      setViewState((current) => ({ ...current, query: "", filter: "all", cameraFilter: "all", sceneFilter: "all", showAllScenes: false }));
      searchInputRef.current?.focus();
    }
    function toggleViewModeOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "g" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      setViewState((current) => ({ ...current, viewMode: current.viewMode === "list" ? "grid" : "list" }));
    }
    window.addEventListener("keydown", focusSearch);
    window.addEventListener("keydown", clearSelection);
    window.addEventListener("keydown", resetFiltersOnShortcut);
    window.addEventListener("keydown", toggleViewModeOnShortcut);
    return () => {
      window.removeEventListener("keydown", focusSearch);
      window.removeEventListener("keydown", clearSelection);
      window.removeEventListener("keydown", resetFiltersOnShortcut);
      window.removeEventListener("keydown", toggleViewModeOnShortcut);
    };
  }, []);

  const sceneReadiness = useMemo(
    () => sceneCameraReadiness(inventory?.items ?? [], roles),
    [inventory, roles],
  );
  const readySceneCount = sceneReadiness.filter((scene) => scene.ready).length;
  const pendingSceneCount = sceneReadiness.length - readySceneCount;
  const hasActiveFilters = Boolean(query.trim() || filter !== "all" || cameraFilter !== "all" || sceneFilter !== "all");

  function resetMediaFilters(): void {
    setViewState((current) => ({ ...current, query: "", filter: "all", cameraFilter: "all", sceneFilter: "all", showAllScenes: false }));
    searchInputRef.current?.focus();
  }

  const cameraFilters = useMemo(() => {
    const grouped = new Map<string, CameraFilterItem>();
    for (const item of inventory?.items ?? []) {
      const role = roleFor(item, roles);
      const presentation = effectiveCamera(role.camera_override, item.inferred_camera);
      const key = cameraFilterKey(role.camera_override, item.inferred_camera);
      const current = grouped.get(key);
      if (current) current.count += 1;
      else grouped.set(key, { key, label: presentation.label, tone: presentation.tone, sortOrder: presentation.sortOrder, count: 1 });
    }
    return [...grouped.values()].sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
  }, [inventory, roles]);

  useEffect(() => {
    if (cameraFilter !== "all" && !cameraFilters.some(({ key }) => key === cameraFilter)) {
      setViewState((current) => ({ ...current, cameraFilter: "all" }));
    }
  }, [cameraFilter, cameraFilters]);

  useEffect(() => {
    if (sceneFilter !== "all" && !sceneReadiness.some((scene) => scene.sceneId === sceneFilter)) {
      setViewState((current) => ({ ...current, sceneFilter: "all" }));
    }
  }, [sceneFilter, sceneReadiness]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (inventory?.items ?? []).filter((item) => {
      const role = roleFor(item, roles);
      if (cameraFilter !== "all" && cameraFilterKey(role.camera_override, item.inferred_camera) !== cameraFilter) return false;
      if (sceneFilter !== "all" && role.scene_id?.trim() !== sceneFilter) return false;
      if (filter === "auxiliary" && !isAuxiliary(role)) return false;
      if (filter === "needsCamera" && (isAuxiliary(role) || effectiveCamera(role.camera_override, item.inferred_camera).label.trim() !== "?")) return false;
      if (filter === "unindexed" && item.indexed) return false;
      if (filter === "labeled" && Object.keys(role).length === 0) return false;
      if (!needle) return true;
      return [item.display_name, item.folder_label, item.inferred_camera, role.camera_override, role.source_role, role.role_label, role.scene_id, role.note]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(needle);
    });
  }, [cameraFilter, filter, inventory, query, roles, sceneFilter]);

  const statusFilterCounts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const counts = { all: 0, auxiliary: 0, needsCamera: 0, unindexed: 0, labeled: 0 };
    for (const item of inventory?.items ?? []) {
      const role = roleFor(item, roles);
      if (cameraFilter !== "all" && cameraFilterKey(role.camera_override, item.inferred_camera) !== cameraFilter) continue;
      if (sceneFilter !== "all" && role.scene_id?.trim() !== sceneFilter) continue;
      if (needle && ![item.display_name, item.folder_label, item.inferred_camera, role.camera_override, role.source_role, role.role_label, role.scene_id, role.note]
        .join(" ").toLocaleLowerCase("zh-CN").includes(needle)) continue;
      counts.all += 1;
      if (isAuxiliary(role)) counts.auxiliary += 1;
      if (!isAuxiliary(role) && effectiveCamera(role.camera_override, item.inferred_camera).label.trim() === "?") counts.needsCamera += 1;
      if (!item.indexed) counts.unindexed += 1;
      if (Object.keys(role).length > 0) counts.labeled += 1;
    }
    return counts;
  }, [cameraFilter, inventory, query, roles, sceneFilter]);

  const visibleLimit = viewMode === "grid" ? 160 : 500;
  const visible = filtered.slice(0, visibleLimit);

  async function copyVisibleInventory(): Promise<void> {
    if (!visible.length) return;
    try {
      await navigator.clipboard.writeText(mediaInventoryReport(visible, roles));
      setMessage(`已复制 ${visible.length} 条当前素材清单`);
    } catch {
      setMessage("当前环境不允许复制，请手动选择清单");
    }
  }

  async function copySelectedInventory(): Promise<void> {
    const selected = (inventory?.items ?? []).filter((item) => selectedIds.has(item.media_id));
    if (!selected.length) return;
    try {
      await navigator.clipboard.writeText(mediaInventoryReport(selected, roles));
      setMessage(`已复制 ${selected.length} 条已选素材`);
    } catch {
      setMessage("当前环境不允许复制，请手动选择清单");
    }
  }

  const visibleIds = useMemo(() => visible.map((item) => item.media_id), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((mediaId) => selectedIds.has(mediaId));
  const selectedVisibleCount = visibleIds.filter((mediaId) => selectedIds.has(mediaId)).length;
  const selectedOutsideFilter = selectedIds.size - selectedVisibleCount;
  const inventoryIds = useMemo(() => new Set((inventory?.items ?? []).map((item) => item.media_id)), [inventory]);
  const selectedUnavailableCount = [...selectedIds].filter((mediaId) => !inventoryIds.has(mediaId)).length;
  const bulkSelectionHasUnavailable = selectedUnavailableCount > 0;
  const bulkSelectionLimit = 200;
  const bulkSelectionOverLimit = selectedIds.size > bulkSelectionLimit;
  const selectedItem = inventory?.items.find((item) => item.media_id === selectedId) ?? null;
  const selectedPlayback = selectedItem
    ? playbackForItem(host, projectId, selectedItem, playbackByMedia[selectedItem.media_id])
    : undefined;
  const selectedCamera = selectedItem ? effectiveCamera(draft.camera_override, selectedItem.inferred_camera) : null;
  const selectedHasOverride = Boolean(draft.camera_override?.trim());
  const selectedPlaybackFailed = Boolean(selectedItem && playbackFailedMediaId === selectedItem.media_id);
  useEffect(() => {
    if (!selectedPlaybackFailed) setPlaybackFailureDetail(null);
  }, [selectedPlaybackFailed]);

  function selectVisibleSelection(): void {
    const availableToAdd = visibleIds.filter((mediaId) => !selectedIds.has(mediaId));
    const remaining = Math.max(0, bulkSelectionLimit - selectedIds.size);
    if (availableToAdd.length > remaining) {
      setMessage(`当前筛选结果超过批量上限，已先选中 ${remaining} 条；单次最多 ${bulkSelectionLimit} 条`);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      const remaining = Math.max(0, bulkSelectionLimit - next.size);
      visibleIds.filter((mediaId) => !next.has(mediaId)).slice(0, remaining).forEach((mediaId) => next.add(mediaId));
      return next;
    });
  }

  function toggleVisibleSelection(): void {
    if (!allVisibleSelected) {
      selectVisibleSelection();
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleIds.forEach((mediaId) => next.delete(mediaId));
      return next;
    });
  }

  useEffect(() => {
    function refreshOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "r" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      void reload();
    }
    function copySelectedOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "s" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (!selectedIds.size) return;
      event.preventDefault();
      void copySelectedInventory();
    }
    function copyVisibleOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "c" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (!visible.length) return;
      event.preventDefault();
      void copyVisibleInventory();
    }
    function selectAllVisibleOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "a" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      selectVisibleSelection();
    }
    function invertVisibleOnShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (!visibleIds.length) return;
      event.preventDefault();
      invertVisibleSelection();
    }
    window.addEventListener("keydown", refreshOnShortcut);
    window.addEventListener("keydown", copySelectedOnShortcut);
    window.addEventListener("keydown", copyVisibleOnShortcut);
    window.addEventListener("keydown", selectAllVisibleOnShortcut);
    window.addEventListener("keydown", invertVisibleOnShortcut);
    return () => {
      window.removeEventListener("keydown", refreshOnShortcut);
      window.removeEventListener("keydown", copySelectedOnShortcut);
      window.removeEventListener("keydown", copyVisibleOnShortcut);
      window.removeEventListener("keydown", selectAllVisibleOnShortcut);
      window.removeEventListener("keydown", invertVisibleOnShortcut);
    };
  }, [selectedIds, visibleIds, roles, visible]);

  function invertVisibleSelection(): void {
    const visibleSet = new Set(visibleIds);
    const next = new Set([...selectedIds].filter((mediaId) => !visibleSet.has(mediaId)));
    const remaining = Math.max(0, bulkSelectionLimit - next.size);
    visibleIds.filter((mediaId) => !selectedIds.has(mediaId)).slice(0, remaining).forEach((mediaId) => next.add(mediaId));
    const skipped = visibleIds.filter((mediaId) => !selectedIds.has(mediaId)).length - Math.min(remaining, visibleIds.filter((mediaId) => !selectedIds.has(mediaId)).length);
    if (skipped > 0) setMessage(`反选当前结果受批量上限限制，${skipped} 条未选中；单次最多 ${bulkSelectionLimit} 条`);
    setSelectedIds(next);
  }

  function clearUnavailableSelection(): void {
    setSelectedIds((current) => {
      const available = inventoryIds;
      return new Set([...current].filter((mediaId) => available.has(mediaId)));
    });
  }

  function select(item: MediaInventoryItem): void {
    setSelectedId(item.media_id);
    setDraft(defaultDraft(item, roles));
    setPlaybackFailedMediaId("");
    setPlaybackRetry(0);
  }

  function patch(patchValue: Partial<MediaRole>): void {
    setDraft((current) => ({ ...current, ...patchValue }));
  }

  async function save(): Promise<void> {
    if (!selectedItem || !roles) return;
    if (!actor.trim()) {
      setMessage("保存人工素材角色前需要操作者昵称。");
      return;
    }
    setBusy(true);
    saveActor(actor);
    setMessage("正在保存素材角色…");
    try {
      const next = await client.save(projectId, {
        expectedRevision: roles.revision,
        actor,
        mediaId: selectedItem.media_id,
        entry: {
          display_name: selectedItem.display_name,
          camera_override: draft.camera_override?.trim() || "",
          source_role: draft.source_role || "sync_camera",
          role_label: draft.role_label?.trim() || "",
          sync_policy: draft.sync_policy || ((draft.source_role || "sync_camera") === "sync_camera" ? "auto" : "exclude"),
          scene_id: draft.scene_id?.trim() || "",
          note: draft.note?.trim() || "",
        },
      });
      setRoles(next);
      await reload(selectedItem.media_id);
      setMessage(`素材角色已保存 · r${next.revision}`);
    } catch (error) {
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(selectedItem.media_id).catch(() => undefined);
        setMessage("素材角色已被其他操作更新，已刷新到最新状态；请重新确认。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveBulkCamera(cameraOverride = bulkCamera.trim().toUpperCase(), actionLabel = "设置"): Promise<void> {
    if (!roles || !actor.trim() || !selectedIds.size || bulkSelectionOverLimit || bulkSelectionHasUnavailable || (actionLabel === "设置" && !cameraOverride)) return;
    const selectedItems = (inventory?.items ?? []).filter((item) => selectedIds.has(item.media_id));
    if (selectedItems.length !== selectedIds.size) return;
    const count = selectedItems.length;
    setBusy(true);
    setBulkResult(null);
    setMessage(`正在${actionLabel} ${count} 条素材的机位…`);
    try {
      const next = await client.saveMany(projectId, {
        expectedRevision: roles.revision,
        actor,
        changes: selectedItems.map((item) => ({ mediaId: item.media_id, entry: { ...defaultDraft(item, roles), camera_override: cameraOverride.trim().toUpperCase() } })),
      });
      setRoles(next);
      setSelectedIds(new Set());
      await reload(selectedItem?.media_id);
      const result: BulkResult = { actionLabel, count, camera: cameraOverride.trim().toUpperCase() || "跟随识别", revision: next.revision, mediaIds: [...selectedIds] };
      setBulkResult(result);
      saveBulkResult(projectId, result);
      setMessage(`已批量${actionLabel} ${count} 条素材的机位 · r${next.revision}`);
    } catch (error) {
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(selectedItem?.media_id).catch(() => undefined);
        setMessage(`批量${actionLabel}时素材库已被其他操作更新，已刷新到最新状态；请重新确认。`);
      } else {
        setMessage(errorMessage(error));
      }
    } finally { setBusy(false); }
  }

  function restoreLastBulkSelection(): void {
    if (!bulkResult?.mediaIds.length || !inventory) return;
    const available = new Set(inventory.items.map((item) => item.media_id));
    const restored = bulkResult.mediaIds.filter((mediaId) => available.has(mediaId));
    const unavailable = bulkResult.mediaIds.length - restored.length;
    setSelectedIds(new Set(restored));
    if (restored.length && unavailable) {
      setMessage(`已重新选中最近批量处理的 ${restored.length} 条素材 · ${unavailable} 条当前清单不可用`);
    } else if (restored.length) {
      setMessage(`已重新选中最近批量处理的 ${restored.length} 条素材`);
    } else {
      setMessage(`最近批量处理的 ${bulkResult.mediaIds.length} 条素材均不在当前清单，未改变选择`);
    }
  }

  function changeSourceRole(value: MediaSourceRole): void {
    patch({ source_role: value, sync_policy: value === "sync_camera" ? "auto" : "exclude" });
  }

  return (
    <section className="media-library-workbench" aria-busy={busy}>
      <header className="production-heading">
        <div><p className="eyebrow">素材</p><h2>素材库</h2></div>
        <div className="assistant-heading-actions"><span className="production-state" aria-live="polite">{message}</span><button type="button" className="secondary" aria-label="刷新素材清单" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      </header>

      <div
        className={`media-library-summary${inventory?.scan_required ? " is-stale" : ""}`}
        aria-label={inventory?.scan_required ? "上次素材清单统计（当前需要重新扫描）" : "素材清单统计"}
      >
        {inventory?.scan_required ? <span className="media-library-stale-tag">上次清单 · 当前需要重新扫描，以下数字不是当前状态</span> : null}
        <span><strong>{inventory?.summary.files ?? 0}</strong>素材</span>
        <span><strong>{inventory?.summary.indexed ?? 0}</strong>可索引</span>
        <span className={(inventory?.summary.unindexed ?? 0) ? "needs-attention" : ""}><strong>{inventory?.summary.unindexed ?? 0}</strong>待恢复</span>
        <span><strong>{inventory?.summary.labeled ?? 0}</strong>人工标记</span>
        <span><strong>{inventory?.summary.auxiliary ?? 0}</strong>辅助素材</span>
      </div>

      <div className="media-library-toolbar">
        <input ref={searchInputRef} type="search" value={query} onChange={(event) => setViewState((current) => ({ ...current, query: event.target.value }))} placeholder="搜索文件、机位、场景或备注（按 / 聚焦）" aria-keyshortcuts="/" />
        <div className="media-library-filters" aria-label="素材状态筛选">
          {([["all", "全部"], ["auxiliary", "辅助素材"], ["needsCamera", "待补机位"], ["unindexed", "待恢复"], ["labeled", "已标记"]] as Array<[Filter, string]>).map(([value, filterLabel]) => <button type="button" className={filter === value ? "is-active" : ""} aria-label={`按状态筛选：${filterLabel}`} aria-pressed={filter === value} key={value} onClick={() => setViewState((current) => ({ ...current, filter }))}>{filterLabel}<small>{statusFilterCounts[value]}</small></button>)}
          <button type="button" className="secondary media-library-reset-filters" aria-label="清除所有素材筛选" onClick={resetMediaFilters} disabled={!hasActiveFilters}>清除筛选</button>
        </div>
        <div className="media-library-view-toggle" aria-label="素材显示密度" aria-keyshortcuts="Meta+Shift+G Control+Shift+G">
          <button type="button" className={viewMode === "list" ? "is-active" : ""} aria-label="切换到列表视图" aria-pressed={viewMode === "list"} onClick={() => setViewState((current) => ({ ...current, viewMode: "list" }))}>列表</button>
          <button type="button" className={viewMode === "grid" ? "is-active" : ""} aria-label="切换到缩略图视图" aria-pressed={viewMode === "grid"} onClick={() => setViewState((current) => ({ ...current, viewMode: "grid" }))}>缩略图</button>
        </div>
        <label className="media-library-actor"><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="保存时必填" /></label>
        <div className="media-library-bulk" aria-label="批量设置机位"><button type="button" className="secondary media-library-copy-inventory" aria-label="复制当前筛选素材清单" aria-keyshortcuts="Meta+Shift+C Control+Shift+C" disabled={!visible.length} onClick={() => void copyVisibleInventory()}>复制当前清单</button><button type="button" className="secondary media-library-copy-selected" aria-label="复制已选素材清单" aria-keyshortcuts="Meta+Shift+S Control+Shift+S" disabled={!selectedIds.size} onClick={() => void copySelectedInventory()}>复制已选清单</button><button type="button" className="secondary media-library-refresh" aria-label="刷新素材清单" aria-keyshortcuts="Meta+Shift+R Control+Shift+R" disabled={busy} onClick={() => void reload()}>刷新素材</button><button type="button" className="secondary media-library-select-visible" aria-label={allVisibleSelected ? "取消全选当前结果" : "全选当前结果"} aria-pressed={allVisibleSelected} onClick={toggleVisibleSelection}>{allVisibleSelected ? "取消全选当前结果" : "全选当前结果"}</button><button type="button" className="secondary media-library-invert-selection" aria-label="反选当前筛选结果" disabled={!visibleIds.length} onClick={invertVisibleSelection}>反选当前结果</button><button type="button" className="secondary media-library-clear-selection" aria-label="清空已选素材" disabled={!selectedIds.size || busy} onClick={() => setSelectedIds(new Set())}>清空已选</button>{bulkSelectionHasUnavailable ? <button type="button" className="secondary media-library-clear-unavailable" aria-label="移除清单中已不可用的素材选择" disabled={busy} onClick={clearUnavailableSelection}>移除不可用选择</button> : null}<span aria-live="polite">{selectedIds.size} 条已选 · 单次最多 {bulkSelectionLimit} 条{selectedOutsideFilter ? ` · ${selectedOutsideFilter} 条在当前筛选外` : ""}{bulkSelectionOverLimit ? ` · 超过单次上限 ${bulkSelectionLimit} 条` : ""}{bulkSelectionHasUnavailable ? ` · ${selectedUnavailableCount} 条已不在当前清单，请刷新后重新选择` : ""}</span><input aria-label="批量设置机位名称" value={bulkCamera} onChange={(event) => setBulkCamera(event.target.value)} placeholder="机位，例如 A" /><button type="button" className="secondary" aria-label="批量设置已选素材机位" disabled={busy || bulkSelectionOverLimit || bulkSelectionHasUnavailable || !actor.trim() || !bulkCamera.trim() || !selectedIds.size} onClick={() => void saveBulkCamera()}>批量设置机位</button><button type="button" className="secondary" aria-label="清除已选素材机位" disabled={busy || bulkSelectionOverLimit || bulkSelectionHasUnavailable || !actor.trim() || !selectedIds.size} onClick={() => void saveBulkCamera("", "清除")}>清除已选机位</button>{bulkResult ? <output className="media-library-bulk-result" aria-live="polite">最近批量结果：{bulkResult.actionLabel} {bulkResult.count} 条 · {bulkResult.camera} · r{bulkResult.revision}{bulkResult.mediaIds.length ? <button type="button" className="secondary" aria-label="重新选中最近批量结果" onClick={restoreLastBulkSelection} disabled={busy}>重新选中</button> : null}</output> : null}</div>
      </div>

      <div className="media-library-scene-readiness" aria-label="场景机位准备度">
        <span className="media-library-scene-readiness-title">场景机位准备度</span>
        {sceneReadiness.length ? (
          <>
            <span className="is-ready">{readySceneCount} 场已具备多机位</span>
            {pendingSceneCount ? <span className="is-pending">{pendingSceneCount} 场待补机位</span> : null}
            <div className="media-library-scene-readiness-list" aria-label="按场景聚焦素材">
              <button type="button" className={sceneFilter === "all" ? "is-active" : ""} aria-label="按场景筛选：全部场景" aria-pressed={sceneFilter === "all"} onClick={() => setViewState((current) => ({ ...current, sceneFilter: "all" }))}>全部场景</button>
              {(showAllScenes ? sceneReadiness : sceneReadiness.slice(0, 8)).map((scene) => (
                <button type="button" key={scene.sceneId} className={`${scene.ready ? "is-ready" : "is-pending"}${sceneFilter === scene.sceneId ? " is-active" : ""}`} aria-label={`按场景筛选：${scene.sceneId}`} aria-pressed={sceneFilter === scene.sceneId} onClick={() => setViewState((current) => ({ ...current, sceneFilter: scene.sceneId }))}>
                  场 {scene.sceneId} · {scene.cameras.length ? scene.cameras.join("/") : "机位待确认"} · {scene.mediaCount} 条
                </button>
              ))}
              {sceneReadiness.length > 8 ? <button type="button" className="media-library-scene-more" aria-expanded={showAllScenes} onClick={() => setViewState((current) => ({ ...current, showAllScenes: !current.showAllScenes }))}>{showAllScenes ? "收起场景" : `展开全部 ${sceneReadiness.length} 场`}</button> : null}
            </div>
          </>
        ) : <span>先给同步机位素材补充场景归属，系统会提示是否具备至少两个机位。</span>}
      </div>

      <div className="media-library-camera-strip" aria-label="按机位筛选">
        <span className="media-library-camera-strip-label">机位</span>
        <button type="button" className={cameraFilter === "all" ? "is-active" : ""} aria-label="按机位筛选：全部机位" aria-pressed={cameraFilter === "all"} onClick={() => setViewState((current) => ({ ...current, cameraFilter: "all" }))}><strong>全部</strong><small>{inventory?.summary.files ?? 0}</small></button>
        {cameraFilters.map((camera) => (
          <button type="button" key={camera.key} className={cameraFilter === camera.key ? "is-active" : ""} aria-label={`按机位筛选：${camera.label}`} aria-pressed={cameraFilter === camera.key} data-camera-tone={camera.tone} onClick={() => setViewState((current) => ({ ...current, cameraFilter: camera.key }))}>
            <strong>{camera.label}</strong><small>{camera.count}</small>
          </button>
        ))}
      </div>

      <div className="media-library-layout">
        <div className={`media-library-list is-${viewMode}`} role="list" aria-label={viewMode === "grid" ? "素材缩略图" : "素材列表"}>
          {visible.map((item) => (
            <div className="media-library-row-wrap" key={item.media_id}>
              <input aria-label={`选择 ${item.display_name}`} type="checkbox" checked={selectedIds.has(item.media_id)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(item.media_id)) next.delete(item.media_id); else next.add(item.media_id); return next; })} />
              <MediaLibraryRow item={item} selected={selectedId === item.media_id} roles={roles} preview={playbackForItem(host, projectId, item, playbackByMedia[item.media_id])} takeLabel={takeLabelByClip[item.media_id] ?? (item.clip_id?.trim() ? takeLabelByClip[item.clip_id.trim()] : undefined)} onSelect={() => select(item)} />
            </div>
          ))}
          {filtered.length > visible.length ? <p className="production-note">当前显示前 {visible.length} 条；继续缩小搜索范围以定位其它素材。</p> : null}
          {!visible.length ? <p className="empty-copy">当前筛选下没有素材。</p> : null}
        </div>

        <aside className="media-role-inspector" aria-label="当前素材 Inspector">
          {selectedItem && selectedCamera ? (
            <>
              <section className="media-library-monitor">
                <header>
                  <span className="media-library-monitor-camera" data-camera-tone={selectedCamera.tone}>{selectedCamera.label}</span>
                  <span className="media-library-monitor-title"><strong>{selectedItem.display_name}</strong><small>{[resolutionLabel(selectedItem.width, selectedItem.height), durationLabel(selectedItem.duration_seconds), selectedHasOverride ? `人工机位 · 自动识别 ${effectiveCamera("", selectedItem.inferred_camera).label}` : "自动识别机位"].filter(Boolean).join(" · ")}</small></span>
                  <MediaHealthIndicator state={mediaHealthState({ indexed: selectedItem.indexed, state: selectedItem.state, playable: Boolean(selectedPlayback), playbackFailed: selectedPlaybackFailed })} />
                </header>
                <div className="media-library-player">
                  {selectedPlayback && !selectedPlaybackFailed ? (
                    <video
                      key={`${selectedPlayback.clipId}-${playbackRetry}`}
                      src={selectedPlayback.url}
                      controls
                      preload="metadata"
                      playsInline
                      onError={() => { setPlaybackFailedMediaId(selectedItem.media_id); void classifyPlaybackFailure(selectedPlayback.url).then(setPlaybackFailureDetail); }}
                      onLoadedMetadata={(event) => {
                        const start = selectedPlayback.sourceStart;
                        if (start > 0) {
                          try { event.currentTarget.currentTime = start; } catch { /* media metadata may still be settling */ }
                        }
                      }}
                    />
                  ) : selectedPlaybackFailed ? (
                    <div className="media-library-player-state is-error" aria-live="polite"><strong>这条原片当前无法在 App 内播放</strong><span>{playbackFailureDetail?.detail ?? "正在确认失败原因；可先确认素材盘在线后重新加载。"}</span><button type="button" className="secondary" aria-label="重新加载当前素材播放" onClick={() => { setPlaybackFailedMediaId(""); setPlaybackRetry((value) => value + 1); }}>重新加载</button></div>
                  ) : selectedItem.state === "missing" ? (
                    <div className="media-library-player-state" aria-live="polite"><strong>本机当前找不到这条素材</strong><span>设备绑定曾经确认过它，但文件已移动或素材盘暂时离线。重新连接素材后再加载。</span>{onOpenMediaBinding ? <button type="button" className="secondary" aria-label="打开素材恢复" onClick={onOpenMediaBinding}>打开素材恢复</button> : null}</div>
                  ) : selectedItem.state === "unknown" ? (
                    <div className="media-library-player-state" aria-live="polite"><strong>这条素材尚未在本机确认</strong><span>它有项目索引，但当前设备没有可验证的绑定。先扫描并确认素材位置，再开始播放。</span>{onOpenMediaBinding ? <button type="button" className="secondary" aria-label="打开素材恢复" onClick={onOpenMediaBinding}>打开素材恢复</button> : null}</div>
                  ) : !selectedItem.indexed ? (
                    <div className="media-library-player-state" aria-live="polite"><strong>这条素材尚未进入项目索引</strong><span>未入索引素材不会绕过本机素材身份校验直接按路径播放。</span>{onOpenMediaBinding ? <button type="button" className="secondary" aria-label="打开素材恢复" onClick={onOpenMediaBinding}>打开素材恢复</button> : null}</div>
                  ) : (
                    <div className="media-library-player-state" aria-live="polite"><strong>已入索引，但缺少可播放的 clip identity</strong><span>{playbackProjectionLoaded ? "当前数据来自较旧的索引结构；Review fallback 也没有这条素材。刷新或重新整理项目后再试。" : "当前 Host 没有返回 opaque clip_id。刷新或重新整理项目后再试；素材清单和人工机位仍可继续编辑。"}</span><button type="button" className="secondary" aria-label="重新读取当前素材" disabled={busy} onClick={() => void reload(selectedItem.media_id)}>重新读取</button></div>
                  )}
                </div>
              </section>

              <section className="media-role-camera-editor">
                <div className="media-role-section-heading"><div><p className="eyebrow">机位</p><h3>当前 {selectedCamera.label}</h3></div><span>{selectedHasOverride ? "人工覆盖" : "自动识别"}</span></div>
                <div className="media-role-camera-quick">
                  {["A", "B", "C"].map((camera) => {
                    const presentation = effectiveCamera(camera, "");
                    return <button type="button" key={camera} data-camera-tone={presentation.tone} aria-label={`设置机位 ${presentation.label}`} className={draft.camera_override?.trim().toUpperCase() === camera ? "is-active" : ""} onClick={() => patch({ camera_override: camera })}>{presentation.label}</button>;
                  })}
                  <button type="button" aria-label="跟随自动识别机位" className={!draft.camera_override?.trim() ? "is-active is-auto" : "is-auto"} onClick={() => patch({ camera_override: "" })}>跟随识别</button>
                </div>
                <label className="production-field"><span>自定义机位</span><input value={draft.camera_override || ""} onChange={(event) => patch({ camera_override: event.target.value })} placeholder={`自动识别：${effectiveCamera("", selectedItem.inferred_camera).label}`} /></label>
              </section>

              <section className="media-role-fields">
                <div className="media-role-section-heading"><div><p className="eyebrow">用途</p><h3>素材角色与同步</h3></div><span>独立于机位</span></div>
                <label className="production-field"><span>素材角色</span><select value={draft.source_role || "sync_camera"} onChange={(event) => changeSourceRole(event.target.value)}><option value="sync_camera">同步机位</option><option value="aerial">航拍</option><option value="broll">空镜 / B-roll</option><option value="gopro">GoPro</option><option value="insert">细节 / Insert</option><option value="custom">自定义</option></select></label>
                <label className="production-field"><span>同步策略</span><select value={draft.sync_policy || "auto"} onChange={(event) => patch({ sync_policy: event.target.value })}><option value="auto">参与同步</option><option value="exclude">不参与同步</option></select></label>
                <label className="production-field"><span>场景归属</span><input value={draft.scene_id || ""} onChange={(event) => patch({ scene_id: event.target.value })} placeholder="例如 12-3" /></label>
                <label className="production-field"><span>自定义标签</span><input value={draft.role_label || ""} onChange={(event) => patch({ role_label: event.target.value })} placeholder="例如 城市建立镜头" /></label>
                <label className="production-field"><span>备注</span><textarea rows={4} value={draft.note || ""} onChange={(event) => patch({ note: event.target.value })} placeholder="场记或剪辑用途，例如：饭店外景建立镜头" /></label>
              </section>

              <div className="media-role-savebar"><span>{actor.trim() ? `由 ${actor.trim()} 保存人工制作事实` : "填写操作者后才能保存人工修改"}</span><button type="button" aria-label="保存素材角色修改" disabled={busy || !actor.trim()} onClick={() => void save()}>保存修改</button></div>
            </>
          ) : <p className="empty-copy">选择一条素材即可监看并整理机位。</p>}
        </aside>
      </div>

      {onOpenMediaBinding ? (
        <div className="media-binding-disclosure"><button type="button" className="secondary" aria-label="打开素材恢复" onClick={onOpenMediaBinding}>素材离线或换盘？打开素材恢复</button></div>
      ) : null}
    </section>
  );
}
