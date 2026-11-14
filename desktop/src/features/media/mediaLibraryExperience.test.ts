import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

describe("media library experience contract", () => {
  it("plays indexed media from its opaque clip identity through the active Host", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const api = source("../../api/mediaRoles.ts");
    expect(api).toContain("clip_id?: string");
    expect(api).toContain("Opaque material_index clip identity. Never a device path.");
    expect(workbench).toContain("function playbackForItem(");
    expect(workbench).toContain("const indexedClipId = item.clip_id?.trim()");
    expect(workbench).toContain("host.mediaUrl(projectId, indexedClipId)");
    expect(workbench).toContain("reviewFallback");
    expect(workbench).not.toContain("file://");
    expect(workbench).not.toContain("media_path");
  });

  it("keeps Review optional instead of requiring a Take before playback", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("host.reviewModel(projectId).catch(() => null)");
    expect(workbench).toContain("Inventory is the playback authority");
    expect(workbench).toContain("Review is only a compatibility");
    expect(workbench).toContain("playbackForItem(host, projectId, item, playbackByMedia[item.media_id])");
  });

  it("does not let an older refresh overwrite a newer project or inventory snapshot", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const reloadToken = useRef(0)");
    expect(workbench).toContain("const token = ++reloadToken.current");
    expect(workbench).toContain("if (token !== reloadToken.current) return;");
    expect(workbench).toContain("if (token === reloadToken.current) setMessage(errorMessage(error));");
    expect(workbench).toContain("if (token === reloadToken.current) setBusy(false);");
    expect(workbench).toContain("return () => { reloadToken.current += 1; }");
  });

  it("keeps inspector playback explicit while thumbnail hover preview remains best-effort", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("controls");
    expect(workbench).toContain('preload="metadata"');
    expect(workbench).toContain("playsInline");
    expect(workbench).not.toContain("autoPlay");
    expect(workbench).toContain("onMouseEnter");
    expect(workbench).toContain("onMouseLeave");
    expect(workbench).toContain("event.currentTarget.pause()");
    expect(workbench).toContain("这条原片当前无法在 App 内播放");
    expect(workbench).toContain("这条素材尚未进入项目索引");
    expect(workbench).toContain("已入索引，但缺少可播放的 clip identity");
  });

  it("copies the current visible inventory as a pre-edit handoff", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("export function mediaInventoryReport(");
    expect(workbench).toContain("navigator.clipboard.writeText(mediaInventoryReport(visible, roles))");
    expect(workbench).toContain(">复制当前清单</button>");
    expect(workbench).toContain("navigator.clipboard.writeText(mediaInventoryReport(selected, roles))");
    expect(workbench).toContain(">复制已选清单</button>");
  });

  it("surfaces scene-level multicam readiness without treating it as editorial authority", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const styles = source("./media-library.css");
    expect(workbench).toContain("export function sceneCameraReadiness(");
    expect(workbench).toContain("const readySceneCount = sceneReadiness.filter((scene) => scene.ready).length");
    expect(workbench).toContain('aria-label="按场景聚焦素材"');
    expect(workbench).toContain('sceneFilter: string');
    expect(workbench).toContain("role.scene_id?.trim() !== sceneFilter");
    expect(workbench).toContain(">全部场景</button>");
    expect(workbench).toContain('aria-label="场景机位准备度"');
    expect(workbench).toContain("至少两个机位");
    expect(workbench).toContain("showAllScenes");
    expect(workbench).toContain("展开全部 ${sceneReadiness.length} 场");
    expect(workbench).toContain("收起场景");
    expect(workbench).not.toContain("编辑决定");
    expect(styles).toContain(".media-library-scene-readiness");
  });

  it("presents camera as a separate axis from source role", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("media-library-camera-strip");
    expect(workbench).toContain("media-role-camera-editor");
    expect(workbench).toContain("素材角色与同步");
    expect(workbench).toContain("独立于机位");
    expect(workbench).toContain("camera_override");
    expect(workbench).toContain("inferred_camera");
  });

  it("supports list and thumbnail density without replacing the selection Inspector", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const styles = source("./media-library.css");
    expect(workbench).toContain('type ViewMode = "list" | "grid"');
    expect(workbench).toContain('aria-label="素材显示密度"');
    expect(workbench).toContain(">列表</button>");
    expect(workbench).toContain(">缩略图</button>");
    expect(workbench).toContain("media-library-thumb");
    expect(workbench).toContain('aria-label="当前素材 Inspector"');
    expect(styles).toContain(".media-library-list.is-list");
    expect(styles).toContain(".media-library-list.is-grid");
    expect(styles).toContain("grid-template-rows: minmax(250px, .75fr) minmax(420px, 1.25fr)");
    expect(styles).toContain("display: flex !important");
  });

  it("marks active media, scene, and camera filters for assistive technology", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("aria-pressed={filter === value}");
    expect(workbench).toContain("aria-pressed={sceneFilter === \"all\"}");
    expect(workbench).toContain("aria-pressed={sceneFilter === scene.sceneId}");
    expect(workbench).toContain("aria-pressed={cameraFilter === \"all\"}");
    expect(workbench).toContain("aria-pressed={cameraFilter === camera.key}");
  });

  it("exposes scene list expansion state to assistive technology", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("className=\"media-library-scene-more\" aria-expanded={showAllScenes}");
  });

  it("announces loading and selection state to assistive technology", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain('<section className="media-library-workbench" aria-busy={busy}>');
    expect(workbench).toContain('<span className="production-state" aria-live="polite">{message}</span>');
    expect(workbench).toContain('<span aria-live="polite">{selectedIds.size} 条已选');
  });

  it("announces playback recovery states to assistive technology", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain('className="media-library-player-state is-error" aria-live="polite"');
    expect(workbench).toContain('className="media-library-player-state" aria-live="polite"');
  });

  it("offers a keyboard shortcut to focus the media search without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const searchInputRef = useRef<HTMLInputElement>(null)");
    expect(workbench).toContain("if (event.key !== \"/\" || event.metaKey || event.ctrlKey || event.altKey) return");
    expect(workbench).toContain("searchInputRef.current?.focus()");
    expect(workbench).toContain("aria-keyshortcuts=\"/\"");
  });

  it("clears the current batch selection with Escape without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function clearSelection(event: KeyboardEvent): void");
    expect(workbench).toContain('if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !selectedIds.size) return');
    expect(workbench).toContain("setSelectedIds(new Set())");
    expect(workbench).toContain('window.addEventListener("keydown", clearSelection)');
    expect(workbench).toContain('window.removeEventListener("keydown", clearSelection)');
  });

  it("resets all media filters with Cmd/Ctrl+Shift+F without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function resetFiltersOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "f"');
    expect(workbench).toContain("(!event.metaKey && !event.ctrlKey)");
    expect(workbench).toContain("event.shiftKey");
    expect(workbench).toContain('query: "", filter: "all", cameraFilter: "all", sceneFilter: "all", showAllScenes: false');
    expect(workbench).toContain("resetFiltersOnShortcut");
    expect(workbench).toContain('window.removeEventListener("keydown", resetFiltersOnShortcut)');
  });

  it("toggles list and thumbnail density with Cmd/Ctrl+Shift+G without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function toggleViewModeOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "g"');
    expect(workbench).toContain('viewMode: current.viewMode === "list" ? "grid" : "list"');
    expect(workbench).toContain('aria-keyshortcuts="Meta+Shift+G Control+Shift+G"');
    expect(workbench).toContain('window.addEventListener("keydown", toggleViewModeOnShortcut)');
    expect(workbench).toContain('window.removeEventListener("keydown", toggleViewModeOnShortcut)');
  });

  it("selects the current filtered result set with Cmd/Ctrl+A without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function selectVisibleSelection(): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "a"');
    expect(workbench).toContain("(!event.metaKey && !event.ctrlKey)");
    expect(workbench).toContain("selectAllVisibleOnShortcut");
    expect(workbench).toContain("event.preventDefault()");
    expect(workbench).toContain("selectVisibleSelection()");
    expect(workbench).toContain("[selectedIds, visibleIds, roles, visible]");
  });

  it("supports selecting the current filtered result set for batch camera work", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const visibleIds = useMemo(() => visible.map((item) => item.media_id), [visible])");
    expect(workbench).toContain("function toggleVisibleSelection(): void");
    expect(workbench).toContain('aria-label="批量设置机位"');
    expect(workbench).toContain("全选当前结果");
    expect(workbench).toContain("取消全选当前结果");
    expect(workbench).toContain("清空已选");
    expect(workbench).toContain("清除已选机位");
    expect(workbench).toContain("async function saveBulkCamera(cameraOverride = bulkCamera.trim().toUpperCase()")
    expect(workbench).toContain("camera_override: cameraOverride.trim().toUpperCase()");
    expect(workbench).toContain("selectedOutsideFilter");
    expect(workbench).toContain("bulkSelectionLimit = 200");
    expect(workbench).toContain("bulkSelectionOverLimit");
    expect(workbench).toContain("超过单次上限");
    expect(workbench).toContain("aria-pressed={allVisibleSelected}");
    expect(workbench).toContain("批量${actionLabel}时素材库已被其他操作更新");
    expect(workbench).toContain("最近批量结果");
    expect(workbench).toContain("aria-live=\"polite\"");
    expect(workbench).toContain("setBulkResult(result)");
    expect(workbench).toContain("mediaIds: [...selectedIds]");
    expect(workbench).toContain("restoreLastBulkSelection");
    expect(workbench).toContain("const unavailable = bulkResult.mediaIds.length - restored.length");
    expect(workbench).toContain("当前清单不可用");
    expect(workbench).toContain("未改变选择");
    expect(workbench).toContain("重新选中");
  });

  it("surfaces sync-camera rows that still need a camera assignment", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain('"needsCamera"');
    expect(workbench).toContain("待补机位");
    expect(workbench).toContain('effectiveCamera(role.camera_override, item.inferred_camera).label.trim() !== "?"');
    expect(workbench).toContain("isAuxiliary(role)");
  });

  it("shows counts for each status filter in the current search context", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const statusFilterCounts = useMemo");
    expect(workbench).toContain("statusFilterCounts[value]");
    expect(workbench).toContain("<small>{statusFilterCounts[value]}</small>");
  });

  it("supports inverting selection within the current filtered results", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function invertVisibleSelection(): void");
    expect(workbench).toContain("const visibleSet = new Set(visibleIds)");
    expect(workbench).toContain("反选当前结果");
    expect(workbench).toContain("media-library-invert-selection");
    expect(workbench).toContain("受批量上限限制");
  });

  it("supports Cmd/Ctrl+Shift+I for filtered selection inversion without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function invertVisibleOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "i"');
    expect(workbench).toContain("event.shiftKey");
    expect(workbench).toContain("invertVisibleSelection()");
    expect(workbench).toContain("window.removeEventListener(\"keydown\", invertVisibleOnShortcut)");
  });

  it("supports Cmd/Ctrl+Shift+S for copying the selected inventory without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function copySelectedOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "s"');
    expect(workbench).toContain("copySelectedInventory()");
    expect(workbench).toContain("event.shiftKey");
    expect(workbench).toContain("aria-keyshortcuts=\"Meta+Shift+S Control+Shift+S\"");
    expect(workbench).toContain("window.removeEventListener(\"keydown\", copySelectedOnShortcut)");
  });

  it("supports Cmd/Ctrl+Shift+R for refreshing the inventory without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function refreshOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "r"');
    expect(workbench).toContain("void reload()");
    expect(workbench).toContain("aria-keyshortcuts=\"Meta+Shift+R Control+Shift+R\"");
    expect(workbench).toContain("window.removeEventListener(\"keydown\", refreshOnShortcut)");
  });

  it("supports Cmd/Ctrl+Shift+C for copying the current filtered inventory without hijacking text inputs", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("function copyVisibleOnShortcut(event: KeyboardEvent): void");
    expect(workbench).toContain('event.key.toLowerCase() !== "c"');
    expect(workbench).toContain("copyVisibleInventory()");
    expect(workbench).toContain("event.shiftKey");
    expect(workbench).toContain("aria-keyshortcuts=\"Meta+Shift+C Control+Shift+C\"");
    expect(workbench).toContain("window.removeEventListener(\"keydown\", copyVisibleOnShortcut)");
  });

  it("caps select-all to the bulk camera write limit", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const remaining = Math.max(0, bulkSelectionLimit - next.size)");
    expect(workbench).toContain("slice(0, remaining)");
    expect(workbench).toContain("单次最多 {bulkSelectionLimit} 条");
    expect(workbench).toContain("当前筛选结果超过批量上限");
  });

  it("blocks bulk camera writes when a refresh leaves selected media unavailable", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const selectedUnavailableCount = [...selectedIds].filter((mediaId) => !inventoryIds.has(mediaId)).length");
    expect(workbench).toContain("bulkSelectionHasUnavailable");
    expect(workbench).toContain("已不在当前清单");
    expect(workbench).toContain("if (selectedItems.length !== selectedIds.size) return");
    expect(workbench).toContain("function clearUnavailableSelection(): void");
    expect(workbench).toContain("移除不可用选择");
    expect(workbench).toContain("clearUnavailableSelection");
  });

  it("persists the last bulk result per project for reload and project-switch recovery", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("BULK_RESULT_STORAGE_KEY");
    expect(workbench).toContain("storedBulkResult(projectId)");
    expect(workbench).toContain("saveBulkResult(projectId, result)");
    expect(workbench).toContain("setBulkResult(storedBulkResult(projectId))");
    expect(workbench).toContain("Number.isFinite(value.count)");
  });

  it("resets a camera filter when a bulk update removes its last matching bucket", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("if (cameraFilter !== \"all\" && !cameraFilters.some(({ key }) => key === cameraFilter))");
    expect(workbench).toContain('cameraFilter: "all"');
  });

  it("persists selected media ids per project and caps recovered selection", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("const MEDIA_SELECTION_STORAGE_KEY");
    expect(workbench).toContain("storedMediaSelection(projectId)");
    expect(workbench).toContain("saveMediaSelection(projectId, selectedIds)");
    expect(workbench).toContain("setSelectedIds(storedMediaSelection(projectId))");
    expect(workbench).toContain("slice(0, 200)");
    expect(workbench).toContain("new Set([...current].filter((id) => nextInventory.items.some((item) => item.media_id === id)))");
  });

  it("persists the media browser view state per project for long-running pre-edit work", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("type MediaViewState = { query: string; filter: Filter; cameraFilter: string; sceneFilter: string; viewMode: ViewMode; showAllScenes: boolean }");
    expect(workbench).toContain("MEDIA_VIEW_STATE_STORAGE_KEY");
    expect(workbench).toContain("storedMediaViewState(projectId)");
    expect(workbench).toContain("saveMediaViewState(projectId, viewState)");
    expect(workbench).toContain("setViewState(storedMediaViewState(projectId))");
    expect(workbench).toContain("viewMode: modes.includes(value.viewMode as ViewMode)");
    expect(workbench).toContain("filter: filters.includes(value.filter as Filter)");
    expect(workbench).toContain("query: \"\", filter: \"all\", cameraFilter: \"all\", sceneFilter: \"all\", viewMode: \"list\", showAllScenes: false");
  });

  it("keeps the media browser on the shared typography and theme authority", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    const styles = source("./media-library.css");
    expect(workbench).not.toContain("media-library-experience.css");
    expect(styles).toContain("var(--mo-");
    expect(styles).not.toContain("prefers-color-scheme");
    expect(styles).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });
});
