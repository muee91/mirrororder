import { useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewAngle, errorMessage } from "../../api/host";
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
import "./media-library.css";
import "./media-health-adoption.css";
import "./camera-presentation.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenMediaBinding?: () => void;
}

type Filter = "all" | "auxiliary" | "unindexed" | "labeled";
type ViewMode = "list" | "grid";
type PlaybackEntry = { clipId: string; url: string; sourceStart: number };
type CameraFilterItem = { key: string; label: string; tone: CameraTone; sortOrder: number; count: number };

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
      if (!mediaId || !clipId || angle.playback.available === false || result[mediaId]) continue;
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
  if (indexedClipId) {
    return {
      clipId: indexedClipId,
      url: host.mediaUrl(projectId, indexedClipId),
      sourceStart: reviewFallback?.clipId === indexedClipId ? reviewFallback.sourceStart : 0,
    };
  }
  return reviewFallback;
}

function MediaLibraryRow({
  item,
  selected,
  roles,
  preview,
  onSelect,
}: {
  item: MediaInventoryItem;
  selected: boolean;
  roles: MediaRoleStore | null;
  preview: PlaybackEntry | undefined;
  onSelect: () => void;
}) {
  // Viewport-gated preview：屏幕外的行保持静态占位，列表不再一次挂载
  // 上百个 <video> decoder surface（模式与 MirrorOrderMediaCard 一致）。
  const [rowRef, nearViewport] = useNearViewportGate<HTMLButtonElement>(true, "160px 0px");
  const role = roleFor(item, roles);
  const auxiliary = isAuxiliary(role);
  const camera = effectiveCamera(role.camera_override, item.inferred_camera);
  const manualCamera = Boolean(role.camera_override?.trim());
  const healthState = mediaHealthState({ indexed: item.indexed, playable: Boolean(preview) });
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
      <span className="media-library-name"><strong>{item.display_name}</strong><small>{item.folder_label || "素材"}</small></span>
      <span className="media-library-role"><strong>{ROLE_LABELS[role.source_role || "sync_camera"] || role.role_label || role.source_role || "同步机位"}</strong><small>{role.scene_id ? `场 ${role.scene_id}` : auxiliary ? "不参与主机位同步" : ""}</small></span>
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
  const [playbackProjectionLoaded, setPlaybackProjectionLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<MediaRole>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [cameraFilter, setCameraFilter] = useState("all");
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取本机素材清单与共享素材角色…");
  const [busy, setBusy] = useState(false);
  const [playbackFailedMediaId, setPlaybackFailedMediaId] = useState("");
  const [playbackRetry, setPlaybackRetry] = useState(0);

  async function reload(preferredId = selectedId): Promise<void> {
    setBusy(true);
    try {
      // Inventory is the playback authority. Review is only a compatibility
      // fallback for older Host snapshots and supplies a known source start.
      const reviewPromise = host.reviewModel(projectId).catch(() => null);
      const [nextInventory, nextRoles, review] = await Promise.all([client.inventory(projectId), client.roles(projectId), reviewPromise]);
      setInventory(nextInventory);
      setRoles(nextRoles);
      setPlaybackProjectionLoaded(Boolean(review));
      setPlaybackByMedia(review ? playbackIndex(host, projectId, review.take_groups) : {});
      const nextSelected = preferredId && nextInventory.items.some((item) => item.media_id === preferredId)
        ? preferredId
        : nextInventory.items[0]?.media_id ?? "";
      setSelectedId(nextSelected);
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
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void reload(""); }, [client, host, projectId]);

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

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (inventory?.items ?? []).filter((item) => {
      const role = roleFor(item, roles);
      if (cameraFilter !== "all" && cameraFilterKey(role.camera_override, item.inferred_camera) !== cameraFilter) return false;
      if (filter === "auxiliary" && !isAuxiliary(role)) return false;
      if (filter === "unindexed" && item.indexed) return false;
      if (filter === "labeled" && Object.keys(role).length === 0) return false;
      if (!needle) return true;
      return [item.display_name, item.folder_label, item.inferred_camera, role.camera_override, role.source_role, role.role_label, role.scene_id, role.note]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(needle);
    });
  }, [cameraFilter, filter, inventory, query, roles]);

  const visibleLimit = viewMode === "grid" ? 160 : 500;
  const visible = filtered.slice(0, visibleLimit);
  const selectedItem = inventory?.items.find((item) => item.media_id === selectedId) ?? null;
  const selectedPlayback = selectedItem
    ? playbackForItem(host, projectId, selectedItem, playbackByMedia[selectedItem.media_id])
    : undefined;
  const selectedCamera = selectedItem ? effectiveCamera(draft.camera_override, selectedItem.inferred_camera) : null;
  const selectedHasOverride = Boolean(draft.camera_override?.trim());
  const selectedPlaybackFailed = Boolean(selectedItem && playbackFailedMediaId === selectedItem.media_id);

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

  function changeSourceRole(value: MediaSourceRole): void {
    patch({ source_role: value, sync_policy: value === "sync_camera" ? "auto" : "exclude" });
  }

  return (
    <section className="media-library-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">素材</p><h2>素材库</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      </header>

      <div className="media-library-summary">
        <span><strong>{inventory?.summary.files ?? 0}</strong>素材</span>
        <span><strong>{inventory?.summary.indexed ?? 0}</strong>可索引</span>
        <span className={(inventory?.summary.unindexed ?? 0) ? "needs-attention" : ""}><strong>{inventory?.summary.unindexed ?? 0}</strong>待恢复</span>
        <span><strong>{inventory?.summary.labeled ?? 0}</strong>人工标记</span>
        <span><strong>{inventory?.summary.auxiliary ?? 0}</strong>辅助素材</span>
      </div>

      <div className="media-library-toolbar">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件、机位、场景或备注" />
        <div className="media-library-filters" aria-label="素材状态筛选">
          {([["all", "全部"], ["auxiliary", "辅助素材"], ["unindexed", "待恢复"], ["labeled", "已标记"]] as Array<[Filter, string]>).map(([value, filterLabel]) => <button type="button" className={filter === value ? "is-active" : ""} key={value} onClick={() => setFilter(value)}>{filterLabel}</button>)}
        </div>
        <div className="media-library-view-toggle" aria-label="素材显示密度">
          <button type="button" className={viewMode === "list" ? "is-active" : ""} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}>列表</button>
          <button type="button" className={viewMode === "grid" ? "is-active" : ""} aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}>缩略图</button>
        </div>
        <label className="media-library-actor"><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="保存时必填" /></label>
      </div>

      <div className="media-library-camera-strip" aria-label="按机位筛选">
        <span className="media-library-camera-strip-label">机位</span>
        <button type="button" className={cameraFilter === "all" ? "is-active" : ""} onClick={() => setCameraFilter("all")}><strong>全部</strong><small>{inventory?.summary.files ?? 0}</small></button>
        {cameraFilters.map((camera) => (
          <button type="button" key={camera.key} className={cameraFilter === camera.key ? "is-active" : ""} data-camera-tone={camera.tone} onClick={() => setCameraFilter(camera.key)}>
            <strong>{camera.label}</strong><small>{camera.count}</small>
          </button>
        ))}
      </div>

      <div className="media-library-layout">
        <div className={`media-library-list is-${viewMode}`} role="list" aria-label={viewMode === "grid" ? "素材缩略图" : "素材列表"}>
          {visible.map((item) => (
            <MediaLibraryRow
              key={item.media_id}
              item={item}
              selected={selectedId === item.media_id}
              roles={roles}
              preview={playbackForItem(host, projectId, item, playbackByMedia[item.media_id])}
              onSelect={() => select(item)}
            />
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
                  <span className="media-library-monitor-title"><strong>{selectedItem.display_name}</strong><small>{selectedHasOverride ? `人工机位 · 自动识别 ${effectiveCamera("", selectedItem.inferred_camera).label}` : "自动识别机位"}</small></span>
                  <MediaHealthIndicator state={mediaHealthState({ indexed: selectedItem.indexed, playable: Boolean(selectedPlayback), playbackFailed: selectedPlaybackFailed })} />
                </header>
                <div className="media-library-player">
                  {selectedPlayback && !selectedPlaybackFailed ? (
                    <video
                      key={`${selectedPlayback.clipId}-${playbackRetry}`}
                      src={selectedPlayback.url}
                      controls
                      preload="metadata"
                      playsInline
                      onError={() => setPlaybackFailedMediaId(selectedItem.media_id)}
                      onLoadedMetadata={(event) => {
                        const start = selectedPlayback.sourceStart;
                        if (start > 0) {
                          try { event.currentTarget.currentTime = start; } catch { /* media metadata may still be settling */ }
                        }
                      }}
                    />
                  ) : selectedPlaybackFailed ? (
                    <div className="media-library-player-state is-error"><strong>这条原片当前无法在 App 内播放</strong><span>镜序已经通过索引定位素材，但当前 WebView 无法读取或解码它。请先确认素材盘在线；仍失败时可能是编码格式不受当前播放器支持。</span><button type="button" className="secondary" onClick={() => { setPlaybackFailedMediaId(""); setPlaybackRetry((value) => value + 1); }}>重新加载</button></div>
                  ) : !selectedItem.indexed ? (
                    <div className="media-library-player-state"><strong>这条素材尚未进入项目索引</strong><span>未入索引素材不会绕过本机素材身份校验直接按路径播放。</span>{onOpenMediaBinding ? <button type="button" className="secondary" onClick={onOpenMediaBinding}>打开素材恢复</button> : null}</div>
                  ) : (
                    <div className="media-library-player-state"><strong>已入索引，但缺少可播放的 clip identity</strong><span>{playbackProjectionLoaded ? "当前数据来自较旧的索引结构；Review fallback 也没有这条素材。刷新或重新整理项目后再试。" : "当前 Host 没有返回 opaque clip_id。刷新或重新整理项目后再试；素材清单和人工机位仍可继续编辑。"}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload(selectedItem.media_id)}>重新读取</button></div>
                  )}
                </div>
              </section>

              <section className="media-role-camera-editor">
                <div className="media-role-section-heading"><div><p className="eyebrow">机位</p><h3>当前 {selectedCamera.label}</h3></div><span>{selectedHasOverride ? "人工覆盖" : "自动识别"}</span></div>
                <div className="media-role-camera-quick">
                  {["A", "B", "C"].map((camera) => {
                    const presentation = effectiveCamera(camera, "");
                    return <button type="button" key={camera} data-camera-tone={presentation.tone} className={draft.camera_override?.trim().toUpperCase() === camera ? "is-active" : ""} onClick={() => patch({ camera_override: camera })}>{presentation.label}</button>;
                  })}
                  <button type="button" className={!draft.camera_override?.trim() ? "is-active is-auto" : "is-auto"} onClick={() => patch({ camera_override: "" })}>跟随识别</button>
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

              <div className="media-role-savebar"><span>{actor.trim() ? `由 ${actor.trim()} 保存人工制作事实` : "填写操作者后才能保存人工修改"}</span><button type="button" disabled={busy || !actor.trim()} onClick={() => void save()}>保存修改</button></div>
            </>
          ) : <p className="empty-copy">选择一条素材即可监看并整理机位。</p>}
        </aside>
      </div>

      {onOpenMediaBinding ? (
        <div className="media-binding-disclosure"><button type="button" className="secondary" onClick={onOpenMediaBinding}>素材离线或换盘？打开素材恢复</button></div>
      ) : null}
    </section>
  );
}
