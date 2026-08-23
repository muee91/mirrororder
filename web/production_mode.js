(() => {
  const nativeBridge = () => window.webkit?.messageHandlers?.mirrorOrder || null;
  if (!nativeBridge()) return;

  document.documentElement.classList.add('native-production');

  const production = {
    tab: 'overview',
    issueCount: 0,
  };

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function clipName(member) {
    return memberFileName(member);
  }

  function memberLocalState(member) {
    if (member?.resolved_media_path) return 'resolved';
    if (member?.local_exists === true) return 'resolved';
    if (member?.local_exists === false) return 'missing';
    return 'unknown';
  }

  function humanTouchedGroups() {
    const ids = new Set([
      ...Object.keys(state.review?.groups || {}),
      ...Object.keys(state.review?.placements || {}),
    ]);
    for (const rows of Object.values(state.review?.assignments || {})) {
      for (const groupId of Object.keys(rows || {})) ids.add(groupId);
    }
    const clipToGroup = new Map();
    for (const group of state.groups || []) {
      for (const member of group.members || []) clipToGroup.set(member.clip_id, group.group_id);
    }
    for (const clipId of Object.keys(state.review?.clips || {})) {
      const groupId = clipToGroup.get(clipId);
      if (groupId) ids.add(groupId);
    }
    return ids;
  }

  function topCandidates(group) {
    return (matchRowForGroup(group.group_id).candidates || [])
      .filter((candidate) => candidate && candidate.confidence !== 'context_only')
      .sort((left, right) => Number(right.total_score || 0) - Number(left.total_score || 0));
  }

  function productionStateForGroup(group, humanIds = humanTouchedGroups()) {
    if (humanIds.has(group.group_id) || placementForGroup(group).entry) return 'human';
    const candidates = topCandidates(group);
    if (!candidates.length) return 'unassigned';
    const first = candidates[0];
    const second = candidates[1];
    const margin = second ? Number(first.total_score || 0) - Number(second.total_score || 0) : 1;
    if (first.confidence === 'possible_dialogue' || (second && margin < 0.08)) return 'ambiguous';
    if (first.confidence === 'exact_dialogue') return 'high';
    return 'context';
  }

  function projection() {
    const groups = state.groups || [];
    const humanIds = humanTouchedGroups();
    const groupRows = groups.map((group) => ({
      group,
      status: productionStateForGroup(group, humanIds),
      candidates: topCandidates(group),
    }));

    const mediaByClip = new Map();
    for (const group of groups) {
      for (const member of group.members || []) {
        if (!mediaByClip.has(member.clip_id)) mediaByClip.set(member.clip_id, {member, group});
      }
    }
    const media = [...mediaByClip.values()];
    const resolvedMedia = media.filter(({member}) => memberLocalState(member) === 'resolved');
    const missingMedia = media.filter(({member}) => memberLocalState(member) === 'missing');
    const knownMedia = media.filter(({member}) => memberLocalState(member) !== 'unknown');
    const missingGroupIds = new Set(missingMedia.map(({group}) => group.group_id));
    const attentionGroups = new Set(
      groupRows
        .filter((row) => row.status === 'unassigned' || row.status === 'ambiguous')
        .map((row) => row.group.group_id),
    );
    for (const groupId of missingGroupIds) attentionGroups.add(groupId);

    const gaps = Array.isArray(state.matches?.script_gaps) ? state.matches.script_gaps : [];
    const segments = matchableSegments();
    const episodes = episodeList();
    production.issueCount = attentionGroups.size + gaps.length;

    return {
      groups,
      groupRows,
      humanIds,
      media,
      resolvedMedia,
      missingMedia,
      knownMedia,
      missingGroupIds,
      attentionGroups,
      gaps,
      segments,
      episodes,
    };
  }

  function groupTitle(group) {
    const members = (group.members || []).slice().sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99));
    const names = members.slice(0, 3).map((member) => `${member.camera || '?'} · ${clipName(member)}`);
    return names.join(' / ') || group.group_id;
  }

  function groupRange(group) {
    const start = Number(group.start ?? group.timeline_start ?? 0);
    const end = Number(group.end ?? group.timeline_end ?? start);
    return `${formatClock(start)} – ${formatClock(end)}`;
  }

  function candidateSummary(row) {
    const first = row.candidates[0];
    if (!first) return '没有可靠剧本候选';
    const range = candidateRangeText(first) || '候选范围未定位';
    const score = Number(first.total_score);
    const scoreText = Number.isFinite(score) && score > 0 ? ` · ${Math.round(score * 100)}` : '';
    if (row.status === 'ambiguous') return `${range}${scoreText} · 需要人工核对`;
    if (row.status === 'high') return `${range}${scoreText} · 高可信对白证据`;
    return `${range}${scoreText}`;
  }

  function renderMetric(label, value, note = '') {
    return `<div class="production-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  }

  function renderOverview(view) {
    const stats = state.project?.stats || {};
    const totalClips = Number(stats.clips ?? view.media.length ?? 0);
    const totalGroups = Number(stats.groups ?? view.groups.length ?? 0);
    const mediaText = view.knownMedia.length
      ? `${view.resolvedMedia.length} / ${view.knownMedia.length}`
      : `${totalClips || view.media.length}`;
    const mediaNote = view.knownMedia.length ? '当前 Mac 已解析素材' : '素材定位状态尚未返回';
    return `
      <div class="production-section-head">
        <div><strong>制作概览</strong><span>App 汇总项目事实、异常和制作准备状态；团队审阅保持简洁。</span></div>
      </div>
      <div class="production-metrics">
        ${renderMetric('素材', mediaText, mediaNote)}
        ${renderMetric('Take', String(totalGroups), `${view.humanIds.size} 个有人工治理记录`)}
        ${renderMetric('剧本', String(view.segments.length), `${view.episodes.length} 集可审阅内容`)}
        ${renderMetric('待处理', String(view.issueCount ?? production.issueCount), '归集歧义、缺失媒体与剧本空档')}
      </div>
      <div class="production-actions-row">
        <button type="button" data-production-tab="issues">查看待处理</button>
        <button type="button" data-production-tab="media">检查素材</button>
        <button type="button" data-production-tab="takes">浏览 Take</button>
        <button type="button" data-production-action="proposals">分析建议</button>
      </div>
      <div class="production-note">自动分析只提供制作证据与候选；人工归集和审核始终保持权威，不会在这里被静默覆盖。</div>
    `;
  }

  function issueRows(view) {
    const rows = [];
    for (const row of view.groupRows) {
      if (row.status === 'unassigned') {
        rows.push({kind: '归集', title: groupTitle(row.group), detail: '没有可用对白候选或仅有邻近上下文', groupId: row.group.group_id});
      } else if (row.status === 'ambiguous') {
        rows.push({kind: '归集', title: groupTitle(row.group), detail: candidateSummary(row), groupId: row.group.group_id});
      }
    }
    for (const {member, group} of view.missingMedia) {
      rows.push({kind: '媒体', title: clipName(member), detail: `${member.camera || '?'} 机 · 当前 Mac 未解析到本机文件`, groupId: group.group_id});
    }
    for (const gap of view.gaps) {
      const ids = gap.segment_ids || (gap.segment_id ? [gap.segment_id] : []);
      const segments = ids.map((id) => state.segmentMap.get(id)).filter(Boolean);
      const first = segments[0];
      const last = segments[segments.length - 1];
      const title = first
        ? (first === last ? `第${first.episode}集 · 第${first.order}段` : `第${first.episode}集 · 第${first.order}–${last.order}段`)
        : '未覆盖剧本范围';
      rows.push({kind: '剧本', title, detail: '当前没有可靠 Take 覆盖', segmentId: first?.segment_id || ids[0] || ''});
    }
    return rows;
  }

  function renderIssues(view) {
    const rows = issueRows(view);
    if (!rows.length) {
      return `<div class="production-empty"><strong>没有明确的制作异常</strong><span>当前项目没有归集歧义、已知缺失媒体或剧本空档。</span></div>`;
    }
    return `
      <div class="production-section-head">
        <div><strong>待处理</strong><span>只集中展示会影响审阅质量的制作例外。</span></div>
        <span>${rows.length} 项</span>
      </div>
      <div class="production-list">
        ${rows.slice(0, 120).map((row) => `
          <button class="production-row" type="button"
            ${row.groupId ? `data-focus-group="${esc(row.groupId)}"` : ''}
            ${row.segmentId ? `data-focus-segment="${esc(row.segmentId)}"` : ''}>
            <span class="production-kind">${esc(row.kind)}</span>
            <span class="production-row-main"><strong>${esc(row.title)}</strong><small>${esc(row.detail)}</small></span>
            <span class="production-chevron">›</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderMedia(view) {
    const coverage = view.knownMedia.length
      ? `${view.resolvedMedia.length} / ${view.knownMedia.length}`
      : '尚未返回本机覆盖状态';
    const rows = view.media
      .slice()
      .sort((left, right) => {
        const l = memberLocalState(left.member) === 'missing' ? 0 : 1;
        const r = memberLocalState(right.member) === 'missing' ? 0 : 1;
        return l - r || String(clipName(left.member)).localeCompare(String(clipName(right.member)), 'zh-CN');
      });
    return `
      <div class="production-section-head">
        <div><strong>素材</strong><span>检查当前 Mac 的媒体解析状态；共享项目仍以 media_id 为身份。</span></div>
        <span>${esc(coverage)}</span>
      </div>
      <div class="production-list">
        ${rows.slice(0, 160).map(({member, group}) => {
          const local = memberLocalState(member);
          const stateText = local === 'resolved' ? '在线' : local === 'missing' ? '缺失' : '未检查';
          return `
            <button class="production-row" type="button" data-focus-group="${esc(group.group_id)}">
              <span class="production-kind ${local}">${esc(member.camera || '?')}</span>
              <span class="production-row-main"><strong>${esc(clipName(member))}</strong><small>${esc(stateText)} · ${esc(groupRange(group))}</small></span>
              <span class="production-chevron">›</span>
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderScript(view) {
    const gapIds = new Set(view.gaps.flatMap((gap) => gap.segment_ids || (gap.segment_id ? [gap.segment_id] : [])));
    const episodeRows = view.episodes.map((episode) => {
      const segments = view.segments.filter((segment) => Number(segment.episode) === episode);
      const gapCount = segments.filter((segment) => gapIds.has(segment.segment_id)).length;
      const withCandidates = segments.filter((segment) => (state.matches?.by_segment?.[segment.segment_id] || []).length > 0).length;
      return {episode, total: segments.length, withCandidates, gapCount};
    });
    return `
      <div class="production-section-head">
        <div><strong>剧本</strong><span>按集检查可审阅覆盖；这里呈现制作质量，不替代团队的创意判断。</span></div>
        <span>${view.segments.length} 段</span>
      </div>
      <div class="production-list">
        ${episodeRows.map((row) => `
          <button class="production-row" type="button" data-focus-episode="${row.episode}">
            <span class="production-kind">EP${row.episode}</span>
            <span class="production-row-main"><strong>第 ${row.episode} 集</strong><small>${row.withCandidates} / ${row.total} 段有候选${row.gapCount ? ` · ${row.gapCount} 段空档` : ''}</small></span>
            <span class="production-chevron">›</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderTakes(view) {
    const labels = {
      human: ['人工', '已有人工归集或审核记录'],
      high: ['高可信', '已有高可信对白候选'],
      ambiguous: ['歧义', '候选接近或对白存在歧义'],
      unassigned: ['待归集', '没有可靠剧本候选'],
      context: ['上下文', '主要依赖邻近拍摄上下文'],
    };
    const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, 0]));
    for (const row of view.groupRows) counts[row.status] = (counts[row.status] || 0) + 1;
    const ordered = view.groupRows.slice().sort((left, right) => {
      const rank = {ambiguous: 0, unassigned: 1, human: 2, high: 3, context: 4};
      return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || Number(left.group.start || 0) - Number(right.group.start || 0);
    });
    return `
      <div class="production-section-head">
        <div><strong>Take</strong><span>制作端查看归集证据与治理状态；点击可回到看片区继续核对。</span></div>
        <span>${view.groups.length} Take</span>
      </div>
      <div class="production-status-strip">
        ${Object.entries(labels).map(([key, [title]]) => `<span><strong>${counts[key] || 0}</strong>${title}</span>`).join('')}
      </div>
      <div class="production-list">
        ${ordered.slice(0, 160).map((row) => `
          <button class="production-row" type="button" data-focus-group="${esc(row.group.group_id)}">
            <span class="production-kind ${row.status}">${esc(labels[row.status]?.[0] || row.status)}</span>
            <span class="production-row-main"><strong>${esc(groupTitle(row.group))}</strong><small>${esc(candidateSummary(row))} · ${esc(groupRange(row.group))}</small></span>
            <span class="production-chevron">›</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderPeople() {
    return `
      <div class="production-section-head">
        <div><strong>人物</strong><span>人物与声纹属于制作增强：在 App 中核查身份线索，Web 只消费已整理的人物上下文。</span></div>
      </div>
      <div class="production-empty production-people-entry">
        <strong>人物与声纹库</strong>
        <span>查看已识别身份簇、关联 Take 与角色线索。</span>
        <button type="button" data-production-action="people">打开人物库</button>
      </div>
    `;
  }

  function panelMarkup(view) {
    if (production.tab === 'overview') return renderOverview(view);
    if (production.tab === 'issues') return renderIssues(view);
    if (production.tab === 'media') return renderMedia(view);
    if (production.tab === 'script') return renderScript(view);
    if (production.tab === 'takes') return renderTakes(view);
    if (production.tab === 'people') return renderPeople(view);
    return '';
  }

  function ensureUI() {
    if ($('#production-bar')) return;
    const bar = document.createElement('nav');
    bar.id = 'production-bar';
    bar.className = 'production-bar';
    bar.setAttribute('aria-label', '项目制作导航');
    bar.innerHTML = `
      <div class="production-tabs">
        <button type="button" data-production-tab="review">审阅</button>
        <button type="button" data-production-tab="overview">概览</button>
        <button type="button" data-production-tab="issues">待处理 <span id="production-issue-count"></span></button>
        <button type="button" data-production-tab="media">素材</button>
        <button type="button" data-production-tab="script">剧本</button>
        <button type="button" data-production-tab="takes">Take</button>
        <button type="button" data-production-tab="people">人物</button>
      </div>
      <div class="production-bar-meta"><span>Production</span><span id="production-project-meta"></span></div>
    `;
    const panel = document.createElement('section');
    panel.id = 'production-panel';
    panel.className = 'production-panel';
    panel.setAttribute('aria-label', '制作详情');
    document.body.insertBefore(bar, document.querySelector('.app-shell'));
    document.body.insertBefore(panel, document.querySelector('.app-shell'));

    document.addEventListener('click', handleClick, true);
  }

  function setTab(tab) {
    production.tab = tab;
    renderProduction();
  }

  function focusGroup(groupId) {
    const group = state.groupMap.get(groupId);
    if (!group) return;
    const manual = (placementForGroup(group).entry?.script_segment_ids || []).filter((id) => state.segmentMap.has(id));
    const auto = topCandidates(group).find((candidate) => candidateScriptIds(candidate).length);
    const ids = manual.length ? manual : candidateScriptIds(auto);
    if (ids.length) {
      const segment = state.segmentMap.get(ids[0]);
      state.mode = 'script';
      state.episode = Number(segment?.episode) || null;
      state.segmentId = ids[0];
    } else {
      state.mode = 'unassigned';
      state.segmentId = null;
      state.episode = inferredEpisodes(group)[0] ?? null;
    }
    state.selectedGroupId = groupId;
    production.tab = 'review';
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => {
      const first = (group.members || []).slice().sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))[0];
      if (first) selectMember(group.group_id, first.clip_id, false);
    });
  }

  function focusSegment(segmentId) {
    const segment = state.segmentMap.get(segmentId);
    if (!segment) return;
    state.mode = 'script';
    state.episode = Number(segment.episode) || null;
    state.segmentId = segmentId;
    state.selectedGroupId = null;
    production.tab = 'review';
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => document.querySelector(`[data-segment-id="${CSS.escape(segmentId)}"]`)?.scrollIntoView({block: 'center'}));
  }

  function focusEpisode(episode) {
    const value = Number(episode);
    state.mode = 'script';
    state.episode = Number.isFinite(value) ? value : null;
    state.segmentId = visibleSegments().find((segment) => segment.type !== 'scene_heading')?.segment_id || null;
    state.selectedGroupId = null;
    production.tab = 'review';
    renderContent({candidateTop: 0});
  }

  function handleClick(event) {
    const tab = event.target.closest('[data-production-tab]');
    if (tab) {
      event.preventDefault();
      setTab(tab.dataset.productionTab);
      return;
    }
    const group = event.target.closest('[data-focus-group]');
    if (group) {
      event.preventDefault();
      focusGroup(group.dataset.focusGroup);
      return;
    }
    const segment = event.target.closest('[data-focus-segment]');
    if (segment) {
      event.preventDefault();
      focusSegment(segment.dataset.focusSegment);
      return;
    }
    const episode = event.target.closest('[data-focus-episode]');
    if (episode) {
      event.preventDefault();
      focusEpisode(episode.dataset.focusEpisode);
      return;
    }
    const action = event.target.closest('[data-production-action]')?.dataset.productionAction;
    if (action === 'people') {
      event.preventDefault();
      $('#identity-library-button')?.click();
    } else if (action === 'proposals') {
      event.preventDefault();
      $('#proposal-button')?.click();
    }
  }

  function renderProduction() {
    ensureUI();
    const panel = $('#production-panel');
    const view = projection();
    const issueCount = $('#production-issue-count');
    if (issueCount) issueCount.textContent = production.issueCount ? String(production.issueCount) : '';
    const meta = $('#production-project-meta');
    if (meta) meta.textContent = state.project?.project || state.project?.name || '';
    document.querySelectorAll('#production-bar [data-production-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.productionTab === production.tab);
    });
    if (!panel) return;
    if (production.tab === 'review') {
      panel.hidden = true;
      panel.innerHTML = '';
    } else {
      panel.hidden = false;
      panel.innerHTML = panelMarkup({...view, issueCount: production.issueCount});
    }
  }

  const baseRenderContent = renderContent;
  renderContent = function productionRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderProduction);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function productionSwitchProject(projectId) {
    const result = await baseSwitchProject(projectId);
    requestAnimationFrame(renderProduction);
    return result;
  };

  ensureUI();
  requestAnimationFrame(renderProduction);
})();
