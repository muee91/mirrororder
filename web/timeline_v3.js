(() => {
  const timeline = {open: false, items: [], source: '当前项目素材时间线', zoom: .35, selectedClipId: ''};

  function styles() {
    if (document.querySelector('link[data-mirrororder-timeline]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/timeline.css'; link.dataset.mirrororderTimeline = '1';
    document.head.appendChild(link);
  }

  function sec(value) {
    const raw = String(value || '').trim().replace(/s$/, '');
    if (!raw) return 0;
    if (raw.includes('/')) {
      const [a, b] = raw.split('/', 2).map(Number);
      return b ? a / b : 0;
    }
    const n = Number(raw); return Number.isFinite(n) ? n : 0;
  }

  function pathOf(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    try { if (/^file:/i.test(text)) text = new URL(text).pathname; } catch (_error) {}
    try { text = decodeURIComponent(text); } catch (_error) {}
    return text.replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function projectMedia() {
    const map = new Map();
    for (const group of state.groups || []) {
      for (const member of group.members || []) {
        const old = map.get(member.clip_id);
        if (!old) {
          map.set(member.clip_id, {
            clipId: member.clip_id, name: memberFileName(member), camera: member.camera || '?',
            path: member.media_path || '', start: Number(member.timeline_start || 0), end: Number(member.timeline_end || 0),
            sourceStart: Number(member.source_start || 0), sourceEnd: Number(member.source_end ?? member.duration ?? 0),
            groups: new Set([group.group_id]), exists: Boolean(member.exists),
          });
        } else {
          old.start = Math.min(old.start, Number(member.timeline_start || 0));
          old.end = Math.max(old.end, Number(member.timeline_end || 0));
          old.sourceStart = Math.min(old.sourceStart, Number(member.source_start || 0));
          old.sourceEnd = Math.max(old.sourceEnd, Number(member.source_end ?? member.duration ?? 0));
          old.groups.add(group.group_id);
          old.exists ||= Boolean(member.exists);
        }
      }
    }
    return [...map.values()].map((row) => ({...row, groups: [...row.groups]}));
  }

  function projectTimeline() {
    return projectMedia().map((row) => ({
      id: `project:${row.clipId}`, name: row.name, lane: row.camera, camera: row.camera,
      start: row.start, end: row.end, duration: Math.max(0, row.end - row.start), sourceStart: row.sourceStart,
      paths: row.path ? [row.path] : [], dragPath: row.exists ? row.path : '', clipId: row.clipId, groupIds: row.groups,
      kind: 'asset-clip',
    }));
  }

  function assetPath(asset) {
    if (asset.getAttribute('src')) return pathOf(asset.getAttribute('src'));
    const reps = [...asset.getElementsByTagName('media-rep')];
    const original = reps.find((node) => node.getAttribute('kind') === 'original-media') || reps[0];
    return pathOf(original?.getAttribute('src') || '');
  }

  function resources(doc) {
    const assets = new Map();
    for (const asset of [...doc.getElementsByTagName('asset')]) {
      const id = asset.getAttribute('id') || '';
      assets.set(id, {id, name: asset.getAttribute('name') || '', path: assetPath(asset)});
    }
    const media = new Map();
    for (const node of [...doc.getElementsByTagName('media')]) {
      const id = node.getAttribute('id') || '';
      const refs = [...node.getElementsByTagName('asset-clip')].map((clip) => clip.getAttribute('ref') || '').filter(Boolean);
      media.set(id, {id, name: node.getAttribute('name') || '', refs: [...new Set(refs)]});
    }
    return {assets, media};
  }

  function resolved(ref, maps) {
    const asset = maps.assets.get(ref);
    if (asset) return {name: asset.name, paths: asset.path ? [asset.path] : [], dragPath: asset.path || '', direct: true};
    const media = maps.media.get(ref);
    if (!media) return {name: '', paths: [], dragPath: '', direct: false};
    const paths = media.refs.map((id) => maps.assets.get(id)?.path || '').filter(Boolean);
    return {name: media.name, paths: [...new Set(paths)], dragPath: '', direct: false};
  }

  function laneName(lane, fallback = '主线') {
    const raw = String(lane ?? '');
    return ({'1': 'A', '2': 'B', '3': 'C'})[raw] || raw || fallback;
  }

  function parseXML(text, filename) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML 无法解析');
    const project = doc.getElementsByTagName('project')[0];
    const sequence = project?.getElementsByTagName('sequence')[0] || doc.getElementsByTagName('sequence')[0];
    if (!sequence) throw new Error('XML 中没有 project sequence');
    const spine = [...sequence.children].find((node) => node.localName === 'spine') || sequence.getElementsByTagName('spine')[0];
    if (!spine) throw new Error('XML 中没有 spine');
    const maps = resources(doc);
    const items = [];
    const visible = new Set(['asset-clip', 'ref-clip', 'mc-clip', 'clip', 'gap', 'video', 'audio']);
    let serial = 0;

    function walk(parent, parentStart = 0, depth = 0) {
      let cursor = parentStart;
      for (const element of [...parent.children]) {
        const kind = element.localName;
        const duration = sec(element.getAttribute('duration'));
        const lane = element.getAttribute('lane') || '';
        let start;
        if (element.hasAttribute('offset')) {
          const offset = sec(element.getAttribute('offset'));
          start = depth === 0 ? offset : parentStart + offset;
        } else if (!lane || lane === '0') {
          start = cursor;
        } else {
          start = parentStart;
        }
        const end = start + Math.max(0, duration);
        if (visible.has(kind) && duration > 0) {
          const ref = element.getAttribute('ref') || '';
          const resource = resolved(ref, maps);
          const directFile = resource.direct && ['asset-clip', 'video', 'audio'].includes(kind);
          items.push({
            id: `xml:${serial++}`, name: element.getAttribute('name') || resource.name || kind,
            lane: lane || (depth ? String(depth) : '0'), camera: laneName(lane, depth ? `层${depth}` : '主线'),
            start, end, duration, sourceStart: sec(element.getAttribute('start')), paths: resource.paths,
            dragPath: directFile ? resource.dragPath : '', clipId: '', groupIds: [], kind, ref,
          });
        }
        if ((!lane || lane === '0') && duration > 0) cursor = Math.max(cursor, end);
        if (element.children?.length) walk(element, start, depth + 1);
      }
    }
    walk(spine);
    timeline.source = filename || 'FCPXML';
    return associate(items);
  }

  function associate(items) {
    const rows = projectMedia();
    const byPath = new Map(), byName = new Map();
    for (const row of rows) {
      const path = pathOf(row.path);
      if (path) { if (!byPath.has(path)) byPath.set(path, []); byPath.get(path).push(row); }
      const name = String(row.name || '').toLowerCase();
      if (name) { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(row); }
    }
    for (const item of items) {
      let candidates = [];
      for (const path of item.paths || []) candidates.push(...(byPath.get(pathOf(path)) || []));
      if (!candidates.length) candidates.push(...(byName.get(String(item.name || '').toLowerCase()) || []));
      const unique = [...new Map(candidates.map((row) => [row.clipId, row])).values()];
      if (!unique.length) continue;
      const score = (row) => Math.abs(row.sourceStart - item.sourceStart) + Math.abs((row.end - row.start) - item.duration) * .05;
      const best = [...unique].sort((a, b) => score(a) - score(b))[0];
      item.clipId = best.clipId;
      item.groupIds = [...new Set(unique.flatMap((row) => row.groups))];
      if (!/^[ABC]$/.test(item.camera || '') && /^[ABC]$/.test(best.camera || '')) item.camera = best.camera;
      if (!item.dragPath && item.kind === 'asset-clip' && unique.length === 1 && best.exists) item.dragPath = best.path;
    }
    return items;
  }

  function timeText(value) {
    if (typeof formatClock === 'function') return formatClock(value);
    const total = Math.max(0, Number(value || 0)), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  function tick(secondsPerPixel) {
    const target = Math.max(1, secondsPerPixel * 110);
    return [1,2,5,10,15,30,60,120,300,600,900,1800,3600,7200].find((v) => v >= target) || 14400;
  }

  function render() {
    const panel = $('#timeline-panel'), canvas = $('#timeline-canvas'), scroll = $('#timeline-scroll');
    if (!panel || panel.hidden || !canvas || !scroll) return;
    $('#timeline-source').textContent = timeline.source;
    const items = timeline.items.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
    if (!items.length) { canvas.style.width = '100%'; canvas.innerHTML = '<div class="timeline-empty">当前没有可预览的时间线片段</div>'; return; }
    const min = Math.min(...items.map((item) => item.start)), max = Math.max(...items.map((item) => item.end)), duration = Math.max(1, max - min);
    const viewport = Math.max(700, scroll.clientWidth - 74), width = Math.max(viewport, duration * timeline.zoom), px = width / duration;
    canvas.style.width = `${Math.round(width + 74)}px`;
    const labels = [...new Set(items.map((item) => String(item.camera || item.lane || '主线')))];
    const order = new Map([['主线',0],['0',0],['A',1],['B',2],['C',3]]);
    labels.sort((a,b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b));
    const step = tick(1 / px), ruler = [];
    for (let value = Math.floor(min / step) * step; value <= max + step; value += step) {
      const left = (value - min) * px;
      if (left >= -5) ruler.push(`<div class="timeline-tick" style="left:${left.toFixed(1)}px"><span>${esc(timeText(value))}</span></div>`);
    }
    const tracks = labels.map((label) => {
      const blocks = items.filter((item) => String(item.camera || item.lane || '主线') === label).map((item) => {
        const left = (item.start - min) * px, w = Math.max(7, item.duration * px), linked = Boolean(item.clipId);
        const selected = linked && item.clipId === (timeline.selectedClipId || state.selectedClipId);
        const camera = /^[ABC]$/.test(item.camera || '') ? item.camera : '';
        const cls = ['timeline-clip', camera ? `camera-${camera}` : '', linked ? '' : 'unlinked', item.kind === 'gap' ? 'gap' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
        const meta = `${timeText(item.start)} · ${item.duration.toFixed(1)}秒${linked ? '' : ' · 未关联'}`;
        return `<button class="${cls}" data-timeline-item="${esc(item.id)}" data-native-drag-path="${esc(item.dragPath || '')}" style="left:${left.toFixed(1)}px;width:${w.toFixed(1)}px" type="button" title="${esc(item.dragPath || item.name)}"><span class="timeline-clip-name">${esc(item.name)}</span><span class="timeline-clip-meta">${esc(meta)}</span></button>`;
      }).join('');
      return `<div class="timeline-track"><div class="timeline-track-label">${esc(label)}</div><div class="timeline-track-clips">${blocks}</div></div>`;
    }).join('');
    canvas.innerHTML = `<div class="timeline-ruler">${ruler.join('')}</div>${tracks}`;
    canvas.querySelectorAll('[data-timeline-item]').forEach((button) => button.addEventListener('click', () => {
      const item = timeline.items.find((row) => row.id === button.dataset.timelineItem); if (item) focus(item);
    }));
    decorateDragSources();
  }

  function manualScriptIds(group) {
    return (placementForGroup(group).entry?.script_segment_ids || []).filter((id) => state.segmentMap.get(id)?.type !== 'scene_heading');
  }

  function focus(item) {
    if (!item.clipId) { showToast('这个 XML 片段没有关联到当前项目素材'); return; }
    const groupId = item.groupIds.find((id) => state.groupMap.has(id)) || state.groups.find((group) => (group.members || []).some((member) => member.clip_id === item.clipId))?.group_id;
    const group = state.groupMap.get(groupId); if (!group) { showToast('找到了媒体，但没有找到当前逻辑 Take'); return; }
    const manualIds = manualScriptIds(group);
    const auto = (matchRowForGroup(group.group_id).candidates || []).find((candidate) => candidateScriptIds(candidate).length);
    const ids = manualIds.length ? manualIds : candidateScriptIds(auto);
    if (ids.length) {
      const segment = state.segmentMap.get(ids[0]); state.mode = 'script'; state.episode = Number(segment?.episode) || null; state.segmentId = ids[0];
    } else {
      state.mode = 'unassigned'; state.segmentId = null; state.episode = placementForGroup(group).entry?.episode_ids?.[0] ?? inferredEpisodes(group)[0] ?? null;
    }
    state.selectedGroupId = group.group_id; state.selectedClipId = item.clipId; timeline.selectedClipId = item.clipId;
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => { selectMember(group.group_id, item.clipId, false); highlight(item.clipId, true); });
  }

  function highlight(clipId, reveal = false) {
    timeline.selectedClipId = clipId || '';
    document.querySelectorAll('[data-timeline-item]').forEach((button) => {
      const item = timeline.items.find((row) => row.id === button.dataset.timelineItem), active = Boolean(clipId) && item?.clipId === clipId;
      button.classList.toggle('selected', active);
      if (active && reveal && !$('#timeline-panel')?.hidden) button.scrollIntoView({block:'nearest', inline:'center'});
    });
  }

  function fit() {
    if (!timeline.items.length) return;
    const min = Math.min(...timeline.items.map((item) => item.start)), max = Math.max(...timeline.items.map((item) => item.end));
    const viewport = Math.max(700, ($('#timeline-scroll')?.clientWidth || 1000) - 74);
    timeline.zoom = Math.max(.02, Math.min(12, viewport / Math.max(1, max - min))); render();
  }

  const native = () => window.webkit?.messageHandlers?.mirrorOrder || null;

  function decorateDragSources() {
    if (!native()) return;
    document.documentElement.classList.add('native-mirrororder');
    document.querySelectorAll('[data-member-clip]').forEach((button) => {
      const group = state.groupMap.get(button.dataset.memberGroup), member = group?.members?.find((row) => row.clip_id === button.dataset.memberClip);
      if (!member?.exists || !member.media_path) return;
      button.classList.add('native-file-drag'); button.dataset.nativeDragPath = member.media_path; button.dataset.nativeDragLabel = memberFileName(member);
      button.title = `${member.media_path}\n拖到 FCP / Premiere / Resolve 可作为普通文件导入`;
    });
    document.querySelectorAll('.timeline-clip[data-native-drag-path]').forEach((button) => {
      if (!button.dataset.nativeDragPath) return;
      button.classList.add('native-file-drag'); button.dataset.nativeDragLabel = button.querySelector('.timeline-clip-name')?.textContent || '';
    });
  }

  function ui() {
    if ($('#timeline-panel')) return;
    const toggle = document.createElement('button'); toggle.id = 'timeline-toggle'; toggle.className = 'text-button timeline-toggle'; toggle.type = 'button'; toggle.textContent = '时间线';
    document.querySelector('.top-actions')?.insertBefore(toggle, $('#actor-button'));
    const panel = document.createElement('section'); panel.id = 'timeline-panel'; panel.className = 'timeline-panel'; panel.hidden = true;
    panel.innerHTML = `<header class="timeline-head"><div class="timeline-title"><strong>XML 时间线</strong><span id="timeline-source" class="timeline-source">当前项目素材时间线</span></div><span class="native-drag-hint">App 内可把源素材直接拖到剪辑软件</span><div class="timeline-actions"><button id="timeline-current" class="text-button" type="button">当前项目</button><button id="timeline-load" class="text-button" type="button">加载 XML</button><button id="timeline-zoom-out" class="text-button" type="button">−</button><button id="timeline-fit" class="text-button" type="button">适配</button><button id="timeline-zoom-in" class="text-button" type="button">＋</button><button id="timeline-close" class="text-button" type="button">关闭</button></div><input id="timeline-file" type="file" accept=".fcpxml,.xml,text/xml,application/xml" hidden></header><div id="timeline-scroll" class="timeline-scroll"><div id="timeline-canvas" class="timeline-canvas"></div></div>`;
    document.querySelector('.app-shell')?.appendChild(panel);
    toggle.addEventListener('click', () => { timeline.open = !timeline.open; panel.hidden = !timeline.open; toggle.classList.toggle('active', timeline.open); if (timeline.open) { if (!timeline.items.length) { timeline.items = projectTimeline(); timeline.source = '当前项目素材时间线'; } requestAnimationFrame(fit); } });
    $('#timeline-close').addEventListener('click', () => toggle.click());
    $('#timeline-current').addEventListener('click', () => { timeline.items = projectTimeline(); timeline.source = '当前项目素材时间线'; fit(); });
    $('#timeline-load').addEventListener('click', () => $('#timeline-file').click());
    $('#timeline-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      try { timeline.items = parseXML(await file.text(), file.name); fit(); showToast(`已加载时间线：${file.name}`); }
      catch (error) { showToast(error.message || 'XML 加载失败'); }
      finally { event.target.value = ''; }
    });
    $('#timeline-zoom-in').addEventListener('click', () => { timeline.zoom = Math.min(20, timeline.zoom * 1.6); render(); });
    $('#timeline-zoom-out').addEventListener('click', () => { timeline.zoom = Math.max(.01, timeline.zoom / 1.6); render(); });
    $('#timeline-fit').addEventListener('click', fit);
  }

  function dragEvents() {
    if (!native()) return;
    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest('[data-native-drag-path]'); if (!target?.dataset.nativeDragPath) return;
      native().postMessage({type:'prepareFileDrag', path:target.dataset.nativeDragPath, label:target.dataset.nativeDragLabel || ''});
    }, true);
    document.addEventListener('pointerup', () => native()?.postMessage({type:'clearFileDrag'}), true);
  }

  const baseSelect = selectMember;
  selectMember = function linkedMember(groupId, clipId, autoplay = false) { const result = baseSelect(groupId, clipId, autoplay); highlight(clipId); requestAnimationFrame(decorateDragSources); return result; };
  const baseRender = renderCandidates;
  renderCandidates = function linkedCandidates() { const result = baseRender(); requestAnimationFrame(decorateDragSources); return result; };
  const baseSwitch = switchProject;
  switchProject = async function linkedProject(projectId) { const result = await baseSwitch(projectId); timeline.items = projectTimeline(); timeline.source = '当前项目素材时间线'; timeline.selectedClipId = ''; if (timeline.open) requestAnimationFrame(fit); return result; };

  styles(); ui(); dragEvents();
  const observer = new MutationObserver(decorateDragSources), workspace = $('#workspace');
  if (workspace) observer.observe(workspace, {childList:true, subtree:true});
  requestAnimationFrame(decorateDragSources);
})();
