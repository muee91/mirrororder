(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderCoverageUIInstalled) return;
  window.__mirrorOrderCoverageUIInstalled = true;

  let active = false;
  let payload = null;
  let loading = false;
  let coverageRevision = '';

  const shotLabels = {
    wide: '全景',
    full: '全身',
    medium: '中景',
    medium_closeup: '中近景',
    closeup: '近景',
    extreme_closeup: '特写',
    insert: '细节',
    unknown: '未识别',
  };
  const roleLabels = {
    master: '主镜',
    dialogue: '对白',
    reaction: '反应',
    insert: '细节',
    establishing: '建立',
    transition: '过场',
    unknown: '未分类',
  };
  const editorialLabels = {
    best: '最终最佳',
    keep: '最终保留',
    reject: '最终隐藏',
    mixed: '最终决定不一致',
  };

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

  function ensureTab() {
    const tabs = document.querySelector('#production-bar .production-tabs');
    if (!tabs) return null;
    let button = document.querySelector('#production-coverage-tab');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'production-coverage-tab';
    button.type = 'button';
    button.dataset.coverageTab = '1';
    button.innerHTML = '覆盖 <span id="production-coverage-count"></span>';
    const people = tabs.querySelector('[data-production-tab="people"]');
    tabs.insertBefore(button, people || null);
    return button;
  }

  function setActive(value) {
    active = Boolean(value);
    const button = ensureTab();
    if (button) button.classList.toggle('active', active);
    if (active) {
      document.querySelectorAll('#production-bar [data-production-tab]').forEach((item) => item.classList.remove('active'));
    }
  }

  function compactCounts(values, labels, keys) {
    const rows = [];
    for (const key of keys) {
      const count = Number(values?.[key] || 0);
      if (count > 0) rows.push(`${labels[key] || key} ${count}`);
    }
    return rows.join(' · ');
  }

  function sceneSummary(scene) {
    const summary = asObject(scene.summary);
    const known = Number(summary.known_shots || 0);
    const angles = Number(summary.angles || 0);
    const parts = [
      `Take ${Number(summary.take_groups || 0)}`,
      `景别 ${known}/${angles}`,
    ];
    const roles = compactCounts(summary.coverage_roles, roleLabels, ['master', 'dialogue', 'reaction', 'insert', 'establishing', 'transition']);
    if (roles) parts.push(roles);
    const risks = Number(summary.continuity_risks || 0);
    if (risks) parts.push(`连续性 ${risks}`);
    return parts.join(' · ');
  }

  function takeTitle(group) {
    const angles = asArray(group.angles);
    const names = angles.slice(0, 3).map((angle) => `${angle.camera || '?'} · ${angle.name || angle.clip_id || '素材'}`);
    return names.join(' / ') || group.group_id || 'Take';
  }

  function angleSummary(group) {
    const rows = asArray(group.angles).map((angle) => {
      const shot = shotLabels[String(angle.shot_type || 'unknown')] || '未识别';
      const role = roleLabels[String(angle.coverage_role || 'unknown')] || '';
      return `${angle.camera || '?'} ${shot}${role && role !== '未分类' ? ` · ${role}` : ''}`;
    });
    return rows.join('　');
  }

  function takeMeta(group) {
    const rows = [];
    const decision = asObject(group.editorial_decision);
    const editorial = editorialLabels[String(decision.state || '')];
    if (editorial) rows.push(editorial);
    const rough = asObject(group.rough_cut);
    const risk = String(rough.continuity_risk || 'unknown');
    if (risk === 'high') rows.push('连续性风险高');
    else if (risk === 'medium') rows.push('连续性需留意');
    const audit = asObject(group.audit);
    if (audit.mapping_stale) rows.push('归集已变化 · 审计需刷新');
    if (!audit.visual_current) rows.push('景别证据未更新');
    return rows.join(' · ');
  }

  function renderTake(group) {
    const angleText = angleSummary(group);
    const meta = takeMeta(group);
    return `
      <button class="coverage-take-row" type="button" data-focus-group="${esc(group.group_id || '')}">
        <span class="coverage-take-main">
          <strong>${esc(takeTitle(group))}</strong>
          <small>${esc(angleText || '尚无景别证据')}</small>
        </span>
        <span class="coverage-take-meta">${esc(meta)}</span>
        <span class="production-chevron">›</span>
      </button>
    `;
  }

  function renderScene(scene) {
    const issues = asArray(scene.issues);
    const warning = issues.find((item) => item?.code === 'continuity_attention');
    const coverageIssue = issues.find((item) => item?.code === 'coverage_unobserved' || item?.code === 'coverage_partial');
    const secondary = [warning?.label, coverageIssue?.label].filter(Boolean).join(' · ');
    const heading = scene.heading || scene.scene_id || '未命名场景';
    const takes = asArray(scene.take_groups);
    return `
      <details class="coverage-scene" ${warning ? 'open' : ''}>
        <summary>
          <span class="coverage-scene-episode">EP${esc(scene.episode || '—')}</span>
          <span class="coverage-scene-main">
            <strong>${esc(heading)}</strong>
            <small>${esc(sceneSummary(scene))}${secondary ? ` · ${esc(secondary)}` : ''}</small>
          </span>
          <span class="coverage-scene-disclosure">›</span>
        </summary>
        <div class="coverage-scene-body">
          ${takes.length ? takes.map(renderTake).join('') : '<div class="coverage-empty-row">当前场景还没有有效归集 Take。</div>'}
        </div>
      </details>
    `;
  }

  function renderCoverage() {
    ensureTab();
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    panel.hidden = false;
    if (loading && !payload) {
      panel.innerHTML = '<div class="production-empty"><strong>正在整理场景覆盖</strong><span>读取当前归集、景别和连续性证据。</span></div>';
      return;
    }
    if (!payload) {
      panel.innerHTML = '<div class="production-empty"><strong>暂时无法读取覆盖信息</strong><span>其它制作与审阅功能不受影响。</span></div>';
      return;
    }
    const summary = asObject(payload.summary);
    const scenes = asArray(payload.scenes);
    const counter = document.querySelector('#production-coverage-count');
    if (counter) counter.textContent = Number(summary.continuity_risks || 0) ? String(summary.continuity_risks) : '';
    panel.innerHTML = `
      <div class="production-section-head">
        <div><strong>场景覆盖</strong><span>按已存在的归集和机位证据整理；不会因为没识别到某种景别就推断“缺镜头”。</span></div>
        <span>${Number(summary.mapped_take_groups || 0)} Take · ${Number(summary.known_shots || 0)}/${Number(summary.angles || 0)} 景别</span>
      </div>
      <div class="production-status-strip coverage-status-strip">
        <span><strong>${Number(summary.scenes || 0)}</strong>场景</span>
        <span><strong>${Number(summary.continuity_risks || 0)}</strong>连续性提醒</span>
        <span><strong>${Number(summary.episode_only_groups || 0)}</strong>仅归集到集</span>
        <span><strong>${Number(summary.unplaced_groups || 0)}</strong>未归集</span>
      </div>
      <div class="coverage-list">
        ${scenes.length ? scenes.map(renderScene).join('') : '<div class="coverage-empty-row">当前筛选范围没有场景。</div>'}
      </div>
      <div class="production-note">最终编辑决定只作为覆盖视图注释；本阶段不改变 Selection Manifest、FCPXML 或任何交付结果。</div>
    `;
  }

  async function refreshCoverage(force = false) {
    if (!state.projectId || loading) return;
    if (!force && payload && coverageRevision && coverageRevision === state.coverageRevision) {
      renderCoverage();
      return;
    }
    loading = true;
    renderCoverage();
    const projectId = state.projectId;
    try {
      const next = await fetchJson(projectApi('/coverage'));
      if (state.projectId !== projectId) return;
      payload = next;
      coverageRevision = String(next.revision || '');
      state.coverageRevision = coverageRevision;
    } catch (error) {
      if (force) payload = null;
      if (active) showToast(error.message || '场景覆盖读取失败');
    } finally {
      loading = false;
      renderCoverage();
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-coverage-tab]')) {
      event.preventDefault();
      setActive(true);
      renderCoverage();
      refreshCoverage(true);
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab]') || event.target.closest('[data-focus-group]')) {
      setActive(false);
    }
  }, true);

  const baseRenderContent = renderContent;
  renderContent = function coverageRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderCoverage);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function coverageSwitchProject(...args) {
    payload = null;
    coverageRevision = '';
    const result = await baseSwitchProject(...args);
    if (active) await refreshCoverage(true);
    return result;
  };

  const basePollState = pollState;
  pollState = async function coveragePollState() {
    const result = await basePollState();
    if (!active || !state.projectId) return result;
    try {
      const next = await fetchJson(projectApi('/state'));
      const nextRevision = String(next.coverage_revision || '');
      if (nextRevision && nextRevision !== coverageRevision) {
        state.coverageRevision = nextRevision;
        await refreshCoverage(true);
      }
    } catch (_error) {}
    return result;
  };

  requestAnimationFrame(() => {
    ensureTab();
  });
})();
