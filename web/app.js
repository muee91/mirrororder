const state = {
  workspaces: [],
  workspace: {projects: []},
  workspaceId: '',
  session: '',
  frontendSettings: {
    version: 1,
    theme: 'system',
    density: 'comfortable',
    default_mode: 'script',
    default_episode: 'first',
    poll_interval_ms: 2500,
    update_sound: true,
    show_unknown_count: true,
  },
  projectId: '',
  project: null,
  script: {segments: []},
  groups: [],
  matches: {groups: {}, by_segment: {}},
  review: {version: 2, revision: 0, assignments: {}, groups: {}, clips: {}, placements: {}},
  groupMap: new Map(),
  segmentMap: new Map(),
  episode: null,
  segmentId: null,
  mode: 'script',
  unknownOnly: false,
  selectedGroupId: null,
  selectedClipId: null,
  playerEnd: null,
  playerStart: 0,
  placementGroupId: null,
  actor: '',
  analysisRevision: '',
  reviewRevision: 0,
  pollTimer: null,
  searchTimer: null,
  searchController: null,
  audioUnlocked: false,
  tasks: [],
  proposals: [],
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));
const cameraOrder = {A: 0, B: 1, C: 2};

function projectApi(path = '') {
  if (!state.workspaceId || !state.projectId) throw new Error('尚未选择工作区或项目');
  return `/api/v1/workspaces/${encodeURIComponent(state.workspaceId)}/projects/${encodeURIComponent(state.projectId)}${path}`;
}

function workspaceApi(path = '') {
  if (!state.workspaceId) throw new Error('尚未选择工作区');
  return `/api/v1/workspaces/${encodeURIComponent(state.workspaceId)}${path}`;
}

function applyFrontendSettings(settings) {
  state.frontendSettings = {...state.frontendSettings, ...settings};
  document.documentElement.dataset.theme = state.frontendSettings.theme;
  document.documentElement.dataset.density = state.frontendSettings.density;
}

function applyWorkbenchDefaults() {
  const episodes = episodeList();
  const preference = state.frontendSettings.default_episode;
  if (preference === 'all') {
    state.episode = null;
  } else if (preference === 'first') {
    state.episode = episodes[0] ?? null;
  } else {
    const requestedEpisode = Number(preference);
    state.episode = episodes.includes(requestedEpisode) ? requestedEpisode : (episodes[0] ?? null);
  }
  state.mode = state.frontendSettings.default_mode === 'unassigned' ? 'unassigned' : 'script';
  state.segmentId = state.mode === 'script'
    ? visibleSegments().find((segment) => segment.type !== 'scene_heading')?.segment_id || null
    : null;
  state.selectedGroupId = null;
  state.selectedClipId = null;
}

async function fetchJson(url, options = {}) {
  const headers = {
    ...(state.session ? {'X-MirrorOrder-Session': state.session} : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(url, {cache: 'no-store', credentials: 'same-origin', ...options, headers});
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return response.json();
}

function allSegments() {
  return state.script?.segments || [];
}

function matchableSegments() {
  return allSegments().filter((segment) => segment.type !== 'scene_heading');
}

function episodeList() {
  return [...new Set(allSegments().map((segment) => Number(segment.episode)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function memberFileName(member) {
  const path = String(member?.media_path || '');
  return path.split(/[\\/]/).pop() || member?.name || member?.clip_id || '未命名素材';
}

function formatClock(value) {
  const total = Math.max(0, Number(value || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function formatModified(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function candidateScriptIds(candidate) {
  if (!candidate) return [];
  const ids = candidate.script_segment_ids || (candidate.script_segment_id ? [candidate.script_segment_id] : []);
  return ids.filter((id) => state.segmentMap.get(id)?.type !== 'scene_heading');
}

function matchRowForGroup(groupId) {
  return state.matches?.groups?.[groupId] || {candidates: [], context_episodes: []};
}

function scriptGapForSegment(segmentId) {
  return (state.matches?.script_gaps || []).find((gap) => (
    gap.segment_ids || []
  ).includes(segmentId)) || null;
}

function placementForGroup(group) {
  if (!group) return {entry: null, inherited: false};
  const direct = state.review?.placements?.[group.group_id];
  if (direct) return {entry: direct, inherited: false};
  if (group.parent_group_id) {
    const parent = state.review?.placements?.[group.parent_group_id];
    if (parent) return {entry: parent, inherited: true};
  }
  return {entry: null, inherited: false};
}

function groupReviewEntry(group) {
  if (!group) return {entry: null, inherited: false};
  const direct = state.review?.groups?.[group.group_id];
  if (direct) return {entry: direct, inherited: false};
  if (group.parent_group_id) {
    const parent = state.review?.groups?.[group.parent_group_id];
    if (parent) return {entry: parent, inherited: true};
  }
  return {entry: null, inherited: false};
}

function assignmentEntry(segmentId, group) {
  if (!segmentId || !group) return {entry: null, inherited: false};
  const rows = state.review?.assignments?.[segmentId] || {};
  if (rows[group.group_id]) return {entry: rows[group.group_id], inherited: false};
  if (group.parent_group_id && rows[group.parent_group_id]) {
    return {entry: rows[group.parent_group_id], inherited: true};
  }
  return {entry: null, inherited: false};
}

function effectiveReviewEntry(segmentId, group) {
  const assignment = assignmentEntry(segmentId, group);
  if (assignment.entry) return assignment;
  return groupReviewEntry(group);
}

function assignmentState(segmentId, group) {
  const review = effectiveReviewEntry(segmentId, group);
  if (review.entry?.state) return review.entry.state;
  const clipStates = (group?.members || []).map((member) => state.review?.clips?.[member.clip_id]?.state);
  return clipStates.includes('reject') ? 'reject' : 'unreviewed';
}

function automaticCandidatesForSegment(segmentId) {
  return state.matches?.by_segment?.[segmentId] || [];
}

function candidateForSegment(segmentId) {
  if (state.segmentMap.get(segmentId)?.type === 'scene_heading') return [];
  const candidates = [...automaticCandidatesForSegment(segmentId)];
  const known = new Set(candidates.map((candidate) => candidate.group_id));
  for (const group of state.groups) {
    const placement = placementForGroup(group).entry;
    if (!placement || !placement.script_segment_ids?.includes(segmentId) || known.has(group.group_id)) continue;
    candidates.push({
      group_id: group.group_id,
      confidence: 'manual',
      total_score: 1,
      script_segment_ids: placement.script_segment_ids,
      transcript_text: matchRowForGroup(group.group_id).candidates?.[0]?.transcript_text || '',
      evidence: ['人工归集到此剧本范围'],
    });
  }
  return candidates.sort((left, right) => {
    const leftGroup = state.groupMap.get(left.group_id);
    const rightGroup = state.groupMap.get(right.group_id);
    return Number(leftGroup?.start || 0) - Number(rightGroup?.start || 0);
  });
}

function inferredEpisodes(group) {
  const placement = placementForGroup(group).entry;
  if (placement?.episode_ids?.length) return [...placement.episode_ids];
  const row = matchRowForGroup(group.group_id);
  const episodes = [...(row.context_episodes || [])];
  for (const candidate of row.candidates || []) {
    for (const segmentId of candidateScriptIds(candidate)) {
      const episode = Number(state.segmentMap.get(segmentId)?.episode);
      if (Number.isFinite(episode)) episodes.push(episode);
    }
  }
  return [...new Set(episodes)].sort((a, b) => a - b);
}

function isUnassignedGroup(group) {
  const placement = placementForGroup(group).entry;
  if (placement?.script_segment_ids?.length) return false;
  const candidates = matchRowForGroup(group.group_id).candidates || [];
  return !candidates.length || candidates.every((candidate) => candidate.confidence === 'context_only');
}

function visibleUnassignedGroups() {
  return state.groups
    .filter((group) => {
      if (!isUnassignedGroup(group)) return false;
      if (state.episode === null) return true;
      return inferredEpisodes(group).includes(state.episode);
    })
    .sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
}

function stateForSegment(segmentId) {
  const candidates = candidateForSegment(segmentId);
  const states = candidates.map((candidate) => assignmentState(segmentId, state.groupMap.get(candidate.group_id)));
  if (states.includes('best')) return 'best';
  if (states.includes('keep')) return 'keep';
  if (candidates.some((candidate) => ['manual', 'exact_dialogue'].includes(candidate.confidence))) return 'possible';
  if (candidates.some((candidate) => candidate.confidence === 'possible_dialogue')) return 'possible';
  const contextGroups = Object.entries(state.matches?.groups || {}).filter(([, item]) => (
    item.context_segment_ids || []
  ).includes(segmentId));
  if (contextGroups.length) return 'context';
  if (scriptGapForSegment(segmentId)) return 'gap';
  if (states.length && states.every((value) => value === 'reject')) return 'reject';
  return 'unknown';
}

function visibleSegments() {
  return allSegments().filter((segment) => {
    if (state.episode !== null && Number(segment.episode) !== state.episode) return false;
    if (!state.unknownOnly) return true;
    if (segment.type === 'scene_heading') {
      return allSegments().some((line) => (
        line.type !== 'scene_heading'
        && line.episode === segment.episode
        && line.scene_id === segment.scene_id
        && !['best', 'keep', 'reject'].includes(stateForSegment(line.segment_id))
      ));
    }
    return !['best', 'keep', 'reject'].includes(stateForSegment(segment.segment_id));
  });
}

function sceneHeadingSummary(segment) {
  const raw = String(segment.raw_text || segment.text || '').trim();
  const match = raw.match(/^\s*\d+\s*[-—]\s*\d+\s*(.*)$/);
  return (match?.[1] || raw).trim();
}

function candidateRangeText(candidate) {
  const ids = candidateScriptIds(candidate);
  if (!ids.length) return '';
  const segments = ids.map((id) => state.segmentMap.get(id)).filter(Boolean);
  if (!segments.length) return '';
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (segments.length === 1) return `第${first.episode}集 · 第${first.order}段`;
  if (first.episode === last.episode) return `第${first.episode}集 · 第${first.order}–${last.order}段`;
  return `第${first.episode}集第${first.order}段 → 第${last.episode}集第${last.order}段`;
}

function confidencePresentation(candidate, group) {
  const placement = placementForGroup(group);
  if (placement.entry || candidate?.confidence === 'manual') {
    return {className: 'manual', title: '人工确认', detail: placement.inherited ? '继承归集' : '人工归集', percent: ''};
  }
  const score = Number(candidate?.total_score);
  const percent = Number.isFinite(score) && score > 0 ? `评分${Math.round(score * 100)}` : '';
  if (candidate?.confidence === 'exact_dialogue') {
    return {className: 'exact', title: '高', detail: '对白匹配', percent};
  }
  if (candidate?.confidence === 'possible_dialogue') {
    return {className: 'possible', title: '中', detail: '存在歧义', percent};
  }
  return {className: 'context', title: '低', detail: '邻近线索', percent};
}

function reviewLabel(segmentId, group) {
  const {entry, inherited} = effectiveReviewEntry(segmentId, group);
  if (!entry) return '尚未人工修改';
  const actor = entry.actor || '人工审核';
  const time = formatModified(entry.updated_at);
  return `${inherited ? '继承 · ' : ''}${actor}${time ? ` · ${time}` : ''}`;
}

function renderEpisodePicks() {
  const buttons = ['<button class="episode-pick" data-episode="all" type="button">全部</button>'];
  for (const episode of episodeList()) {
    buttons.push(`<button class="episode-pick" data-episode="${episode}" type="button">第${episode}集</button>`);
  }
  const unknownCount = state.frontendSettings.show_unknown_count ? ` ${visibleUnassignedGroups().length}` : '';
  buttons.push(`<button class="episode-pick unassigned-pick" data-mode="unassigned" type="button">待归集${unknownCount}</button>`);
  const target = $('#episode-picks');
  target.innerHTML = buttons.join('');
  target.querySelectorAll('[data-episode]').forEach((button) => button.addEventListener('click', () => {
    state.mode = 'script';
    state.episode = button.dataset.episode === 'all' ? null : Number(button.dataset.episode);
    state.segmentId = visibleSegments()[0]?.segment_id || null;
    state.selectedGroupId = null;
    renderContent({candidateTop: 0});
  }));
  target.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    state.mode = 'unassigned';
    state.segmentId = null;
    state.selectedGroupId = null;
    renderContent({candidateTop: 0});
  }));
  target.querySelectorAll('[data-episode]').forEach((button) => {
    const active = state.mode === 'script' && (
      (state.episode === null && button.dataset.episode === 'all')
      || Number(button.dataset.episode) === state.episode
    );
    button.classList.toggle('active', active);
  });
  target.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('active', state.mode === 'unassigned');
  });
}

function renderScript() {
  const target = $('#script-list');
  const segments = visibleSegments();
  const selectable = segments.filter((segment) => segment.type !== 'scene_heading');
  if (!state.segmentId || !selectable.some((segment) => segment.segment_id === state.segmentId)) {
    state.segmentId = selectable[0]?.segment_id || null;
  }
  let scene = '';
  const html = [];
  const labels = {
    best: '已选最佳',
    keep: '已保留',
    reject: '已隐藏',
    possible: '有候选',
    context: '附近素材',
    gap: '大段未对应',
    unknown: '未找到',
  };
  for (const segment of segments) {
    if (segment.type === 'scene_heading') {
      scene = segment.scene_id;
      html.push(
        `<div class="script-scene-card">`
        + `<div class="scene-heading-id">第${esc(segment.episode)}集 · ${esc(segment.scene_id)}</div>`
        + `<div class="scene-heading-summary">${esc(sceneHeadingSummary(segment))}</div>`
        + `<div class="scene-heading-note">场景概括 · 不参与素材台词匹配</div>`
        + '</div>',
      );
      continue;
    }
    if (segment.scene_id !== scene) {
      scene = segment.scene_id;
      html.push(`<div class="script-scene">${esc(scene)}</div>`);
    }
    const lineState = stateForSegment(segment.segment_id);
    const stateClass = ['best', 'keep', 'possible'].includes(lineState)
      ? 'verified'
      : lineState === 'context'
        ? 'context'
        : lineState === 'gap'
          ? 'gap'
        : '';
    html.push(
      `<button class="script-line ${stateClass} ${segment.segment_id === state.segmentId ? 'active' : ''}" `
      + `data-segment-id="${esc(segment.segment_id)}" type="button">`
      + `<span class="line-no">${esc(segment.order)}</span>`
      + `<span class="line-text">${esc(segment.raw_text)}</span>`
      + `<span class="line-state state-${esc(lineState)}">${esc(labels[lineState] || lineState)}</span>`
      + '</button>',
    );
  }
  target.innerHTML = html.join('') || '<div class="empty-state">当前筛选没有剧本段落</div>';
  target.querySelectorAll('[data-segment-id]').forEach((button) => button.addEventListener('click', () => {
    state.segmentId = button.dataset.segmentId;
    state.selectedGroupId = null;
    renderContent({candidateTop: 0});
  }));
  $('#script-count').textContent = `${selectable.length}段`;
  $('#script-scope').textContent = state.episode === null ? ' · 全部集数' : ` · 第${state.episode}集`;
}

function memberRangeText(member) {
  const start = Number(member.source_start || 0);
  const end = Number(member.source_end);
  if (Number.isFinite(end) && (start > 0.05 || Math.abs(end - Number(member.duration || 0)) > 0.1)) {
    return `片内 ${formatClock(start)}–${formatClock(end)}`;
  }
  return `${Number(member.duration || 0).toFixed(1)}秒`;
}

function renderMemberStrip(group) {
  const sorted = [...(group.members || [])].sort((left, right) => (
    (cameraOrder[left.camera] ?? 99) - (cameraOrder[right.camera] ?? 99)
    || Number(left.timeline_start || 0) - Number(right.timeline_start || 0)
    || memberFileName(left).localeCompare(memberFileName(right))
  ));
  const byCamera = new Map();
  for (const member of sorted) {
    if (!byCamera.has(member.camera)) byCamera.set(member.camera, []);
    byCamera.get(member.camera).push(member);
  }
  const runs = [];
  for (const camera of [...byCamera.keys()].sort((left, right) => (cameraOrder[left] ?? 99) - (cameraOrder[right] ?? 99))) {
    const members = byCamera.get(camera);
    const repeated = members.length > 1;
    const cards = members.map((member) => {
      const fileName = memberFileName(member);
      const active = state.selectedGroupId === group.group_id && state.selectedClipId === member.clip_id;
      return `<button class="member-card camera-${esc(member.camera)} ${active ? 'active' : ''}" `
        + `data-member-group="${esc(group.group_id)}" data-member-clip="${esc(member.clip_id)}" `
        + `title="${esc(member.media_path || fileName)}" type="button" ${member.exists ? '' : 'disabled'}>`
        + `<strong class="member-file">${esc(fileName)}</strong>`
        + '<span class="member-bottom">'
        + `<span class="camera-chip camera-${esc(member.camera)}">${esc(member.camera)}</span>`
        + `<span class="member-time">${esc(memberRangeText(member))}</span>`
        + '</span></button>';
    }).join('');
    runs.push(
      `<div class="camera-run ${repeated ? 'repeated' : ''}">`
      + (repeated ? `<span class="repeat-label">${esc(camera)}×${members.length}</span>` : '')
      + cards
      + '</div>',
    );
  }
  return runs.join('');
}

function renderTakeRow(group, candidate, segmentId, contextOnly = false) {
  const reviewState = assignmentState(segmentId, group);
  const confidence = confidencePresentation(candidate, group);
  const rangeText = candidateRangeText(candidate);
  const placement = placementForGroup(group).entry;
  const episodes = placement?.episode_ids?.length ? placement.episode_ids : inferredEpisodes(group);
  const stateLabel = {
    best: '最佳',
    keep: '保留',
    reject: '已隐藏',
    unreviewed: '未核对',
  }[reviewState] || '未核对';
  const transcript = candidate?.transcript_text || matchRowForGroup(group.group_id).candidates?.[0]?.transcript_text
    || (contextOnly ? '没有可靠对白，可能是空镜、口令或准备片。' : '当前没有可靠组内对白。');
  const evidence = (candidate?.evidence || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const scope = rangeText || (episodes.length ? `可能第${episodes.join('、')}集` : '仍无可靠集数线索');
  const splitText = group.split_reason ? ` · ${group.split_reason}` : '';
  const selected = state.selectedGroupId === group.group_id;
  return `<article class="take-row ${selected ? 'selected' : ''} ${reviewState === 'reject' ? 'rejected' : ''}" `
    + `data-take-group="${esc(group.group_id)}">`
    + `<div class="confidence-rail confidence-${confidence.className}">`
    + `<strong>${esc(confidence.title)}</strong><span>${esc(confidence.detail)}</span><small>${esc(confidence.percent)}</small>`
    + '</div>'
    + '<div class="take-info">'
    + `<div class="take-info-top"><span class="badge badge-${esc(reviewState)}">${esc(stateLabel)}</span>`
    + `<span class="badge badge-range">${esc(scope)}</span></div>`
    + `<div class="take-transcript">${esc(transcript)}</div>`
    + `<div class="take-meta">拍摄 ${formatClock(group.start)}–${formatClock(group.end)} · ${Number(group.duration || 0).toFixed(1)}秒 · ${esc(reviewLabel(segmentId, group))}${esc(splitText)}</div>`
    + '<div class="take-actions">'
    + `<button class="decision-button best ${reviewState === 'best' ? 'selected' : ''}" data-review-kind="${contextOnly ? 'group' : 'assignment'}" data-decision="best" data-group-id="${esc(group.group_id)}" data-segment-id="${esc(segmentId || '')}" type="button">最佳</button>`
    + `<button class="decision-button keep ${reviewState === 'keep' ? 'selected' : ''}" data-review-kind="${contextOnly ? 'group' : 'assignment'}" data-decision="keep" data-group-id="${esc(group.group_id)}" data-segment-id="${esc(segmentId || '')}" type="button">保留</button>`
    + `<button class="decision-button reject ${reviewState === 'reject' ? 'selected' : ''}" data-review-kind="${contextOnly ? 'group' : 'assignment'}" data-decision="reject" data-group-id="${esc(group.group_id)}" data-segment-id="${esc(segmentId || '')}" type="button">隐藏</button>`
    + (reviewState !== 'unreviewed'
      ? `<button class="decision-button" data-review-kind="${contextOnly ? 'group' : 'assignment'}" data-decision="unreviewed" data-group-id="${esc(group.group_id)}" data-segment-id="${esc(segmentId || '')}" type="button">恢复</button>`
      : '')
    + `<button class="placement-button" data-placement-group="${esc(group.group_id)}" type="button">归集</button>`
    + `<details class="take-details"><summary>信息</summary><div class="take-details-body">内部组号 ${esc(group.group_id)}`
    + `${group.parent_group_id ? `<br>拆分前 ${esc(group.parent_group_id)} · Take ${esc(group.take_index)}` : ''}`
    + `${evidence ? `<ul>${evidence}</ul>` : ''}</div></details>`
    + '</div></div>'
    + `<div class="member-strip">${renderMemberStrip(group)}</div>`
    + '</article>';
}

function bindCandidateEvents() {
  const list = $('#candidate-list');
  list.querySelectorAll('[data-member-clip]').forEach((button) => button.addEventListener('click', () => {
    selectMember(button.dataset.memberGroup, button.dataset.memberClip, true);
  }));
  list.querySelectorAll('[data-decision]').forEach((button) => button.addEventListener('click', async () => {
    if (button.dataset.reviewKind === 'group') {
      await setGroupDecision(button.dataset.groupId, button.dataset.decision);
    } else {
      await setDecision(button.dataset.segmentId, button.dataset.groupId, button.dataset.decision);
    }
  }));
  list.querySelectorAll('[data-placement-group]').forEach((button) => button.addEventListener('click', () => {
    openPlacement(button.dataset.placementGroup);
  }));
}

function renderCandidates() {
  if (state.mode === 'unassigned') {
    renderUnassigned();
    return;
  }
  const segment = state.segmentMap.get(state.segmentId);
  const list = $('#candidate-list');
  if (!segment) {
    $('#candidate-title').textContent = '候选 Take';
    $('#candidate-subtitle').textContent = '请选择左侧剧本段落';
    $('#candidate-count').textContent = '0组';
    list.innerHTML = '<div class="empty-state">没有选中的剧本段落</div>';
    return;
  }
  if (segment.type === 'scene_heading') {
    $('#candidate-title').textContent = `第${segment.episode}集 · ${segment.scene_id}`;
    $('#candidate-subtitle').textContent = sceneHeadingSummary(segment);
    list.innerHTML = '<div class="empty-state">这是场景概括，不是可匹配台词；请从下方对白或动作行进入素材核对。</div>';
    $('#candidate-count').textContent = '场景信息';
    return;
  }
  $('#candidate-title').textContent = `第${segment.episode}集 · ${segment.scene_id}`;
  $('#candidate-subtitle').textContent = segment.raw_text;
  const candidates = candidateForSegment(segment.segment_id);
  if (!candidates.length) {
    const gap = scriptGapForSegment(segment.segment_id);
    if (gap) {
      list.innerHTML = `<div class="empty-state">大段未对应：第${gap.episode}集 · ${esc(gap.scene_id)} · 第${gap.start_order}–${gap.end_order}段。当前只有场景/邻近线索，未绑定具体台词，请进入待归集看片。</div>`;
      $('#candidate-count').textContent = '未对应';
      return;
    }
    const nearby = Object.values(state.matches?.groups || {}).some((item) => (
      item.context_segment_ids || []
    ).includes(segment.segment_id));
    list.innerHTML = `<div class="empty-state">${nearby ? '此段附近有未精确匹配素材，请进入待归集看片。' : '当前没有可靠候选。'}</div>`;
    $('#candidate-count').textContent = '0组';
    return;
  }
  list.innerHTML = candidates.map((candidate) => {
    const group = state.groupMap.get(candidate.group_id);
    return group ? renderTakeRow(group, candidate, segment.segment_id, false) : '';
  }).join('');
  $('#candidate-count').textContent = `${candidates.length}组`;
  bindCandidateEvents();
}

function renderUnassigned() {
  const groups = visibleUnassignedGroups();
  $('#candidate-title').textContent = state.episode === null ? '待归集素材' : `第${state.episode}集附近待归集`;
  $('#candidate-subtitle').textContent = '不强绑具体台词，看片后可多选集数或修正剧本范围';
  $('#candidate-count').textContent = `${groups.length}组`;
  const list = $('#candidate-list');
  if (!groups.length) {
    list.innerHTML = '<div class="empty-state">当前范围没有待归集素材</div>';
    return;
  }
  list.innerHTML = groups.map((group) => {
    const candidate = matchRowForGroup(group.group_id).candidates?.[0] || {confidence: 'context_only'};
    return renderTakeRow(group, candidate, '', true);
  }).join('');
  bindCandidateEvents();
}

function captureScroll() {
  return {
    scriptTop: $('#script-list')?.scrollTop || 0,
    candidateTop: $('#candidate-list')?.scrollTop || 0,
  };
}

function restoreScroll(positions) {
  requestAnimationFrame(() => {
    if ($('#script-list')) $('#script-list').scrollTop = positions.scriptTop ?? 0;
    if ($('#candidate-list')) $('#candidate-list').scrollTop = positions.candidateTop ?? 0;
  });
}

function renderContent(options = {}) {
  const positions = {...captureScroll(), ...options};
  $('#workspace').classList.toggle('unassigned', state.mode === 'unassigned');
  renderEpisodePicks();
  if (state.mode === 'script') renderScript();
  renderCandidates();
  updateProgress();
  restoreScroll(positions);
}

function currentCandidateForGroup(groupId) {
  if (state.segmentId) {
    const candidate = candidateForSegment(state.segmentId).find((item) => item.group_id === groupId);
    if (candidate) return candidate;
  }
  return matchRowForGroup(groupId).candidates?.[0] || null;
}

function sortedMembers(group) {
  return [...(group?.members || [])].sort((left, right) => (
    (cameraOrder[left.camera] ?? 99) - (cameraOrder[right.camera] ?? 99)
    || Number(left.timeline_start || 0) - Number(right.timeline_start || 0)
  ));
}

function renderInspector(group, member) {
  const candidate = currentCandidateForGroup(group.group_id);
  $('#player-file').textContent = memberFileName(member);
  $('#player-file').title = member.media_path || memberFileName(member);
  const camera = $('#player-camera');
  camera.textContent = member.camera || '—';
  camera.className = `camera-chip camera-${member.camera || 'neutral'}`;
  $('#player-range').textContent = `${memberRangeText(member)} · 素材时长 ${Number(member.duration || 0).toFixed(1)}秒`;
  $('#player-take').textContent = `${candidateRangeText(candidate) || inferredEpisodes(group).map((episode) => `第${episode}集`).join('、') || '待归集'} · 拍摄 ${formatClock(group.start)}–${formatClock(group.end)}`;
  $('#player-transcript').textContent = candidate?.transcript_text || '没有可靠对白线索。';
  $('#player-members').innerHTML = sortedMembers(group).map((item) => (
    `<button class="player-member-button ${item.clip_id === member.clip_id ? 'active' : ''}" `
    + `data-player-clip="${esc(item.clip_id)}" data-player-group="${esc(group.group_id)}" type="button" ${item.exists ? '' : 'disabled'}>`
    + `<span class="camera-chip camera-${esc(item.camera)}">${esc(item.camera)}</span>`
    + `<span class="player-member-name">${esc(memberFileName(item))}</span>`
    + `<span class="player-member-time">${esc(memberRangeText(item))}</span>`
    + '</button>'
  )).join('');
  $('#player-members').querySelectorAll('[data-player-clip]').forEach((button) => button.addEventListener('click', () => {
    selectMember(button.dataset.playerGroup, button.dataset.playerClip, true);
  }));
}

function selectMember(groupId, clipId, autoplay = false) {
  const group = state.groupMap.get(groupId);
  const member = group?.members?.find((item) => item.clip_id === clipId);
  if (!group || !member || !member.exists) return;
  state.selectedGroupId = groupId;
  state.selectedClipId = clipId;
  state.playerStart = Math.max(0, Number(member.source_start || 0));
  state.playerEnd = Number.isFinite(Number(member.source_end)) ? Number(member.source_end) : null;
  renderCandidates();
  renderInspector(group, member);
  const player = $('#player');
  player.pause();
  player.src = projectApi(`/media/${encodeURIComponent(clipId)}`);
  player.load();
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = Math.min(state.playerStart, Math.max(0, player.duration - 0.05));
    if (autoplay) player.play().catch(() => {});
  }, {once: true});
}

async function postReviewAction(action) {
  const response = await fetchJson(projectApi('/review'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...action, actor: state.actor}),
  });
  state.review = response;
  state.reviewRevision = Number(state.review.revision || 0);
  setCollabStatus('已同步', true);
  return state.review;
}

async function setDecision(segmentId, groupId, decision) {
  try {
    await postReviewAction({
      action: 'set_assignment',
      segment_id: segmentId,
      group_id: groupId,
      state: decision,
    });
    state.selectedGroupId = groupId;
    renderContent();
    showToast('审核结果已保存');
  } catch (error) {
    setCollabStatus('保存失败', false);
    showToast(error.message);
  }
}

async function setGroupDecision(groupId, decision) {
  try {
    await postReviewAction({action: 'set_group', group_id: groupId, state: decision});
    state.selectedGroupId = groupId;
    renderContent();
    showToast('素材组状态已保存');
  } catch (error) {
    setCollabStatus('保存失败', false);
    showToast(error.message);
  }
}

function openPlacement(groupId) {
  const group = state.groupMap.get(groupId);
  if (!group) return;
  state.placementGroupId = groupId;
  $('#placement-group-name').textContent = sortedMembers(group).map(memberFileName).join(' / ');
  const placement = placementForGroup(group).entry;
  const selectedEpisodes = new Set(placement?.episode_ids?.length ? placement.episode_ids : inferredEpisodes(group));
  $('#placement-episodes').innerHTML = episodeList().map((episode) => (
    `<label class="episode-check"><input type="checkbox" value="${episode}" ${selectedEpisodes.has(episode) ? 'checked' : ''}><span>第${episode}集</span></label>`
  )).join('');
  const optionRows = ['<option value="">不设置具体台词</option>'];
  for (const segment of matchableSegments()) {
    const label = `第${segment.episode}集 · ${segment.order} · ${String(segment.raw_text || '').slice(0, 42)}`;
    optionRows.push(`<option value="${esc(segment.segment_id)}">${esc(label)}</option>`);
  }
  $('#placement-start').innerHTML = optionRows.join('');
  $('#placement-end').innerHTML = optionRows.join('');
  const ids = (placement?.script_segment_ids || []).filter((id) => state.segmentMap.get(id)?.type !== 'scene_heading');
  $('#placement-start').value = ids[0] || '';
  $('#placement-end').value = ids[ids.length - 1] || '';
  $('#placement-dialog').showModal();
}

async function savePlacement() {
  const groupId = state.placementGroupId;
  if (!groupId) return;
  const episodeIds = [...$('#placement-episodes').querySelectorAll('input:checked')].map((input) => Number(input.value));
  const startId = $('#placement-start').value;
  const endId = $('#placement-end').value;
  let segmentIds = [];
  if (startId || endId) {
    const segments = matchableSegments();
    const positions = new Map(segments.map((segment, index) => [segment.segment_id, index]));
    const left = positions.get(startId || endId);
    const right = positions.get(endId || startId);
    if (left !== undefined && right !== undefined) {
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      segmentIds = segments.slice(start, end + 1).map((segment) => segment.segment_id);
    }
  }
  try {
    await postReviewAction({
      action: 'set_group_placement',
      group_id: groupId,
      episode_ids: episodeIds,
      script_segment_ids: segmentIds,
    });
    $('#placement-dialog').close();
    renderContent();
    showToast('归集范围已保存');
  } catch (error) {
    showToast(error.message);
  }
}

async function clearPlacement() {
  if (!state.placementGroupId) return;
  try {
    await postReviewAction({action: 'clear_group_placement', group_id: state.placementGroupId});
    $('#placement-dialog').close();
    renderContent();
    showToast('人工归集已清除');
  } catch (error) {
    showToast(error.message);
  }
}

function setCollabStatus(label, online) {
  const target = $('#collab-status');
  target.textContent = label;
  target.classList.toggle('offline', !online);
}

function showToast(message) {
  const target = $('#toast');
  target.textContent = message;
  target.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    target.hidden = true;
  }, 2400);
}

function updateProgress() {
  const segments = matchableSegments();
  const reviewed = segments.filter((segment) => ['best', 'keep', 'reject'].includes(stateForSegment(segment.segment_id))).length;
  $('#progress').textContent = `已审核 ${reviewed} / ${segments.length}段`;
  const errors = state.project?.errors || {};
  const count = Object.values(errors).reduce((sum, item) => sum + (Array.isArray(item) ? item.length : 0), 0);
  $('#error-summary').innerHTML = count ? `<span class="error-text">异常 ${count}</span>` : '异常 0';
  $('#show-unknown').textContent = state.unknownOnly ? '显示全部剧本' : '只看未核对';
}

function updateActorDisplay() {
  $('#actor-button').textContent = state.actor ? `审核人：${state.actor}` : '设置审核人';
}

function saveActor(value) {
  state.actor = String(value || '').trim().slice(0, 40);
  try {
    localStorage.setItem('script-organizer-actor', state.actor);
  } catch (_error) {
    // The current tab still keeps the actor if storage is unavailable.
  }
  updateActorDisplay();
}

function loadActor() {
  try {
    state.actor = localStorage.getItem('script-organizer-actor') || '';
  } catch (_error) {
    state.actor = '';
  }
  updateActorDisplay();
}

function renderSearchResults(results) {
  const target = $('#search-results');
  if (!$('#search').value.trim()) {
    target.hidden = true;
    target.innerHTML = '';
    return;
  }
  if (!results.length) {
    target.innerHTML = '<div class="search-empty">没有找到结果</div>';
    target.hidden = false;
    return;
  }
  target.innerHTML = results.map((item, index) => {
    const episodes = (item.episode_ids || []).map((episode) => `第${episode}集`).join('、');
    const kind = item.kind === 'clip' ? `${item.camera || ''}机素材` : '剧本';
    return `<button class="search-result ${index === 0 ? 'active' : ''}" data-search-index="${index}" type="button">`
      + `<span class="search-kind">${esc(kind)}</span>`
      + `<span class="search-label">${esc(item.label)}</span>`
      + `<span class="search-scope">${esc(episodes || '待归集')}</span>`
      + '</button>';
  }).join('');
  target.hidden = false;
  target.querySelectorAll('[data-search-index]').forEach((button) => button.addEventListener('click', () => {
    navigateSearchResult(results[Number(button.dataset.searchIndex)]);
  }));
}

async function runSearch(query) {
  if (state.searchController) state.searchController.abort();
  if (!query.trim()) {
    renderSearchResults([]);
    return;
  }
  state.searchController = new AbortController();
  try {
    const payload = await fetchJson(`${projectApi('/search')}?q=${encodeURIComponent(query)}`, {
      signal: state.searchController.signal,
    });
    renderSearchResults(payload.results || []);
  } catch (error) {
    if (error.name !== 'AbortError') renderSearchResults([]);
  }
}

function navigateSearchResult(item) {
  $('#search-results').hidden = true;
  const segmentId = item.script_segment_ids?.find((id) => state.segmentMap.has(id));
  if (item.kind === 'script' || segmentId) {
    const targetId = segmentId || item.script_segment_ids?.[0];
    const segment = state.segmentMap.get(targetId);
    state.mode = 'script';
    state.episode = Number(segment?.episode ?? item.episode_ids?.[0] ?? state.episode);
    state.segmentId = segment?.type === 'scene_heading'
      ? allSegments().find((row) => row.type !== 'scene_heading' && row.episode === segment.episode && row.scene_id === segment.scene_id)?.segment_id || null
      : targetId;
  } else {
    state.mode = 'unassigned';
    state.episode = Number.isFinite(Number(item.episode_ids?.[0])) ? Number(item.episode_ids[0]) : null;
    state.segmentId = null;
  }
  state.selectedGroupId = item.group_id || null;
  state.selectedClipId = item.clip_id || null;
  renderContent({scriptTop: 0, candidateTop: 0});
  requestAnimationFrame(() => {
    document.querySelector(`[data-segment-id="${CSS.escape(state.segmentId || '')}"]`)?.scrollIntoView({block: 'center'});
    document.querySelector(`[data-take-group="${CSS.escape(state.selectedGroupId || '')}"]`)?.scrollIntoView({block: 'center'});
  });
  if (item.group_id && item.clip_id) selectMember(item.group_id, item.clip_id, false);
}

function latestReviewActor(review) {
  const entries = [
    ...Object.values(review.groups || {}),
    ...Object.values(review.clips || {}),
    ...Object.values(review.placements || {}),
    ...Object.values(review.assignments || {}).flatMap((rows) => Object.values(rows || {})),
  ];
  entries.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
  return entries[0]?.actor || '';
}

function renderProjectSelector() {
  const target = $('#project-select');
  target.innerHTML = (state.workspace.projects || []).map((project) => (
    `<option value="${esc(project.project_id)}">${esc(project.name || project.project_id)}</option>`
  )).join('');
  target.value = state.projectId;
}

function renderWorkspaceSelector() {
  const target = $('#workspace-select');
  target.innerHTML = state.workspaces.map((workspace) => (
    `<option value="${esc(workspace.workspace_id)}">${esc(workspace.workspace || workspace.workspace_id)}</option>`
  )).join('');
  target.value = state.workspaceId;
}

function preferredProject(projects) {
  return [...projects].sort((left, right) => {
    const leftStats = left.stats || {};
    const rightStats = right.stats || {};
    const leftHasData = Number(leftStats.groups || 0) > 0 || Number(leftStats.clips || 0) > 0;
    const rightHasData = Number(rightStats.groups || 0) > 0 || Number(rightStats.clips || 0) > 0;
    return Number(rightHasData) - Number(leftHasData);
  })[0]?.project_id || '';
}

function hasExplicitProjectSelection() {
  try { return localStorage.getItem('script-organizer-project-selection-explicit') === '1'; } catch (_error) { return false; }
}

function rememberExplicitProjectSelection() {
  try { localStorage.setItem('script-organizer-project-selection-explicit', '1'); } catch (_error) {}
}

function updateLocation() {
  const url = new URL(window.location.href);
  url.searchParams.set('workspace_id', state.workspaceId);
  url.searchParams.set('project_id', state.projectId);
  history.replaceState({}, '', url);
}

function resetProjectView() {
  state.project = null;
  state.script = {segments: []};
  state.groups = [];
  state.matches = {groups: {}, by_segment: {}};
  state.review = {version: 2, revision: 0, assignments: {}, groups: {}, clips: {}, placements: {}};
  state.groupMap = new Map();
  state.segmentMap = new Map();
  state.episode = null;
  state.segmentId = null;
  state.mode = 'script';
  state.selectedGroupId = null;
  state.selectedClipId = null;
  state.analysisRevision = '';
  state.reviewRevision = 0;
  state.tasks = [];
  state.proposals = [];
  $('#player').pause();
  $('#player').removeAttribute('src');
  $('#player').load();
}

async function loadWorkspace() {
  const payload = await fetchJson('/api/v1/workspaces');
  state.workspaces = payload.workspaces || [];
  const query = new URLSearchParams(window.location.search);
  const requestedWorkspaceId = query.get('workspace_id') || '';
  const savedWorkspaceId = (() => {
    try { return localStorage.getItem('script-organizer-workspace-id') || ''; } catch (_error) { return ''; }
  })();
  state.workspaceId = state.workspaces.some((item) => item.workspace_id === requestedWorkspaceId)
    ? requestedWorkspaceId
    : state.workspaces.some((item) => item.workspace_id === savedWorkspaceId)
      ? savedWorkspaceId
      : state.workspaces[0]?.workspace_id || '';
  if (!state.workspaceId) throw new Error('网关没有可用工作区');
  state.workspace = await fetchJson(workspaceApi());
  const projects = state.workspace.projects || [];
  if (!projects.length) throw new Error('工作区没有可用项目');
  const requestedProjectId = query.get('project_id') || '';
  const savedProjectId = (() => {
    try { return localStorage.getItem('script-organizer-project-id') || ''; } catch (_error) { return ''; }
  })();
  state.projectId = projects.some((item) => item.project_id === requestedProjectId)
    ? requestedProjectId
    : hasExplicitProjectSelection() && projects.some((item) => item.project_id === savedProjectId)
      ? savedProjectId : preferredProject(projects);
  try { localStorage.setItem('script-organizer-workspace-id', state.workspaceId); } catch (_error) {}
  renderWorkspaceSelector();
  renderProjectSelector();
  updateLocation();
}

async function switchProject(projectId) {
  if (!projectId || projectId === state.projectId && state.project) return;
  state.projectId = projectId;
  try { localStorage.setItem('script-organizer-project-id', projectId); } catch (_error) {}
  resetProjectView();
  renderProjectSelector();
  updateLocation();
  $('#analysis-status').textContent = '读取项目';
  await reloadAnalysis(false);
  const review = await fetchJson(projectApi('/review'));
  state.review = review;
  state.reviewRevision = Number(review.revision || 0);
  applyWorkbenchDefaults();
  renderContent({scriptTop: 0, candidateTop: 0});
}

async function switchWorkspace(workspaceId) {
  if (!workspaceId || workspaceId === state.workspaceId) return;
  state.workspaceId = workspaceId;
  try { localStorage.setItem('script-organizer-workspace-id', workspaceId); } catch (_error) {}
  state.workspace = await fetchJson(workspaceApi());
  const projects = state.workspace.projects || [];
  if (!projects.length) throw new Error('工作区没有可用项目');
  state.projectId = preferredProject(projects);
  resetProjectView();
  renderWorkspaceSelector();
  renderProjectSelector();
  updateLocation();
  $('#analysis-status').textContent = '读取项目';
  await switchProject(state.projectId);
}

function parseCameraPatterns(value) {
  const result = {};
  for (const row of String(value || '').split(',')) {
    const [camera, pattern] = row.split('=').map((item) => item.trim());
    if (camera && pattern) result[camera.toUpperCase()] = pattern;
  }
  return result;
}

async function pickProjectPath(button) {
  const path = await fetchJson(workspaceApi('/path-picker'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({kind: button.dataset.pickKind}),
  });
  if (path.path) $(`#${button.dataset.pickTarget}`).value = path.path;
}

function updateProjectKindFields() {
  const fcpxml = $('#new-project-kind').value === 'fcpxml';
  document.querySelectorAll('[data-project-input="fcpxml"]').forEach((node) => { node.hidden = !fcpxml; });
  document.querySelectorAll('[data-project-input="media-directory"]').forEach((node) => { node.hidden = fcpxml; });
  $('#new-project-fcpxml').required = fcpxml;
  $('#new-project-media-root').required = !fcpxml;
}

function openProjectDialog() {
  $('#project-form').reset();
  // Raw media is the normal product entry. The FCPXML path remains an
  // explicit advanced choice rather than depending on late-loaded scripts.
  $('#new-project-kind').value = 'media-directory';
  updateProjectKindFields();
  if (!$('#project-dialog').open) $('#project-dialog').showModal();
  requestAnimationFrame(() => $('#new-project-name').focus());
}

async function createProject() {
  const inputKind = $('#new-project-kind').value;
  const payload = {
    name: $('#new-project-name').value.trim(),
    input_kind: inputKind,
    fcpxml: $('#new-project-fcpxml').value,
    media_root: $('#new-project-media-root').value,
    script: $('#new-project-script').value,
    camera_patterns: parseCameraPatterns($('#new-project-camera-patterns').value),
  };
  const preflight = await fetchJson(workspaceApi('/project-preflight'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  if (!preflight.ready) {
    throw new Error(`项目预检失败：${(preflight.errors || []).join('；')}`);
  }
  if ((preflight.warnings || []).length) {
    showToast(`预检提示：${preflight.warnings.join('；')}`);
  }
  const created = await fetchJson(workspaceApi('/projects'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
  $('#project-dialog').close();
  state.workspace = await fetchJson(workspaceApi());
  await switchProject(created.project_id);
  showToast(`已创建项目：${created.name}`);
}

function taskLabel(task) {
  return {
    incremental_analyze: '增量分析',
    transcribe: '素材转写',
    evidence_extract: '证据提取',
  }[task.type] || task.type;
}

async function refreshTasks() {
  const payload = await fetchJson(projectApi('/tasks'));
  state.tasks = payload.tasks || [];
  const target = $('#task-list');
  target.innerHTML = state.tasks.map((task) => (
    `<div class="task-row"><div class="task-row-head"><strong>${esc(taskLabel(task))}</strong>`
    + `<span><span class="task-state ${esc(task.status)}">${esc(task.status)}</span>`
    + (['queued', 'running'].includes(task.status)
      ? ` <button class="task-cancel" data-cancel-task="${esc(task.task_id)}" type="button">取消</button>`
      : '') + '</span></div>'
    + `<small>${esc((task.logs || []).slice(-1)[0] || '')}${task.error ? ` · ${esc(task.error)}` : ''}</small></div>`
  )).join('') || '<div class="proposal-empty">当前项目没有后台任务</div>';
  target.querySelectorAll('[data-cancel-task]').forEach((button) => button.addEventListener('click', () => {
    cancelTask(button.dataset.cancelTask).catch((error) => showToast(error.message));
  }));
}

async function submitTask(type) {
  const targets = type === 'evidence_extract' && state.selectedGroupId
    ? {group_ids: [state.selectedGroupId]}
    : {};
  if (type === 'evidence_extract' && !state.selectedGroupId) {
    showToast('请先选择一个 Take');
    return;
  }
  const task = await fetchJson(projectApi('/tasks'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      type,
      targets,
      idempotency_key: `${type}:${state.projectId}:${state.selectedGroupId || 'project'}:${state.analysisRevision}`,
      actor: state.actor || '本机审核',
    }),
  });
  showToast(`${taskLabel(task)}已提交`);
  await refreshTasks();
}

async function cancelTask(taskId) {
  await fetchJson(projectApi(`/tasks/${encodeURIComponent(taskId)}`), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: '{}',
  });
  await refreshTasks();
  showToast('已请求取消任务');
}

async function refreshProposals() {
  const payload = await fetchJson(projectApi('/proposals'));
  state.proposals = payload.proposals || [];
  const target = $('#proposal-list');
  const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
  target.innerHTML = state.proposals.map((proposal) => {
    const evidence = (proposal.evidence || []).map((item) => (
      `<li>${esc(item.clip_id)} · ${esc(item.summary)}</li>`
    )).join('');
    const episodes = (proposal.episode_ids || []).map((episode) => `第${episode}集`).join('、') || '未指定集数';
    return `<label class="proposal-row"><input type="checkbox" value="${esc(proposal.proposal_id)}" ${proposal.status === 'pending' ? '' : 'disabled'}>`
      + `<span><div class="proposal-row-head"><strong>${esc(proposal.agent_name || '智能体')} · ${esc(episodes)}</strong><span class="task-state ${esc(proposal.status)}">${esc(proposal.status)}</span></div>`
      + `<small>${esc(proposal.group_id)}${proposal.note ? ` · ${esc(proposal.note)}` : ''}</small>`
      + (evidence ? `<ul class="proposal-evidence">${evidence}</ul>` : '') + '</span></label>';
  }).join('') || '<div class="proposal-empty">当前项目没有智能体提案</div>';
  $('#apply-proposals').disabled = pending.length === 0;
}

async function applySelectedProposals() {
  const proposalIds = [...$('#proposal-list').querySelectorAll('input:checked')].map((input) => input.value);
  if (!proposalIds.length) {
    showToast('请选择至少一条提案');
    return;
  }
  const payload = await fetchJson(projectApi('/proposals/apply'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({proposal_ids: proposalIds, actor: state.actor}),
  });
  state.review = payload.review;
  state.reviewRevision = Number(payload.review?.revision || 0);
  renderContent();
  await refreshProposals();
  showToast(`已应用 ${payload.applied?.length || 0} 条提案`);
}

async function reloadAnalysis(showNotice = false) {
  const [project, script, groups, matches] = await Promise.all(
    ['', '/script', '/groups', '/matches'].map((path) => (
      fetchJson(projectApi(path))
    )),
  );
  state.project = project;
  state.script = script;
  state.groups = groups;
  state.matches = matches;
  state.groupMap = new Map(groups.map((group) => [group.group_id, group]));
  state.segmentMap = new Map(allSegments().map((segment) => [segment.segment_id, segment]));
  state.analysisRevision = project.analysis_revision || state.analysisRevision;
  if (!state.episode && state.episode !== null) state.episode = episodeList()[0] ?? null;
  $('#project-name').textContent = project.project;
  $('#analysis-status').textContent = `${project.stats?.groups || 0}组 · ${project.stats?.clips || 0}条素材`;
  renderContent();
  if (showNotice) {
    $('#update-banner').hidden = false;
    playUpdateSound();
  }
}

async function pollState() {
  try {
    const next = await fetchJson(projectApi('/state'));
    if (next.analysis_revision && next.analysis_revision !== state.analysisRevision) {
      await reloadAnalysis(true);
    }
    if (Number(next.review_revision || 0) !== Number(state.reviewRevision || 0)) {
      try {
        state.review = await fetchJson(projectApi('/review'));
        state.reviewRevision = Number(state.review.revision || 0);
        renderContent();
        const actor = latestReviewActor(state.review);
        if (actor && actor !== state.actor) showToast(`${actor} 的修改已同步`);
      } catch (_error) {}
    }
    setCollabStatus('协作已连接', true);
  } catch (_error) {
    setCollabStatus('协作连接中断', false);
  }
}

function playUpdateSound() {
  if (!state.audioUnlocked || !state.frontendSettings.update_sound) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.17);
    oscillator.addEventListener('ended', () => context.close());
  } catch (_error) {
    // Notification audio is optional.
  }
}

function selectedCandidate() {
  if (state.mode === 'unassigned') {
    const group = state.groupMap.get(state.selectedGroupId) || visibleUnassignedGroups()[0];
    return group ? {group_id: group.group_id, contextOnly: true} : null;
  }
  const candidates = candidateForSegment(state.segmentId);
  return candidates.find((candidate) => candidate.group_id === state.selectedGroupId) || candidates[0] || null;
}

function ignoreKeyboard(event) {
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName)
    || event.target.isContentEditable
    || Boolean(document.querySelector('dialog[open]'));
}

async function boot() {
  loadActor();
  await loadWorkspace();
  applyFrontendSettings(await fetchJson(workspaceApi('/settings')));
  await switchProject(state.projectId);
  setCollabStatus('协作已连接', true);
  if (!state.actor) {
    $('#identity-dialog').showModal();
    requestAnimationFrame(() => $('#actor-input').focus());
  }
  state.pollTimer = setInterval(pollState, state.frontendSettings.poll_interval_ms);
}

$('#search').addEventListener('input', (event) => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => runSearch(event.target.value), 160);
});
$('#search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('#search-results').hidden = true;
  if (event.key === 'Enter') {
    const active = $('#search-results .search-result.active');
    if (active) {
      event.preventDefault();
      active.click();
    }
  }
});
document.addEventListener('pointerdown', (event) => {
  state.audioUnlocked = true;
  if (!event.target.closest('.search-wrap')) $('#search-results').hidden = true;
}, {once: false});
$('#show-unknown').addEventListener('click', () => {
  state.unknownOnly = !state.unknownOnly;
  state.segmentId = visibleSegments()[0]?.segment_id || null;
  renderContent({scriptTop: 0, candidateTop: 0});
});
$('#refresh').addEventListener('click', () => location.reload());
$('#project-select').addEventListener('change', (event) => {
  rememberExplicitProjectSelection();
  switchProject(event.target.value).catch((error) => showToast(error.message));
});
$('#workspace-select').addEventListener('change', (event) => {
  rememberExplicitProjectSelection();
  switchWorkspace(event.target.value).catch((error) => showToast(error.message));
});
$('#pairing-form').addEventListener('submit', (event) => {
  event.preventDefault();
  fetchJson('/api/v1/pairing', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code: $('#pairing-code').value.trim()}),
  }).then(async (payload) => {
    state.session = '';
    $('#pairing-dialog').close();
    await boot();
  }).catch((error) => showToast(error.message));
});
$('#create-project').addEventListener('click', () => {
  openProjectDialog();
});
$('#project-close').addEventListener('click', () => $('#project-dialog').close());
$('#new-project-kind').addEventListener('change', updateProjectKindFields);
document.querySelectorAll('[data-pick-kind]').forEach((button) => button.addEventListener('click', () => {
  pickProjectPath(button).catch((error) => showToast(error.message));
}));
$('#project-form').addEventListener('submit', (event) => {
  event.preventDefault();
  createProject().catch((error) => showToast(error.message));
});
$('#task-button').addEventListener('click', () => {
  refreshTasks().then(() => $('#task-dialog').showModal()).catch((error) => showToast(error.message));
});
$('#task-close').addEventListener('click', () => $('#task-dialog').close());
document.querySelectorAll('[data-task-type]').forEach((button) => button.addEventListener('click', () => {
  submitTask(button.dataset.taskType).catch((error) => showToast(error.message));
}));
$('#proposal-button').addEventListener('click', () => {
  refreshProposals().then(() => $('#proposal-dialog').showModal()).catch((error) => showToast(error.message));
});
$('#proposal-close').addEventListener('click', () => $('#proposal-dialog').close());
$('#apply-proposals').addEventListener('click', () => {
  applySelectedProposals().catch((error) => showToast(error.message));
});
$('#dismiss-update').addEventListener('click', () => {
  $('#update-banner').hidden = true;
});
$('#actor-button').addEventListener('click', () => {
  $('#actor-input').value = state.actor;
  $('#identity-dialog').showModal();
  requestAnimationFrame(() => $('#actor-input').focus());
});
$('#identity-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#actor-input').value.trim();
  if (!value) return;
  saveActor(value);
  $('#identity-dialog').close();
});
$('#placement-close').addEventListener('click', () => $('#placement-dialog').close());
$('#placement-form').addEventListener('submit', (event) => {
  event.preventDefault();
  savePlacement();
});
$('#placement-clear').addEventListener('click', clearPlacement);
$('#player').addEventListener('timeupdate', (event) => {
  if (state.playerEnd !== null && event.target.currentTime >= state.playerEnd) {
    event.target.pause();
    event.target.currentTime = state.playerEnd;
  }
});
document.addEventListener('keydown', async (event) => {
  state.audioUnlocked = true;
  if (ignoreKeyboard(event)) return;
  if (event.key === ' ') {
    event.preventDefault();
    const player = $('#player');
    if (!player.src) return;
    if (player.paused) await player.play().catch(() => {});
    else player.pause();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const segments = visibleSegments();
    const index = segments.findIndex((segment) => segment.segment_id === state.segmentId);
    const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
    if (nextIndex >= 0 && nextIndex < segments.length) {
      event.preventDefault();
      state.segmentId = segments[nextIndex].segment_id;
      state.selectedGroupId = null;
      renderContent({candidateTop: 0});
      requestAnimationFrame(() => {
        document.querySelector(`[data-segment-id="${CSS.escape(state.segmentId)}"]`)?.scrollIntoView({block: 'center'});
      });
    }
    return;
  }
  const candidate = selectedCandidate();
  if (!candidate) return;
  const key = event.key.toLowerCase();
  const decision = {b: 'best', k: 'keep', x: 'reject', u: 'unreviewed'}[key];
  if (!decision) return;
  event.preventDefault();
  if (candidate.contextOnly) await setGroupDecision(candidate.group_id, decision);
  else await setDecision(state.segmentId, candidate.group_id, decision);
});

boot().catch((error) => {
  if (String(error.message || '').includes('需要先完成局域网配对')) {
    $('#pairing-dialog').showModal();
    return;
  }
  $('#analysis-status').textContent = '读取失败';
  $('#candidate-list').innerHTML = `<div class="empty-state error-text">${esc(error.message)}</div>`;
});
