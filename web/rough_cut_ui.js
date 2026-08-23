(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderRoughCutUIInstalled) return;
  window.__mirrorOrderRoughCutUIInstalled = true;

  let active = false;
  let payload = null;
  let loading = false;
  let sourceRevision = '';

  const statusLabels = {
    explicit_best: '已有最佳',
    needs_editorial_choice: '待选择',
    conflict_multiple_best: 'Best 冲突',
    no_eligible_take: '无可用 Take',
  };
  const sourceLabels = {
    editorial_assignment: '最终决定',
    editorial_group: '最终决定',
    legacy_assignment: '旧人工审核',
    legacy_assignment_inherited: '旧人工审核',
    legacy_group_or_clip: '旧人工审核',
    automatic_mapping_fallback: '自动归集',
    unreviewed: '未判断',
  };
  const stateLabels = {
    best: '最佳',
    keep: '保留',
    reject: '隐藏',
    unreviewed: '未判断',
  };
  const roleLabels = {
    master: '主镜',
    dialogue: '对白',
    reaction: '反应',
    insert: '细节',
    establishing: '建立',
    transition: '过场',
  };

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

  function ensureTab() {
    const tabs = document.querySelector('#production-bar .production-tabs');
    if (!tabs) return null;
    let button = document.querySelector('#production-rough-cut-tab');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'production-rough-cut-tab';
    button.type = 'button';
    button.dataset.roughCutTab = '1';
    button.innerHTML = '粗剪 <span id="production-rough-cut-count"></span>';
    const people = tabs.querySelector('[data-production-tab="people"]');
    tabs.insertBefore(button, people || null);
    return button;
  }

  function setActive(value) {
    active = Boolean(value);
    const button = ensureTab();
    if (button) button.classList.toggle('active', active);
    if (active) {
      document.querySelectorAll('#production-bar [data-production-tab], #production-coverage-tab').forEach((item) => item.classList.remove('active'));
    }
  }

  function rolePoolText(segment) {
    const pools = asObject(segment.role_pools);
    return ['master', 'dialogue', 'reaction', 'insert', 'establishing', 'transition']
      .map((key) => [key, asArray(pools[key]).length])
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${roleLabels[key] || key} ${count}`)
      .join(' · ');
  }

  function candidateText(candidate) {
    const source = String(candidate.decision_source || 'unreviewed');
    const state = String(candidate.delivery_state || 'unreviewed');
    if (source === 'automatic_mapping_fallback') return '自动归集候选';
    return `${sourceLabels[source] || '审核'} · ${stateLabels[state] || state}`;
  }

  function candidateAngles(candidate) {
    return asArray(candidate.angles)
      .map((angle) => {
        const role = roleLabels[String(angle.coverage_role || '')] || '';
        const shot = String(angle.shot_type || 'unknown');
        const shotText = {
          wide: '全景', full: '全身', medium: '中景', medium_closeup: '中近景',
          closeup: '近景', extreme_closeup: '特写', insert: '细节', unknown: '未识别',
        }[shot] || '未识别';
        return `${angle.camera || '?'} ${shotText}${role ? ` · ${role}` : ''}`;
      })
      .join('　');
  }

  function renderCandidate(candidate, primaryGroupId) {
    const groupId = String(candidate.group_id || '');
    const primary = groupId && groupId === primaryGroupId;
    const risk = String(candidate.continuity_risk || 'unknown');
    const riskText = risk === 'high' ? ' · 连续性风险高' : risk === 'medium' ? ' · 连续性需留意' : '';
    return `
      <button class="rough-cut-candidate${primary ? ' is-primary' : ''}" type="button" data-focus-group="${esc(groupId)}">
        <span class="rough-cut-candidate-main">
          <strong>${esc(candidateText(candidate))}${primary ? ' · Primary' : ''}</strong>
          <small>${esc(candidateAngles(candidate) || '尚无机位景别证据')}${esc(riskText)}</small>
        </span>
        <span class="rough-cut-candidate-id">${esc(groupId)}</span>
        <span class="production-chevron">›</span>
      </button>
    `;
  }

  function renderSegment(segment) {
    const script = asObject(segment.script);
    const status = String(segment.selection_status || 'needs_editorial_choice');
    const issue = asArray(segment.issues).find((item) => item?.severity === 'warning');
    const roleText = rolePoolText(segment);
    const candidates = asArray(segment.candidates);
    const statusText = statusLabels[status] || status;
    return `
      <div class="rough-cut-segment ${status}">
        <div class="rough-cut-segment-head">
          <span class="rough-cut-order">${esc(script.order || '—')}</span>
          <span class="rough-cut-script">
            <strong>${esc(script.speaker ? `${script.speaker} · ${script.text || ''}` : script.text || script.segment_id || '剧本段')}</strong>
            <small>${esc(statusText)}${roleText ? ` · ${esc(roleText)}` : ''}${issue?.label ? ` · ${esc(issue.label)}` : ''}</small>
          </span>
        </div>
        <div class="rough-cut-candidates">
          ${candidates.length ? candidates.map((candidate) => renderCandidate(candidate, segment.primary_group_id || '')).join('') : '<div class="rough-cut-empty">当前没有进入粗剪规划的 Take。</div>'}
        </div>
      </div>
    `;
  }

  function renderScene(scene) {
    const summary = asObject(scene.summary);
    const attention = Number(summary.needs_choice || 0) + Number(summary.conflicts || 0) + Number(summary.no_eligible || 0);
    const readiness = String(scene.readiness || 'needs_review');
    const readinessText = readiness === 'ready' ? '已具备明确 Best' : readiness === 'blocked' ? '存在阻塞' : '需要编辑判断';
    return `
      <details class="rough-cut-scene" ${attention ? 'open' : ''}>
        <summary>
          <span class="rough-cut-scene-episode">EP${esc(scene.episode || '—')}</span>
          <span class="rough-cut-scene-main">
            <strong>${esc(scene.heading || scene.scene_id || '未命名场景')}</strong>
            <small>${Number(summary.segments || 0)} 段 · Best ${Number(summary.explicit_best || 0)} · 待选 ${Number(summary.needs_choice || 0)} · 冲突 ${Number(summary.conflicts || 0)} · ${esc(readinessText)}</small>
          </span>
          <span class="rough-cut-scene-disclosure">›</span>
        </summary>
        <div class="rough-cut-scene-body">${asArray(scene.segments).map(renderSegment).join('') || '<div class="rough-cut-empty">这个场景没有需要规划的剧本段。</div>'}</div>
      </details>
    `;
  }

  function renderPlan() {
    ensureTab();
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    panel.hidden = false;
    if (loading && !payload) {
      panel.innerHTML = '<div class="production-empty"><strong>正在整理粗剪计划</strong><span>读取场景覆盖和现有编辑决定，不会自动替你选择 Best。</span></div>';
      return;
    }
    if (!payload) {
      panel.innerHTML = '<div class="production-empty"><strong>暂时无法读取粗剪计划</strong><span>其它制作与审阅功能不受影响。</span></div>';
      return;
    }
    const summary = asObject(payload.summary);
    const statuses = asObject(summary.selection_status);
    const attention = Number(statuses.needs_editorial_choice || 0) + Number(statuses.conflict_multiple_best || 0) + Number(statuses.no_eligible_take || 0);
    const count = document.querySelector('#production-rough-cut-count');
    if (count) count.textContent = attention ? String(attention) : '';
    const readiness = String(payload.readiness || 'needs_review');
    const readinessText = readiness === 'ready' ? '可进入组装' : readiness === 'blocked' ? '有阻塞项' : '需要编辑判断';
    panel.innerHTML = `
      <div class="production-section-head">
        <div><strong>粗剪规划</strong><span>复用 Coverage 与现有 delivery.v1；只整理决策准备度，不把 Keep 或自动归集升级成 Best。</span></div>
        <span>${Number(summary.segments || 0)} 段 · ${esc(readinessText)}</span>
      </div>
      <div class="production-status-strip rough-cut-status-strip">
        <span><strong>${Number(statuses.explicit_best || 0)}</strong>已有最佳</span>
        <span><strong>${Number(statuses.needs_editorial_choice || 0)}</strong>待选择</span>
        <span><strong>${Number(statuses.conflict_multiple_best || 0)}</strong>Best 冲突</span>
        <span><strong>${Number(statuses.no_eligible_take || 0)}</strong>无可用</span>
      </div>
      <div class="rough-cut-list">${asArray(payload.scenes).map(renderScene).join('') || '<div class="rough-cut-empty">当前范围没有粗剪规划内容。</div>'}</div>
      <div class="production-note">Final Decision 继续按既有 delivery.v1 进入 Selection Manifest；这个规划页本身不写 Manifest、不生成时间线，也不修改 FCPXML。</div>
    `;
  }

  async function refreshPlan(force = false) {
    if (!state.projectId || loading) return;
    if (!force && payload && sourceRevision && sourceRevision === String(state.coverageRevision || '')) {
      renderPlan();
      return;
    }
    loading = true;
    renderPlan();
    const projectId = state.projectId;
    try {
      const next = await fetchJson(projectApi('/rough-cut-plan'));
      if (state.projectId !== projectId) return;
      payload = next;
      sourceRevision = String(next.coverage_revision || '');
      if (sourceRevision) state.coverageRevision = sourceRevision;
    } catch (error) {
      if (force) payload = null;
      if (active) showToast(error.message || '粗剪规划读取失败');
    } finally {
      loading = false;
      renderPlan();
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-rough-cut-tab]')) {
      event.preventDefault();
      setActive(true);
      renderPlan();
      refreshPlan(true);
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab], [data-coverage-tab], [data-focus-group]')) {
      setActive(false);
    }
  }, true);

  const baseRenderContent = renderContent;
  renderContent = function roughCutRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderPlan);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function roughCutSwitchProject(...args) {
    payload = null;
    sourceRevision = '';
    const result = await baseSwitchProject(...args);
    if (active) await refreshPlan(true);
    return result;
  };

  const basePollState = pollState;
  pollState = async function roughCutPollState() {
    const result = await basePollState();
    if (!active || !state.projectId) return result;
    try {
      const next = await fetchJson(projectApi('/state'));
      const nextRevision = String(next.coverage_revision || '');
      if (nextRevision && nextRevision !== sourceRevision) {
        state.coverageRevision = nextRevision;
        await refreshPlan(true);
      }
    } catch (_error) {}
    return result;
  };

  requestAnimationFrame(ensureTab);
})();
