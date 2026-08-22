(() => {
  const timelineState = {
    open: false,
    items: [],
    source: '当前项目素材时间线',
    zoom: 0.35,
    selectedClipId: '',
  };

  function loadStyles() {
    if (document.querySelector('link[data-mirrororder-timeline]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/timeline.css';
    link.dataset.mirrororderTimeline = '1';
    document.head.appendChild(link);
  }

  function parseTime(value) {
    const raw = String(value || '0s').replace(/s$/, '');
    if (!raw) return 0;
    if (raw.includes('/')) {
      const [left, right] = raw.split('/', 2).map(Number);
      return right ? left / right : 0;
    }
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function normalizePath(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    try {
      if (/^file:/i.test(text)) text = new URL(text).pathname;
    } catch (_error) {}
    try { text = decodeURIComponent(text); } catch (_error) {}
    return text.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function projectClipRows() {
    const merged = new Map();
    for (const group of state.groups || []) {
      for (const member of group.members || []) {
        const existing = merged.get(member.clip_id);
        if (!existing) {
          merged.set(member.clip_id, {
            clipId: member.clip_id,
            name: memberFileName(member),
            camera: member.camera || '?',
            mediaPath: member.media_path || '',
            start: Number(member.timeline_start || 0),
            end: Number(member.timeline_end || 0),
            sourceStart: Number(member.source_start || 0),
            sourceEnd: Number(member.source_end ?? member.duration ?? 0),
            groupIds: new Set([group.group_id]),
          });
        } else {
          existing.start = Math.min(existing.start, Number(member.timeline_start || 0));
          existing.end = Math.max(existing.end, Number(member.timeline_end || 0));
          existing.sourceStart = Math.min(existing.sourceStart, Number(member.source_start || 0));
          existing.sourceEnd = Math.max(existing.sourceEnd, Number(member.source_end ?? member.duration ?? 0));
          existing.groupIds.add(group.group_id);
        }
      }
    }
    return [...merged.values()].map((row) => ({...row, groupIds: [...row.groupIds]}));
  }

  function currentProjectTimeline() {
    return projectClipRows().map((row) => ({
      id: `project:${row.clipId}`,
      name: row.name,
      lane: row.camera || '?',
      camera: row.camera || '?',
      start: row.start,
      end: row.end,
      duration: Math.max(0, row.end - row.start),
      sourceStart: row.sourceStart,
      mediaPath: row.mediaPath,
      clipId: row.clipId,
      groupIds: row.groupIds,
      kind: 'asset-clip',
    }));
  }

  function assetMap(documentNode) {
    const result = new Map();
    for (const asset of [...documentNode.getElementsByTagName('asset')]) {
      result.set(asset.getAttribute('id') || '', {
        name: asset.getAttribute('name') || '',
        path: normalizePath(asset.getAttribute('src') || ''),
      });
    }
    return result;
  }

  function cameraForLane(lane) {
    return ({'1': 'A', '2': 'B', '3': 'C'})[String(lane || '')] || String(lane || '主线');
  }

  function parseXMLTimeline(text, sourceName) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML 无法解析');
    const sequence = doc.getElementsByTagName('sequence')[0];
    if (!sequence) throw new Error('XML 中没有 sequence');
    const spine = [...sequence.children].find((node) => node.localName === 'spine')
      || sequence.getElementsByTagName('spine')[0];
    if (!spine) throw new Error('XML 中没有 spine');

    const assets = assetMap(doc);
    const items = [];
    let serial = 0;

    function walk(parent, parentStart = 0, depth = 0) {
      for (const element of [...parent.children]) {
        const tag = element.localName;
        const renderable = ['asset-clip', 'ref-clip', 'mc-clip', 'clip', 'gap'].includes(tag);
        const offset = parseTime(element.getAttribute('offset'));
        const duration = parseTime(element.getAttribute('duration'));
        const absoluteStart = depth === 0 ? offset : parentStart + offset;
        if (renderable && duration > 0) {
          const ref = element.getAttribute('ref') || '';
          const asset = assets.get(ref) || {};
          const lane = element.getAttribute('lane') || (depth === 0 ? '0' : String(depth));
          items.push({
            id: `xml:${serial++}`,
            name: element.getAttribute('name') || asset.name || tag,
            lane,
            camera: cameraForLane(lane),
            start: absoluteStart,
            end: absoluteStart + duration,
            duration,
            sourceStart: parseTime(element.getAttribute('start')),
            mediaPath: asset.path || '',
            clipId: '',
            groupIds: [],
            kind: tag,
            ref,
          });
        }
        if (element.children?.length) walk(element, absoluteStart, depth + 1);
      }
    }

    walk(spine, 0, 0);
    return associateItems(items, sourceName);
  }

  function associateItems(items, sourceName) {
    const projectRows = projectClipRows();
    const byPath = new Map();
    const byName = new Map();
    for (const row of projectRows) {
      const path = normalizePath(row.mediaPath);
      if (path) {
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(row);
      }
      const name = String(row.name || '').toLowerCase();
      if (name) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(row);
      }
    }

    for (const item of items) {
      let candidates = byPath.get(normalizePath(item.mediaPath)) || [];
      if (!candidates.length) candidates = byName.get(String(item.name || '').toLowerCase()) || [];
      if (!candidates.length) continue;
      const best = [...candidates].sort((left, right) => {
        const leftScore = Math.abs(Number(left.sourceStart || 0) - Number(item.sourceStart || 0));
        const rightScore = Math.abs(Number(right.sourceStart || 0) - Number(item.sourceStart || 0));
        return leftScore - rightScore;
      })[0];
      item.clipId = best.clipId;
      item.groupIds = best.groupIds;
      if (!item.mediaPath) item.mediaPath = best.mediaPath;
      if (!item.camera || /^\d+$/.test(item.camera)) item.camera = best.camera;
    }

    timelineState.source = sourceName || 'FCPXML';
    return items;
  }

  function formatTimelineTime(value) {
    if (typeof formatClock === 'function') return formatClock(value);
    const seconds = Math.max(0, Number(value || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  function niceTick(secondsPerPixel) {
    const target = Math.max(1, secondsPerPixel * 110);
    const options = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    return options.find((value) => value >= target) || 7200;
  }

  function renderTimeline() {
    const panel = document.querySelector('#timeline-panel');
    if (!panel || panel.hidden) return;
    const scroll = document.querySelector('#timeline-scroll');
    const canvas = document.querySelector('#timeline-canvas');
    const source = document.querySelector('#timeline-source');
    source.textContent = timelineState.source;

    const items = timelineState.items.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
    if (!items.length) {
      canvas.innerHTML = '<div class="timeline-empty">当前没有可预览的时间线片段</div>';
      canvas.style.width = '100%';
      return;
    }

    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const duration = Math.max(1, maxEnd - minStart);
    const viewport = Math.max(700, scroll.clientWidth - 74);
    const width = Math.max(viewport, duration * timelineState.zoom);
    const pixelsPerSecond = width / duration;
    canvas.style.width = `${Math.round(width + 74)}px`;

    const laneOrder = new Map([['0', 0], ['A', 1], ['1', 1], ['B', 2], ['2', 2], ['C', 3], ['3', 3]]);
    const lanes = [...new Set(items.map((item) => String(item.camera || item.lane || '主线')))]
      .sort((left, right) => (laneOrder.get(left) ?? 99) - (laneOrder.get(right) ?? 99) || left.localeCompare(right));

    const tickEvery = niceTick(1 / pixelsPerSecond);
    const ruler = [];
    const firstTick = Math.floor(minStart / tickEvery) * tickEvery;
    for (let value = firstTick; value <= maxEnd + tickEvery; value += tickEvery) {
      const left = (value - minStart) * pixelsPerSecond;
      if (left < -5) continue;
      ruler.push(`<div class="timeline-tick" style="left:${left.toFixed(1)}px"><span>${esc(formatTimelineTime(value))}</span></div>`);
    }

    const tracks = lanes.map((lane) => {
      const rowItems = items.filter((item) => String(item.camera || item.lane || '主线') === lane);
      const blocks = rowItems.map((item) => {
        const left = (item.start - minStart) * pixelsPerSecond;
        const blockWidth = Math.max(7, item.duration * pixelsPerSecond);
        const linked = Boolean(item.clipId);
        const selected = linked && item.clipId === (timelineState.selectedClipId || state.selectedClipId);
        const camera = /^[ABC]$/.test(item.camera || '') ? item.camera : '';
        const classes = ['timeline-clip', camera ? `camera-${camera}` : '', linked ? '' : 'unlinked', item.kind === 'gap' ? 'gap' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
        const meta = `${formatTimelineTime(item.start)} · ${item.duration.toFixed(1)}秒${linked ? '' : ' · 未关联'}`;
        return `<button class="${classes}" data-timeline-item="${esc(item.id)}" data-media-path="${esc(item.mediaPath || '')}" style="left:${left.toFixed(1)}px;width:${blockWidth.toFixed(1)}px" type="button" title="${esc(item.mediaPath || item.name)}">`
          + `<span class="timeline-clip-name">${esc(item.name)}</span><span class="timeline-clip-meta">${esc(meta)}</span></button>`;
      }).join('');
      return `<div class="timeline-track"><div class="timeline-track-label">${esc(lane)}</div><div class="timeline-track-clips">${blocks}</div></div>`;
    }).join('');

    canvas.innerHTML = `<div class="timeline-ruler">${ruler.join('')}</div>${tracks}`;
    bindTimelineBlocks();
    decorateNativeDraggables();
  }

  function bindTimelineBlocks() {
    document.querySelectorAll('[data-timeline-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = timelineState.items.find((row) => row.id === button.dataset.timelineItem);
        if (item) focusTimelineItem(item);
      });
    });
  }

  function focusTimelineItem(item) {
    if (!item.clipId) {
      showToast('这个 XML 片段没有关联到当前项目素材');
      return;
    }
    const groupId = item.groupIds.find((id) => state.groupMap.has(id))
      || state.groups.find((group) => (group.members || []).some((member) => member.clip_id === item.clipId))?.group_id;
    const group = state.groupMap.get(groupId);
    if (!group) {
      showToast('找到了素材文件，但没有找到当前逻辑 Take');
      return;
    }

    const row = matchRowForGroup(group.group_id);
    const candidate = (row.candidates || []).find((entry) => candidateScriptIds(entry).length)
      || (row.candidates || [])[0];
    const ids = candidateScriptIds(candidate);
    if (ids.length) {
      const segment = state.segmentMap.get(ids[0]);
      state.mode = 'script';
      state.episode = Number.isFinite(Number(segment?.episode)) ? Number(segment.episode) : null;
      state.segmentId = ids[0];
    } else {
      state.mode = 'unassigned';
      state.segmentId = null;
      state.episode = inferredEpisodes(group)[0] ?? null;
    }
    state.selectedGroupId = group.group_id;
    state.selectedClipId = item.clipId;
    timelineState.selectedClipId = item.clipId;
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => {
      selectMember(group.group_id, item.clipId, false);
      document.querySelector(`[data-member-clip="${CSS.escape(item.clipId)}"]`)?.scrollIntoView({block: 'nearest'});
      highlightTimelineSelection(item.clipId, true);
    });
  }

  function highlightTimelineSelection(clipId, scrollIntoView = false) {
    timelineState.selectedClipId = clipId || '';
    document.querySelectorAll('[data-timeline-item]').forEach((button) => {
      const item = timelineState.items.find((row) => row.id === button.dataset.timelineItem);
      const selected = Boolean(clipId) && item?.clipId === clipId;
      button.classList.toggle('selected', selected);
      if (selected && scrollIntoView && !document.querySelector('#timeline-panel')?.hidden) {
        button.scrollIntoView({block: 'nearest', inline: 'center'});
      }
    });
  }

  function fitTimeline() {
    const items = timelineState.items;
    if (!items.length) return;
    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const duration = Math.max(1, maxEnd - minStart);
    const viewport = Math.max(700, (document.querySelector('#timeline-scroll')?.clientWidth || 1000) - 74);
    timelineState.zoom = Math.max(0.02, Math.min(12, viewport / duration));
    renderTimeline();
  }

  function installUI() {
    if (document.querySelector('#timeline-panel')) return;
    const topActions = document.querySelector('.top-actions');
    const button = document.createElement('button');
    button.id = 'timeline-toggle';
    button.className = 'text-button timeline-toggle';
    button.type = 'button';
    button.textContent = '时间线';
    topActions?.insertBefore(button, document.querySelector('#actor-button'));

    const panel = document.createElement('section');
    panel.id = 'timeline-panel';
    panel.className = 'timeline-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header class="timeline-head">
        <div class="timeline-title"><strong>XML 时间线</strong><span id="timeline-source" class="timeline-source">当前项目素材时间线</span></div>
        <span class="native-drag-hint">App 内可把素材直接拖到剪辑软件</span>
        <div class="timeline-actions">
          <button id="timeline-current" class="text-button" type="button">当前项目</button>
          <button id="timeline-load" class="text-button" type="button">加载 XML</button>
          <button id="timeline-zoom-out" class="text-button" type="button" aria-label="缩小">−</button>
          <button id="timeline-fit" class="text-button" type="button">适配</button>
          <button id="timeline-zoom-in" class="text-button" type="button" aria-label="放大">＋</button>
          <button id="timeline-close" class="text-button" type="button">关闭</button>
        </div>
        <input id="timeline-file" type="file" accept=".fcpxml,.xml,text/xml,application/xml" hidden>
      </header>
      <div id="timeline-scroll" class="timeline-scroll"><div id="timeline-canvas" class="timeline-canvas"></div></div>`;
    document.querySelector('.app-shell')?.appendChild(panel);

    button.addEventListener('click', () => {
      timelineState.open = !timelineState.open;
      panel.hidden = !timelineState.open;
      button.classList.toggle('active', timelineState.open);
      if (timelineState.open) {
        if (!timelineState.items.length) {
          timelineState.items = currentProjectTimeline();
          timelineState.source = '当前项目素材时间线';
        }
        requestAnimationFrame(fitTimeline);
      }
    });
    document.querySelector('#timeline-close').addEventListener('click', () => button.click());
    document.querySelector('#timeline-current').addEventListener('click', () => {
      timelineState.items = currentProjectTimeline();
      timelineState.source = '当前项目素材时间线';
      fitTimeline();
    });
    document.querySelector('#timeline-load').addEventListener('click', () => document.querySelector('#timeline-file').click());
    document.querySelector('#timeline-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        timelineState.items = parseXMLTimeline(await file.text(), file.name);
        fitTimeline();
        showToast(`已加载时间线：${file.name}`);
      } catch (error) {
        showToast(error.message || 'XML 加载失败');
      } finally {
        event.target.value = '';
      }
    });
    document.querySelector('#timeline-zoom-in').addEventListener('click', () => {
      timelineState.zoom = Math.min(20, timelineState.zoom * 1.6);
      renderTimeline();
    });
    document.querySelector('#timeline-zoom-out').addEventListener('click', () => {
      timelineState.zoom = Math.max(0.01, timelineState.zoom / 1.6);
      renderTimeline();
    });
    document.querySelector('#timeline-fit').addEventListener('click', fitTimeline);
  }

  function nativeBridge() {
    return window.webkit?.messageHandlers?.mirrorOrder || null;
  }

  function decorateNativeDraggables() {
    const bridge = nativeBridge();
    if (!bridge) return;
    document.documentElement.classList.add('native-mirrororder');
    document.querySelectorAll('[data-member-clip]').forEach((button) => {
      const group = state.groupMap.get(button.dataset.memberGroup);
      const member = group?.members?.find((item) => item.clip_id === button.dataset.memberClip);
      if (member?.media_path && member.exists) {
        button.classList.add('native-file-drag');
        button.dataset.nativeDragPath = member.media_path;
        button.dataset.nativeDragLabel = memberFileName(member);
        button.title = `${member.media_path}\n拖到 FCP / Premiere / Resolve 可作为普通文件导入`;
      }
    });
    document.querySelectorAll('.timeline-clip[data-media-path]').forEach((button) => {
      if (button.dataset.mediaPath) {
        button.classList.add('native-file-drag');
        button.dataset.nativeDragPath = button.dataset.mediaPath;
        button.dataset.nativeDragLabel = button.querySelector('.timeline-clip-name')?.textContent || '';
      }
    });
  }

  function installNativeDragEvents() {
    if (!nativeBridge()) return;
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest('[data-native-drag-path]');
      if (!target) return;
      nativeBridge().postMessage({
        type: 'prepareFileDrag',
        path: target.dataset.nativeDragPath,
        label: target.dataset.nativeDragLabel || '',
      });
    }, true);
    document.addEventListener('pointerup', () => {
      nativeBridge()?.postMessage({type: 'clearFileDrag'});
    }, true);
  }

  const baseSelectMember = selectMember;
  selectMember = function timelineAwareSelectMember(groupId, clipId, autoplay = false) {
    const result = baseSelectMember(groupId, clipId, autoplay);
    highlightTimelineSelection(clipId, false);
    requestAnimationFrame(decorateNativeDraggables);
    return result;
  };

  const baseRenderCandidates = renderCandidates;
  renderCandidates = function timelineAwareRenderCandidates() {
    const result = baseRenderCandidates();
    requestAnimationFrame(decorateNativeDraggables);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function timelineAwareSwitchProject(projectId) {
    const result = await baseSwitchProject(projectId);
    timelineState.items = currentProjectTimeline();
    timelineState.source = '当前项目素材时间线';
    timelineState.selectedClipId = '';
    if (timelineState.open) requestAnimationFrame(fitTimeline);
    return result;
  };

  loadStyles();
  installUI();
  installNativeDragEvents();
  const observer = new MutationObserver(() => decorateNativeDraggables());
  const workspace = document.querySelector('#workspace');
  if (workspace) observer.observe(workspace, {childList: true, subtree: true});
  requestAnimationFrame(decorateNativeDraggables);
})();
