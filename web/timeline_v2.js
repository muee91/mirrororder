(() => {
  const model = {
    open: false,
    items: [],
    source: '当前项目素材时间线',
    zoom: 0.35,
    selectedClipId: '',
  };

  function ensureStyles() {
    if (document.querySelector('link[data-mirrororder-timeline]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/timeline.css';
    link.dataset.mirrororderTimeline = '1';
    document.head.appendChild(link);
  }

  function seconds(value) {
    const raw = String(value || '').trim().replace(/s$/, '');
    if (!raw) return 0;
    if (raw.includes('/')) {
      const [a, b] = raw.split('/', 2).map(Number);
      return b ? a / b : 0;
    }
    const number = Number(raw);
    return Number.isFinite(number) ? number : 0;
  }

  function cleanPath(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    try {
      if (/^file:/i.test(text)) text = new URL(text).pathname;
    } catch (_error) {}
    try { text = decodeURIComponent(text); } catch (_error) {}
    return text.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function projectRows() {
    const map = new Map();
    for (const group of state.groups || []) {
      for (const member of group.members || []) {
        const row = map.get(member.clip_id);
        if (!row) {
          map.set(member.clip_id, {
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
          row.start = Math.min(row.start, Number(member.timeline_start || 0));
          row.end = Math.max(row.end, Number(member.timeline_end || 0));
          row.sourceStart = Math.min(row.sourceStart, Number(member.source_start || 0));
          row.sourceEnd = Math.max(row.sourceEnd, Number(member.source_end ?? member.duration ?? 0));
          row.groupIds.add(group.group_id);
        }
      }
    }
    return [...map.values()].map((row) => ({...row, groupIds: [...row.groupIds]}));
  }

  function currentTimeline() {
    return projectRows().map((row) => ({
      id: `project:${row.clipId}`,
      name: row.name,
      lane: row.camera,
      camera: row.camera,
      start: row.start,
      end: row.end,
      duration: Math.max(0, row.end - row.start),
      sourceStart: row.sourceStart,
      mediaPath: row.mediaPath,
      mediaPaths: row.mediaPath ? [row.mediaPath] : [],
      clipId: row.clipId,
      groupIds: row.groupIds,
      kind: 'asset-clip',
    }));
  }

  function originalMediaPath(asset) {
    const direct = asset.getAttribute('src');
    if (direct) return cleanPath(direct);
    const reps = [...asset.getElementsByTagName('media-rep')];
    const original = reps.find((node) => node.getAttribute('kind') === 'original-media') || reps[0];
    return cleanPath(original?.getAttribute('src') || '');
  }

  function resourceMaps(doc) {
    const assets = new Map();
    for (const asset of [...doc.getElementsByTagName('asset')]) {
      const id = asset.getAttribute('id') || '';
      assets.set(id, {
        id,
        name: asset.getAttribute('name') || '',
        path: originalMediaPath(asset),
      });
    }

    const media = new Map();
    for (const node of [...doc.getElementsByTagName('media')]) {
      const id = node.getAttribute('id') || '';
      const assetRefs = [...node.getElementsByTagName('asset-clip')]
        .map((clip) => clip.getAttribute('ref') || '')
        .filter(Boolean);
      media.set(id, {
        id,
        name: node.getAttribute('name') || '',
        assetRefs: [...new Set(assetRefs)],
      });
    }
    return {assets, media};
  }

  function laneLabel(lane, fallback = '主线') {
    const raw = String(lane ?? '');
    if (raw === '1') return 'A';
    if (raw === '2') return 'B';
    if (raw === '3') return 'C';
    return raw || fallback;
  }

  function resolveResource(ref, resources) {
    const asset = resources.assets.get(ref);
    if (asset) return {name: asset.name, paths: asset.path ? [asset.path] : []};
    const media = resources.media.get(ref);
    if (!media) return {name: '', paths: []};
    const paths = media.assetRefs
      .map((assetRef) => resources.assets.get(assetRef)?.path || '')
      .filter(Boolean);
    return {name: media.name, paths: [...new Set(paths)]};
  }

  function parseFCPXML(text, filename) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML 无法解析');
    const sequence = doc.getElementsByTagName('sequence')[0];
    if (!sequence) throw new Error('XML 中没有 sequence');
    const spine = [...sequence.children].find((node) => node.localName === 'spine')
      || sequence.getElementsByTagName('spine')[0];
    if (!spine) throw new Error('XML 中没有 spine');

    const resources = resourceMaps(doc);
    const items = [];
    let serial = 0;
    const renderable = new Set(['asset-clip', 'ref-clip', 'mc-clip', 'clip', 'gap', 'video', 'audio']);

    function walk(parent, parentStart = 0, depth = 0) {
      let primaryCursor = parentStart;
      for (const element of [...parent.children]) {
        const tag = element.localName;
        const duration = seconds(element.getAttribute('duration'));
        const lane = element.getAttribute('lane') || '';
        const hasOffset = element.hasAttribute('offset');
        let start;
        if (hasOffset) {
          const offset = seconds(element.getAttribute('offset'));
          start = depth === 0 ? offset : parentStart + offset;
        } else if (!lane || lane === '0') {
          start = primaryCursor;
        } else {
          start = parentStart;
        }
        const end = start + Math.max(0, duration);

        if (renderable.has(tag) && duration > 0) {
          const ref = element.getAttribute('ref') || '';
          const resource = resolveResource(ref, resources);
          items.push({
            id: `xml:${serial++}`,
            name: element.getAttribute('name') || resource.name || tag,
            lane: lane || (depth ? String(depth) : '0'),
            camera: laneLabel(lane, depth ? `层${depth}` : '主线'),
            start,
            end,
            duration,
            sourceStart: seconds(element.getAttribute('start')),
            mediaPath: resource.paths[0] || '',
            mediaPaths: resource.paths,
            clipId: '',
            groupIds: [],
            kind: tag,
            ref,
          });
        }

        if ((!lane || lane === '0') && duration > 0) primaryCursor = Math.max(primaryCursor, end);
        if (element.children?.length) walk(element, start, depth + 1);
      }
    }

    walk(spine, 0, 0);
    model.source = filename || 'FCPXML';
    return associate(items);
  }

  function associate(items) {
    const rows = projectRows();
    const byPath = new Map();
    const byName = new Map();
    for (const row of rows) {
      const path = cleanPath(row.mediaPath);
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
      let candidates = [];
      for (const path of item.mediaPaths || []) candidates.push(...(byPath.get(cleanPath(path)) || []));
      if (!candidates.length && item.mediaPath) candidates.push(...(byPath.get(cleanPath(item.mediaPath)) || []));
      if (!candidates.length) candidates.push(...(byName.get(String(item.name || '').toLowerCase()) || []));
      const unique = [...new Map(candidates.map((row) => [row.clipId, row])).values()];
      if (!unique.length) continue;
      const best = [...unique].sort((left, right) => {
        const sourceDelta = (row) => Math.abs(Number(row.sourceStart || 0) - Number(item.sourceStart || 0));
        const durationDelta = (row) => Math.abs((row.end - row.start) - item.duration);
        return (sourceDelta(left) + durationDelta(left) * 0.05) - (sourceDelta(right) + durationDelta(right) * 0.05);
      })[0];
      item.clipId = best.clipId;
      item.groupIds = [...new Set(unique.flatMap((row) => row.groupIds))];
      if (!item.mediaPath) item.mediaPath = best.mediaPath;
      if (!/^[ABC]$/.test(item.camera || '') && /^[ABC]$/.test(best.camera || '')) item.camera = best.camera;
    }
    return items;
  }

  function clock(value) {
    if (typeof formatClock === 'function') return formatClock(value);
    const total = Math.max(0, Number(value || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  function tickStep(secondsPerPixel) {
    const target = Math.max(1, secondsPerPixel * 110);
    return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
      .find((value) => value >= target) || 14400;
  }

  function render() {
    const panel = document.querySelector('#timeline-panel');
    const canvas = document.querySelector('#timeline-canvas');
    const scroll = document.querySelector('#timeline-scroll');
    if (!panel || panel.hidden || !canvas || !scroll) return;
    document.querySelector('#timeline-source').textContent = model.source;
    const items = model.items.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
    if (!items.length) {
      canvas.style.width = '100%';
      canvas.innerHTML = '<div class="timeline-empty">当前没有可预览的时间线片段</div>';
      return;
    }

    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const duration = Math.max(1, maxEnd - minStart);
    const viewport = Math.max(700, scroll.clientWidth - 74);
    const width = Math.max(viewport, duration * model.zoom);
    const px = width / duration;
    canvas.style.width = `${Math.round(width + 74)}px`;

    const labels = [...new Set(items.map((item) => String(item.camera || item.lane || '主线')))];
    const rank = new Map([['主线', 0], ['0', 0], ['A', 1], ['B', 2], ['C', 3]]);
    labels.sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99) || a.localeCompare(b));

    const step = tickStep(1 / px);
    const ticks = [];
    for (let value = Math.floor(minStart / step) * step; value <= maxEnd + step; value += step) {
      const left = (value - minStart) * px;
      if (left >= -5) ticks.push(`<div class="timeline-tick" style="left:${left.toFixed(1)}px"><span>${esc(clock(value))}</span></div>`);
    }

    const tracks = labels.map((label) => {
      const blocks = items.filter((item) => String(item.camera || item.lane || '主线') === label).map((item) => {
        const left = (item.start - minStart) * px;
        const widthPx = Math.max(7, item.duration * px);
        const linked = Boolean(item.clipId);
        const selected = linked && item.clipId === (model.selectedClipId || state.selectedClipId);
        const camera = /^[ABC]$/.test(item.camera || '') ? item.camera : '';
        const classes = ['timeline-clip', camera ? `camera-${camera}` : '', linked ? '' : 'unlinked', item.kind === 'gap' ? 'gap' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
        const meta = `${clock(item.start)} · ${item.duration.toFixed(1)}秒${linked ? '' : ' · 未关联'}`;
        return `<button class="${classes}" data-timeline-item="${esc(item.id)}" data-media-path="${esc(item.mediaPath || '')}" style="left:${left.toFixed(1)}px;width:${widthPx.toFixed(1)}px" type="button" title="${esc(item.mediaPath || item.name)}"><span class="timeline-clip-name">${esc(item.name)}</span><span class="timeline-clip-meta">${esc(meta)}</span></button>`;
      }).join('');
      return `<div class="timeline-track"><div class="timeline-track-label">${esc(label)}</div><div class="timeline-track-clips">${blocks}</div></div>`;
    }).join('');

    canvas.innerHTML = `<div class="timeline-ruler">${ticks.join('')}</div>${tracks}`;
    canvas.querySelectorAll('[data-timeline-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = model.items.find((row) => row.id === button.dataset.timelineItem);
        if (item) focus(item);
      });
    });
    decorateDrags();
  }

  function focus(item) {
    if (!item.clipId) { showToast('这个 XML 片段没有关联到当前项目素材'); return; }
    const groupId = item.groupIds.find((id) => state.groupMap.has(id))
      || state.groups.find((group) => (group.members || []).some((member) => member.clip_id === item.clipId))?.group_id;
    const group = state.groupMap.get(groupId);
    if (!group) { showToast('找到了媒体，但没有找到当前逻辑 Take'); return; }
    const row = matchRowForGroup(group.group_id);
    const candidate = (row.candidates || []).find((entry) => candidateScriptIds(entry).length) || (row.candidates || [])[0];
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
    model.selectedClipId = item.clipId;
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => {
      selectMember(group.group_id, item.clipId, false);
      document.querySelector(`[data-member-clip="${CSS.escape(item.clipId)}"]`)?.scrollIntoView({block: 'nearest'});
      highlight(item.clipId, true);
    });
  }

  function highlight(clipId, reveal = false) {
    model.selectedClipId = clipId || '';
    document.querySelectorAll('[data-timeline-item]').forEach((button) => {
      const item = model.items.find((row) => row.id === button.dataset.timelineItem);
      const active = Boolean(clipId) && item?.clipId === clipId;
      button.classList.toggle('selected', active);
      if (active && reveal && !document.querySelector('#timeline-panel')?.hidden) button.scrollIntoView({block: 'nearest', inline: 'center'});
    });
  }

  function fit() {
    if (!model.items.length) return;
    const min = Math.min(...model.items.map((item) => item.start));
    const max = Math.max(...model.items.map((item) => item.end));
    const viewport = Math.max(700, (document.querySelector('#timeline-scroll')?.clientWidth || 1000) - 74);
    model.zoom = Math.max(0.02, Math.min(12, viewport / Math.max(1, max - min)));
    render();
  }

  function bridge() { return window.webkit?.messageHandlers?.mirrorOrder || null; }

  function decorateDrags() {
    if (!bridge()) return;
    document.documentElement.classList.add('native-mirrororder');
    document.querySelectorAll('[data-member-clip]').forEach((button) => {
      const group = state.groupMap.get(button.dataset.memberGroup);
      const member = group?.members?.find((row) => row.clip_id === button.dataset.memberClip);
      if (!member?.exists || !member.media_path) return;
      button.classList.add('native-file-drag');
      button.dataset.nativeDragPath = member.media_path;
      button.dataset.nativeDragLabel = memberFileName(member);
      button.title = `${member.media_path}\n拖到 FCP / Premiere / Resolve 可作为普通文件导入`;
    });
    document.querySelectorAll('.timeline-clip[data-media-path]').forEach((button) => {
      if (!button.dataset.mediaPath) return;
      button.classList.add('native-file-drag');
      button.dataset.nativeDragPath = button.dataset.mediaPath;
      button.dataset.nativeDragLabel = button.querySelector('.timeline-clip-name')?.textContent || '';
    });
  }

  function installUI() {
    if (document.querySelector('#timeline-panel')) return;
    const toggle = document.createElement('button');
    toggle.id = 'timeline-toggle';
    toggle.className = 'text-button timeline-toggle';
    toggle.type = 'button';
    toggle.textContent = '时间线';
    document.querySelector('.top-actions')?.insertBefore(toggle, document.querySelector('#actor-button'));

    const panel = document.createElement('section');
    panel.id = 'timeline-panel';
    panel.className = 'timeline-panel';
    panel.hidden = true;
    panel.innerHTML = `<header class="timeline-head"><div class="timeline-title"><strong>XML 时间线</strong><span id="timeline-source" class="timeline-source">当前项目素材时间线</span></div><span class="native-drag-hint">App 内可把源素材直接拖到剪辑软件</span><div class="timeline-actions"><button id="timeline-current" class="text-button" type="button">当前项目</button><button id="timeline-load" class="text-button" type="button">加载 XML</button><button id="timeline-zoom-out" class="text-button" type="button">−</button><button id="timeline-fit" class="text-button" type="button">适配</button><button id="timeline-zoom-in" class="text-button" type="button">＋</button><button id="timeline-close" class="text-button" type="button">关闭</button></div><input id="timeline-file" type="file" accept=".fcpxml,.xml,text/xml,application/xml" hidden></header><div id="timeline-scroll" class="timeline-scroll"><div id="timeline-canvas" class="timeline-canvas"></div></div>`;
    document.querySelector('.app-shell')?.appendChild(panel);

    toggle.addEventListener('click', () => {
      model.open = !model.open;
      panel.hidden = !model.open;
      toggle.classList.toggle('active', model.open);
      if (model.open) {
        if (!model.items.length) { model.items = currentTimeline(); model.source = '当前项目素材时间线'; }
        requestAnimationFrame(fit);
      }
    });
    document.querySelector('#timeline-close').addEventListener('click', () => toggle.click());
    document.querySelector('#timeline-current').addEventListener('click', () => { model.items = currentTimeline(); model.source = '当前项目素材时间线'; fit(); });
    document.querySelector('#timeline-load').addEventListener('click', () => document.querySelector('#timeline-file').click());
    document.querySelector('#timeline-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        model.items = parseFCPXML(await file.text(), file.name);
        fit();
        showToast(`已加载时间线：${file.name}`);
      } catch (error) {
        showToast(error.message || 'XML 加载失败');
      } finally { event.target.value = ''; }
    });
    document.querySelector('#timeline-zoom-in').addEventListener('click', () => { model.zoom = Math.min(20, model.zoom * 1.6); render(); });
    document.querySelector('#timeline-zoom-out').addEventListener('click', () => { model.zoom = Math.max(0.01, model.zoom / 1.6); render(); });
    document.querySelector('#timeline-fit').addEventListener('click', fit);
  }

  function installNativeDrag() {
    if (!bridge()) return;
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest('[data-native-drag-path]');
      if (!target) return;
      bridge().postMessage({type: 'prepareFileDrag', path: target.dataset.nativeDragPath, label: target.dataset.nativeDragLabel || ''});
    }, true);
    document.addEventListener('pointerup', () => bridge()?.postMessage({type: 'clearFileDrag'}), true);
  }

  const baseSelectMember = selectMember;
  selectMember = function linkedSelectMember(groupId, clipId, autoplay = false) {
    const result = baseSelectMember(groupId, clipId, autoplay);
    highlight(clipId, false);
    requestAnimationFrame(decorateDrags);
    return result;
  };

  const baseRenderCandidates = renderCandidates;
  renderCandidates = function linkedRenderCandidates() {
    const result = baseRenderCandidates();
    requestAnimationFrame(decorateDrags);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function linkedSwitchProject(projectId) {
    const result = await baseSwitchProject(projectId);
    model.items = currentTimeline();
    model.source = '当前项目素材时间线';
    model.selectedClipId = '';
    if (model.open) requestAnimationFrame(fit);
    return result;
  };

  ensureStyles();
  installUI();
  installNativeDrag();
  const observer = new MutationObserver(decorateDrags);
  const workspace = document.querySelector('#workspace');
  if (workspace) observer.observe(workspace, {childList: true, subtree: true});
  requestAnimationFrame(decorateDrags);
})();
