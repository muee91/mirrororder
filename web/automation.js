(() => {
  if (window.__mirrorOrderAutomationInstalled) return;
  window.__mirrorOrderAutomationInstalled = true;

  const COMPLETED = new Set(['auto_confirmed', 'ai_confirmed', 'human_override']);

  function automationFor(group) {
    return group?.automation && typeof group.automation === 'object' ? group.automation : null;
  }

  function appliesToSegment(entry, segmentId) {
    if (!entry || !COMPLETED.has(entry.status)) return false;
    const ids = entry.script_segment_ids || [];
    return Boolean(segmentId) && ids.includes(segmentId);
  }

  const baseAssignmentState = assignmentState;
  assignmentState = function automationAssignmentState(segmentId, group) {
    const manual = baseAssignmentState(segmentId, group);
    if (manual !== 'unreviewed') return manual;
    const entry = automationFor(group);
    if (appliesToSegment(entry, segmentId)) return entry.state === 'best' ? 'best' : 'keep';
    return manual;
  };

  const baseConfidencePresentation = confidencePresentation;
  confidencePresentation = function automationConfidence(candidate, group) {
    const manual = placementForGroup(group).entry || groupReviewEntry(group).entry;
    if (manual) return baseConfidencePresentation(candidate, group);
    const entry = automationFor(group);
    const candidateIds = candidateScriptIds(candidate);
    const sameRange = entry?.script_segment_ids?.length
      && candidateIds.some((id) => entry.script_segment_ids.includes(id));
    if (entry?.status === 'auto_confirmed' && sameRange) {
      return {className: 'exact', title: '自动', detail: '规则确认', percent: `${Math.round(Number(entry.confidence || 0) * 100)}%`};
    }
    if (entry?.status === 'ai_confirmed' && sameRange) {
      return {className: 'ai', title: 'AI', detail: '二审确认', percent: `${Math.round(Number(entry.confidence || 0) * 100)}%`};
    }
    if (entry?.status === 'needs_review') {
      return {className: 'review', title: '待审', detail: '存在冲突', percent: ''};
    }
    if (entry?.status === 'unresolved') {
      return {className: 'review', title: '异常', detail: '证据不足', percent: ''};
    }
    return baseConfidencePresentation(candidate, group);
  };

  const baseReviewLabel = reviewLabel;
  reviewLabel = function automationReviewLabel(segmentId, group) {
    const manual = baseReviewLabel(segmentId, group);
    if (manual !== '尚未人工修改') return manual;
    const entry = automationFor(group);
    if (appliesToSegment(entry, segmentId)) {
      return entry.status === 'ai_confirmed' ? 'AI 二审自动确认 · 可人工覆盖' : '系统自动确认 · 可人工覆盖';
    }
    if (entry?.status === 'needs_review') return '需要人工确认';
    if (entry?.status === 'unresolved') return '异常素材 · 证据不足';
    return manual;
  };

  function enhanceProjectAndTaskUI() {
    const mediaOption = document.querySelector('#new-project-kind option[value="media-directory"]');
    if (mediaOption) mediaOption.textContent = '原始多机位素材目录（自动音频同步）';
    const createButton = document.querySelector('#project-form .primary-button');
    if (createButton) createButton.textContent = '创建并自动整理';
    const note = document.querySelector('#project-dialog .modal-title-row p');
    if (note) note.textContent = '选择素材与剧本后，Host 自动同步多机位、ASR、剧本映射，并把疑难 Take 分流到待处理。';
    const actions = document.querySelector('#task-dialog .task-actions');
    if (actions && !actions.querySelector('[data-task-type="prepare_project"]')) {
      const prepare = document.createElement('button');
      prepare.type = 'button'; prepare.dataset.taskType = 'prepare_project'; prepare.textContent = '重新自动整理当前项目';
      const resolve = document.createElement('button');
      resolve.type = 'button'; resolve.dataset.taskType = 'auto_resolve'; resolve.textContent = '重跑自动确认 / AI救援';
      actions.prepend(resolve); actions.prepend(prepare);
      for (const button of [prepare, resolve]) {
        button.addEventListener('click', () => submitTask(button.dataset.taskType).catch((error) => showToast(error.message)));
      }
    }
  }

  const baseTaskLabel = taskLabel;
  taskLabel = function automationTaskLabel(task) {
    return ({prepare_project:'自动整理', multicam_sync:'多机位同步', auto_resolve:'自动确认/AI救援'})[task.type]
      || baseTaskLabel(task);
  };

  function injectStyles() {
    if (document.querySelector('style[data-automation-style]')) return;
    const style = document.createElement('style');
    style.dataset.automationStyle = '1';
    style.textContent = `
      .automation-summary{display:inline-flex;gap:7px;align-items:center;font-size:12px;color:var(--muted,#8f96a3)}
      .automation-summary strong{color:var(--text,#e8eaed);font-weight:650}
      .automation-review-button{border:1px solid var(--line,#343841);border-radius:8px;padding:5px 8px;background:transparent;color:inherit;cursor:pointer}
      .automation-review-button.attention{border-color:#b98542;color:#e8bc7d}
      .automation-badge{font-size:11px;border-radius:999px;padding:3px 7px;border:1px solid var(--line,#343841);white-space:nowrap}
      .automation-badge.auto_confirmed{color:#8fd4ae;border-color:#44715a}
      .automation-badge.ai_confirmed{color:#a9b7ff;border-color:#57628f}
      .automation-badge.needs_review,.automation-badge.unresolved{color:#e8bc7d;border-color:#8d693d}
      .confidence-ai{border-color:#6574bd!important}
      .confidence-review{border-color:#9a7040!important}
      .take-row.automation-needs-review{box-shadow:inset 3px 0 0 #9a7040}
    `;
    document.head.appendChild(style);
  }

  function ensureSummary() {
    let target = document.querySelector('#automation-summary');
    if (target) return target;
    target = document.createElement('span');
    target.id = 'automation-summary';
    target.className = 'automation-summary';
    const toolbar = document.querySelector('.toolbar-summary');
    if (toolbar) toolbar.insertBefore(target, toolbar.firstChild);
    return target;
  }

  function summaryData() {
    return state.project?.automation?.summary || {};
  }

  function renderSummary() {
    const target = ensureSummary();
    const row = summaryData();
    const total = Number(row.total || 0);
    if (!total) {
      target.textContent = '';
      return;
    }
    const auto = Number(row.auto_confirmed || 0);
    const ai = Number(row.ai_confirmed || 0);
    const human = Number(row.human_override || 0);
    const review = Number(row.needs_review || 0) + Number(row.unresolved || 0);
    target.innerHTML = `<span>自动 <strong>${auto}</strong></span><span>AI <strong>${ai}</strong></span><span>人工 <strong>${human}</strong></span><button id="automation-review" class="automation-review-button ${review ? 'attention' : ''}" type="button">待处理 ${review}</button>`;
    target.querySelector('#automation-review')?.addEventListener('click', () => {
      state.unknownOnly = true;
      state.mode = 'script';
      state.segmentId = visibleSegments().find((segment) => segment.type !== 'scene_heading')?.segment_id || null;
      renderContent({scriptTop: 0, candidateTop: 0});
    });
  }

  function decorateRows() {
    document.querySelectorAll('.take-row[data-take-group]').forEach((row) => {
      const group = state.groupMap.get(row.dataset.takeGroup);
      const entry = automationFor(group);
      row.classList.toggle('automation-needs-review', ['needs_review', 'unresolved'].includes(entry?.status));
      row.querySelector('.automation-badge')?.remove();
      if (!entry?.status) return;
      const labels = {
        auto_confirmed: '系统已确认',
        ai_confirmed: 'AI 二审通过',
        human_override: '人工覆盖',
        needs_review: '需要人工',
        unresolved: '异常待处理',
      };
      const badge = document.createElement('span');
      badge.className = `automation-badge ${entry.status}`;
      badge.textContent = labels[entry.status] || entry.status;
      badge.title = entry.reason || '';
      row.querySelector('.take-info-top')?.appendChild(badge);
    });
  }

  const baseRenderCandidates = renderCandidates;
  renderCandidates = function automationRenderCandidates(...args) {
    const result = baseRenderCandidates(...args);
    requestAnimationFrame(() => { decorateRows(); renderSummary(); });
    return result;
  };

  const baseReloadAnalysis = reloadAnalysis;
  reloadAnalysis = async function automationReloadAnalysis(...args) {
    const result = await baseReloadAnalysis(...args);
    renderSummary();
    requestAnimationFrame(decorateRows);
    return result;
  };

  let lastAutomationUpdatedAt = '';
  async function pollAutomation() {
    if (!state.projectId || document.hidden) return;
    try {
      const project = await fetchJson(projectApi(''));
      const stamp = String(project?.automation?.updated_at || '');
      if (!lastAutomationUpdatedAt) lastAutomationUpdatedAt = String(state.project?.automation?.updated_at || stamp);
      if (stamp && stamp !== lastAutomationUpdatedAt) {
        lastAutomationUpdatedAt = stamp;
        await reloadAnalysis(false);
        showToast('自动整理结果已更新');
      }
    } catch (_error) {}
  }

  injectStyles();
  enhanceProjectAndTaskUI();
  renderSummary();
  requestAnimationFrame(decorateRows);
  setInterval(pollAutomation, Math.max(2500, Number(state.frontendSettings?.poll_interval_ms || 2500)));
})();
