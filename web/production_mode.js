(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderProductionModeInstalled) return;
  window.__mirrorOrderProductionModeInstalled = true;
  document.documentElement.classList.add('native-production');

  const nav = {
    group: 'review',
    target: 'review',
    issueCount: 0,
  };
  const GROUPS = {
    media: {label: '素材', items: [['media', '素材库'], ['takes', 'Take'], ['people', '人物'], ['supervisor', '场记']]},
    script: {label: '剧本', items: [['script', '剧本'], ['coverage', '覆盖']]},
    edit: {label: '剪辑', items: [['rough-cut', '粗剪'], ['assembly', '组接']]},
    review: {label: '审阅', items: [['review', '看片'], ['issues', '待处理'], ['overview', '概览']]},
  };

  const unique = (values) => [...new Set(values.filter(Boolean))];
  function memberLocalState(member) {
    if (member?.resolved_media_path || member?.local_exists === true) return 'resolved';
    if (member?.local_exists === false) return 'missing';
    return 'unknown';
  }
  function humanTouchedGroups() {
    const ids = new Set([...Object.keys(state.review?.groups || {}), ...Object.keys(state.review?.placements || {})]);
    for (const rows of Object.values(state.review?.assignments || {})) for (const id of Object.keys(rows || {})) ids.add(id);
    return ids;
  }
  function topCandidates(group) {
    return (matchRowForGroup(group.group_id).candidates || []).filter((row) => row && row.confidence !== 'context_only')
      .sort((a, b) => Number(b.total_score || 0) - Number(a.total_score || 0));
  }
  function groupState(group, humanIds) {
    if (humanIds.has(group.group_id) || placementForGroup(group).entry) return 'human';
    const rows = topCandidates(group);
    if (!rows.length) return 'unassigned';
    const margin = rows[1] ? Number(rows[0].total_score || 0) - Number(rows[1].total_score || 0) : 1;
    if (rows[0].confidence === 'possible_dialogue' || margin < .08) return 'ambiguous';
    if (rows[0].confidence === 'exact_dialogue') return 'high';
    return 'context';
  }
  function projection() {
    const groups = state.groups || [];
    const humanIds = humanTouchedGroups();
    const groupRows = groups.map((group) => ({group, status: groupState(group, humanIds), candidates: topCandidates(group)}));
    const media = [];
    const seen = new Set();
    for (const group of groups) for (const member of group.members || []) if (!seen.has(member.clip_id)) { seen.add(member.clip_id); media.push({member, group}); }
    const missingMedia = media.filter(({member}) => memberLocalState(member) === 'missing');
    const attention = new Set(groupRows.filter((row) => ['unassigned', 'ambiguous'].includes(row.status)).map((row) => row.group.group_id));
    missingMedia.forEach(({group}) => attention.add(group.group_id));
    const gaps = Array.isArray(state.matches?.script_gaps) ? state.matches.script_gaps : [];
    nav.issueCount = attention.size + gaps.length;
    return {groups, groupRows, media, missingMedia, humanIds, gaps, segments: matchableSegments(), episodes: episodeList()};
  }
  function groupTitle(group) {
    return (group.members || []).slice().sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
      .slice(0, 3).map((member) => `${member.camera || '?'} · ${memberFileName(member)}`).join(' / ') || group.group_id;
  }
  function groupRange(group) {
    const start = Number(group.start ?? 0), end = Number(group.end ?? start);
    return `${formatClock(start)} – ${formatClock(end)}`;
  }
  function candidateSummary(row) {
    const first = row.candidates[0];
    if (!first) return '没有可靠剧本候选';
    const range = candidateRangeText(first) || '候选范围未定位';
    return row.status === 'ambiguous' ? `${range} · 需要人工核对` : range;
  }

  function metric(label, value, note) { return `<div class="production-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note || '')}</small></div>`; }
  function renderOverview(view) {
    const stats = state.project?.stats || {};
    return `<div class="production-section-head"><div><strong>项目概览</strong><span>状态集中呈现，具体制作能力收进对应工作区。</span></div></div>
      <div class="production-metrics">${metric('素材', String(stats.clips ?? view.media.length), `${view.missingMedia.length} 个本机缺失`)}${metric('Take', String(stats.groups ?? view.groups.length), `${view.humanIds.size} 个有人工记录`)}${metric('剧本', String(view.segments.length), `${view.episodes.length} 集`)}${metric('待处理', String(nav.issueCount), '归集歧义、缺失媒体、剧本空档')}</div>`;
  }
  function issueRows(view) {
    const rows = [];
    for (const row of view.groupRows) {
      if (row.status === 'unassigned') rows.push({kind: '归集', title: groupTitle(row.group), detail: '没有可靠剧本候选', groupId: row.group.group_id});
      else if (row.status === 'ambiguous') rows.push({kind: '归集', title: groupTitle(row.group), detail: candidateSummary(row), groupId: row.group.group_id});
    }
    for (const {member, group} of view.missingMedia) rows.push({kind: '媒体', title: memberFileName(member), detail: `${member.camera || '?'}机 · 当前 Mac 未找到素材`, groupId: group.group_id});
    return rows;
  }
  function renderIssues(view) {
    const rows = issueRows(view);
    return `<div class="production-section-head"><div><strong>待处理</strong><span>只放真正需要人介入的异常。</span></div><span>${rows.length} 项</span></div>` + (rows.length
      ? `<div class="production-list">${rows.slice(0, 160).map((row) => `<button class="production-row" type="button" data-focus-group="${esc(row.groupId)}"><span class="production-kind">${esc(row.kind)}</span><span class="production-row-main"><strong>${esc(row.title)}</strong><small>${esc(row.detail)}</small></span><span class="production-chevron">›</span></button>`).join('')}</div>`
      : '<div class="production-empty"><strong>没有明确异常</strong><span>可以继续看片或进入其它制作工作区。</span></div>');
  }
  function renderMedia(view) {
    const rows = view.media.slice().sort((a, b) => (memberLocalState(a.member) === 'missing' ? 0 : 1) - (memberLocalState(b.member) === 'missing' ? 0 : 1));
    return `<div class="production-section-head"><div><strong>素材库</strong><span>本机媒体定位、机位与辅助素材管理。</span></div><span>${rows.length} 素材</span></div><div class="production-list">${rows.slice(0, 220).map(({member, group}) => `<button class="production-row" type="button" data-focus-group="${esc(group.group_id)}"><span class="production-kind ${memberLocalState(member)}">${esc(member.camera || '?')}</span><span class="production-row-main"><strong>${esc(memberFileName(member))}</strong><small>${esc(memberLocalState(member) === 'missing' ? '本机缺失' : '可用')} · ${esc(groupRange(group))}</small></span><span class="production-chevron">›</span></button>`).join('')}</div>`;
  }
  function renderScript(view) {
    return `<div class="production-section-head"><div><strong>剧本</strong><span>按集查看素材归集和覆盖。</span></div><span>${view.segments.length} 段</span></div><div class="production-list">${view.episodes.map((episode) => { const rows = view.segments.filter((s) => Number(s.episode) === episode); const matched = rows.filter((s) => (state.matches?.by_segment?.[s.segment_id] || []).length).length; return `<button class="production-row" type="button" data-focus-episode="${episode}"><span class="production-kind">EP${episode}</span><span class="production-row-main"><strong>第 ${episode} 集</strong><small>${matched} / ${rows.length} 段有候选</small></span><span class="production-chevron">›</span></button>`; }).join('')}</div>`;
  }
  function renderTakes(view) {
    const rank = {ambiguous: 0, unassigned: 1, human: 2, high: 3, context: 4};
    const rows = view.groupRows.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || Number(a.group.start || 0) - Number(b.group.start || 0));
    const labels = {human:'人工',high:'高可信',ambiguous:'歧义',unassigned:'待归集',context:'上下文'};
    return `<div class="production-section-head"><div><strong>Take</strong><span>逻辑拍摄组和归集状态。</span></div><span>${rows.length} Take</span></div><div class="production-list">${rows.slice(0, 220).map((row) => `<button class="production-row" type="button" data-focus-group="${esc(row.group.group_id)}"><span class="production-kind ${esc(row.status)}">${esc(labels[row.status] || row.status)}</span><span class="production-row-main"><strong>${esc(groupTitle(row.group))}</strong><small>${esc(candidateSummary(row))}</small></span><span class="production-chevron">›</span></button>`).join('')}</div>`;
  }
  function renderPeople() { return `<div class="production-section-head"><div><strong>人物</strong><span>人物与声纹属于制作增强。</span></div></div><div class="production-empty production-people-entry"><strong>人物与声纹库</strong><span>查看已识别身份和角色候选。</span><button type="button" data-production-action="people">打开人物库</button></div>`; }
  function panelMarkup(view) {
    if (nav.target === 'overview') return renderOverview(view);
    if (nav.target === 'issues') return renderIssues(view);
    if (nav.target === 'media') return renderMedia(view);
    if (nav.target === 'script') return renderScript(view);
    if (nav.target === 'takes') return renderTakes(view);
    if (nav.target === 'people') return renderPeople();
    return '';
  }

  function groupForTarget(target) {
    return Object.entries(GROUPS).find(([, group]) => group.items.some(([key]) => key === target))?.[0] || 'review';
  }
  function ensureUI() {
    if (document.querySelector('#production-bar')) return;
    const bar = document.createElement('nav');
    bar.id = 'production-bar'; bar.className = 'production-bar'; bar.setAttribute('aria-label', '项目制作导航');
    bar.innerHTML = `<div class="production-nav-stack"><div class="production-groups">${Object.entries(GROUPS).map(([key, group]) => `<button type="button" data-production-group="${key}">${group.label}</button>`).join('')}</div><div class="production-subtabs" id="production-subtabs"></div></div><div class="production-bar-meta"><span id="production-project-meta"></span><span id="production-attention"></span></div><div class="production-tabs" aria-hidden="true"><button data-production-tab="review"></button><button data-production-tab="overview"></button><button data-production-tab="issues"></button><button data-production-tab="media"></button><button data-production-tab="script"></button><button data-production-tab="takes"></button><button data-production-tab="people"></button></div>`;
    const panel = document.createElement('section'); panel.id = 'production-panel'; panel.className = 'production-panel';
    document.body.insertBefore(bar, document.querySelector('.app-shell'));
    document.body.insertBefore(panel, document.querySelector('.app-shell'));
    document.addEventListener('click', handleClick, true);
    new MutationObserver(syncProxyState).observe(bar, {subtree:true, attributes:true, attributeFilter:['class'], childList:true});
  }
  function renderSubtabs() {
    const target = document.querySelector('#production-subtabs'); if (!target) return;
    target.innerHTML = GROUPS[nav.group].items.map(([key, label]) => `<button type="button" data-production-target="${key}" class="${nav.target === key ? 'active' : ''}">${label}${key === 'issues' && nav.issueCount ? ` <span>${nav.issueCount}</span>` : ''}</button>`).join('');
    document.querySelectorAll('[data-production-group]').forEach((button) => button.classList.toggle('active', button.dataset.productionGroup === nav.group));
  }
  function proxyClick(target) {
    if (target === 'supervisor') return window.openScriptSupervisorWorkspace?.();
    const external = {coverage:'#production-coverage-tab','rough-cut':'#production-rough-cut-tab',assembly:'#production-assembly-tab'}[target];
    if (external) return document.querySelector(external)?.click();
    document.querySelector(`#production-bar .production-tabs [data-production-tab="${CSS.escape(target)}"]`)?.click();
  }
  function navigate(target) {
    window.closeScriptSupervisorWorkspace?.();
    nav.target = target; nav.group = groupForTarget(target); renderSubtabs();
    if (['coverage','rough-cut','assembly','supervisor'].includes(target)) { proxyClick(target); return; }
    renderProduction();
  }
  window.mirrorOrderProductionNavigate = navigate;
  function syncProxyState() {
    const external = [['coverage','#production-coverage-tab'],['rough-cut','#production-rough-cut-tab'],['assembly','#production-assembly-tab']];
    for (const [key, selector] of external) if (document.querySelector(selector)?.classList.contains('active')) { nav.target = key; nav.group = groupForTarget(key); }
    renderSubtabs();
  }

  function focusGroup(groupId) {
    const group = state.groupMap.get(groupId); if (!group) return false;
    const manual = (placementForGroup(group).entry?.script_segment_ids || []).filter((id) => state.segmentMap.has(id));
    const auto = topCandidates(group).find((row) => candidateScriptIds(row).length);
    const ids = manual.length ? manual : candidateScriptIds(auto);
    if (ids.length) { const segment = state.segmentMap.get(ids[0]); state.mode='script'; state.episode=Number(segment?.episode)||null; state.segmentId=ids[0]; }
    else { state.mode='unassigned'; state.segmentId=null; state.episode=inferredEpisodes(group)[0] ?? null; }
    state.selectedGroupId=groupId; nav.target='review'; nav.group='review'; renderContent({candidateTop:0}); renderSubtabs();
    requestAnimationFrame(() => { const first=(group.members||[]).slice().sort((a,b)=>(cameraOrder[a.camera]??99)-(cameraOrder[b.camera]??99))[0]; if(first) selectMember(group.group_id,first.clip_id,false); });
    return true;
  }
  window.focusGroup = focusGroup;
  function focusEpisode(value) { state.mode='script'; state.episode=Number(value)||null; state.segmentId=visibleSegments().find((row)=>row.type!=='scene_heading')?.segment_id||null; nav.target='review'; nav.group='review'; renderContent({candidateTop:0}); renderSubtabs(); }

  function handleClick(event) {
    const groupButton = event.target.closest('[data-production-group]');
    if (groupButton) { event.preventDefault(); nav.group=groupButton.dataset.productionGroup; nav.target=GROUPS[nav.group].items[0][0]; navigate(nav.target); return; }
    const proxy = event.target.closest('[data-production-target]');
    if (proxy) { event.preventDefault(); navigate(proxy.dataset.productionTarget); return; }
    const legacy = event.target.closest('#production-bar .production-tabs [data-production-tab]');
    if (legacy) { nav.target=legacy.dataset.productionTab; nav.group=groupForTarget(nav.target); window.closeScriptSupervisorWorkspace?.(); renderProduction(); return; }
    const row = event.target.closest('[data-focus-group]'); if (row) { event.preventDefault(); focusGroup(row.dataset.focusGroup); return; }
    const episode = event.target.closest('[data-focus-episode]'); if (episode) { event.preventDefault(); focusEpisode(episode.dataset.focusEpisode); return; }
    const action = event.target.closest('[data-production-action]')?.dataset.productionAction;
    if (action === 'people') document.querySelector('#identity-library-button')?.click();
  }

  function renderProduction() {
    ensureUI();
    if (document.documentElement.classList.contains('supervisor-mode')) return;
    const view = projection();
    const meta = document.querySelector('#production-project-meta'); if (meta) meta.textContent = state.project?.project || state.project?.name || '';
    const attention = document.querySelector('#production-attention'); if (attention) attention.textContent = nav.issueCount ? `${nav.issueCount} 项需处理` : '制作就绪';
    renderSubtabs();
    const panel = document.querySelector('#production-panel'); if (!panel) return;
    if (nav.target === 'review') { panel.hidden=true; panel.innerHTML=''; }
    else if (['coverage','rough-cut','assembly','supervisor'].includes(nav.target)) { /* owned by extension */ }
    else { panel.hidden=false; panel.innerHTML=panelMarkup(view); }
  }

  const baseRenderContent = renderContent;
  renderContent = function productionRenderContent(...args) { const result=baseRenderContent(...args); requestAnimationFrame(renderProduction); return result; };
  const baseSwitchProject = switchProject;
  switchProject = async function productionSwitchProject(...args) { const result=await baseSwitchProject(...args); requestAnimationFrame(renderProduction); return result; };

  ensureUI();
  const requested = new URLSearchParams(location.search).get('production');
  if (requested) { nav.target=requested; nav.group=groupForTarget(requested); }
  requestAnimationFrame(() => { renderProduction(); if (requested && ['coverage','rough-cut','assembly','supervisor'].includes(requested)) setTimeout(()=>navigate(requested),80); });
})();