(() => {
  if (window.__mirrorOrderAutomationInstalled) return;
  window.__mirrorOrderAutomationInstalled = true;

  const COMPLETED = new Set(['auto_confirmed', 'ai_confirmed', 'human_override']);
  const NEEDS_ATTENTION = new Set(['needs_review', 'unresolved']);
  const HOST_LOCAL = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname);
  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);

  function automationFor(group) {
    return group?.automation && typeof group.automation === 'object' ? group.automation : null;
  }

  function appliesToSegment(entry, segmentId) {
    if (!entry || !COMPLETED.has(entry.status)) return false;
    const ids = entry.script_segment_ids || [];
    return Boolean(segmentId) && ids.includes(segmentId);
  }

  // Mapping and creative review are independent axes. Automation deliberately
  // does not override assignmentState: it may complete script placement, but it
  // can never manufacture Best / Keep / Reject or a personal opinion.

  function segmentHasPendingMapping(segmentId) {
    const candidates = candidateForSegment(segmentId);
    if (!candidates.length) return true;
    let sawAutomation = false;
    for (const candidate of candidates) {
      const group = state.groupMap.get(candidate.group_id);
      const entry = automationFor(group);
      if (!entry) return true;
      sawAutomation = true;
      if (NEEDS_ATTENTION.has(entry.status)) return true;
      if (!COMPLETED.has(entry.status)) return true;
    }
    return !sawAutomation;
  }

  // Base `unknownOnly` was historically editorial-review based. Preserve the
  // old implementation, then narrow it to mapping exceptions so auto-mapped
  // Takes disappear from the exception queue without becoming Keep.
  const baseVisibleSegments = visibleSegments;
  visibleSegments = function automationVisibleSegments() {
    const rows = baseVisibleSegments();
    if (!state.unknownOnly) return rows;
    return rows.filter((segment) => {
      if (segment.type !== 'scene_heading') return segmentHasPendingMapping(segment.segment_id);
      return allSegments().some((line) => (
        line.type !== 'scene_heading'
        && line.episode === segment.episode
        && line.scene_id === segment.scene_id
        && segmentHasPendingMapping(line.segment_id)
      ));
    });
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
      return {className: 'exact', title: '自动', detail: '剧本归集', percent: `${Math.round(Number(entry.confidence || 0) * 100)}%`};
    }
    if (entry?.status === 'ai_confirmed' && sameRange) {
      return {className: 'ai', title: 'AI', detail: '剧本归集', percent: `${Math.round(Number(entry.confidence || 0) * 100)}%`};
    }
    if (entry?.status === 'needs_review') {
      return {className: 'review', title: '待处理', detail: '归集冲突', percent: ''};
    }
    if (entry?.status === 'unresolved') {
      return {className: 'review', title: '异常', detail: '归集证据不足', percent: ''};
    }
    return baseConfidencePresentation(candidate, group);
  };

  const baseReviewLabel = reviewLabel;
  reviewLabel = function automationReviewLabel(segmentId, group) {
    const manual = baseReviewLabel(segmentId, group);
    if (manual !== '尚未人工修改') return manual;
    const entry = automationFor(group);
    if (appliesToSegment(entry, segmentId)) {
      return entry.status === 'ai_confirmed'
        ? 'AI 已完成剧本归集 · 剪辑判断仍未审核'
        : '系统已完成剧本归集 · 剪辑判断仍未审核';
    }
    if (entry?.status === 'needs_review') return '剧本归集需要人工确认';
    if (entry?.status === 'unresolved') return '异常素材 · 归集证据不足';
    return manual;
  };

  function installProjectCreationBoundary() {
    const trigger = document.querySelector('#create-project');
    if (!trigger || trigger.dataset.hostCreationBoundary === '1') return;
    trigger.dataset.hostCreationBoundary = '1';
    trigger.addEventListener('click', (event) => {
      if (!HOST_LOCAL) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showToast('项目创建只在 Host 本机或镜序 App 执行；局域网 Web 用于查看、审核和协作');
        return;
      }
    }, true);
  }

  async function replaceProjectScript() {
    if (!HOST_LOCAL || !state.projectId) return;
    const picked = await fetchJson('/api/v1/path-picker', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({kind: 'file'}),
    });
    if (!picked.path) return;
    const result = await fetchJson(projectApi('/script'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({script: picked.path}),
    });
    const fileName = String(result.script || picked.path).split(/[\\/]/).pop();
    showToast(`剧本已更换为 ${fileName}，正在重新分析和归集`);
    await refreshTasks();
  }

  function installProjectInputActions() {
    if (!HOST_LOCAL) return;
    const topActions = document.querySelector('.top-actions');
    const create = document.querySelector('#create-project');
    if (!topActions || !create || document.querySelector('#replace-project-script')) return;
    const button = document.createElement('button');
    button.id = 'replace-project-script';
    button.className = 'text-button';
    button.type = 'button';
    button.textContent = '更换剧本';
    button.title = state.project?.script_path ? `当前剧本：${state.project.script_path}` : '更换当前项目剧本';
    button.addEventListener('click', () => replaceProjectScript().catch((error) => showToast(error.message)));
    create.insertAdjacentElement('afterend', button);
  }

  function enhanceProjectAndTaskUI() {
    const mediaOption = document.querySelector('#new-project-kind option[value="media-directory"]');
    const fcpxmlOption = document.querySelector('#new-project-kind option[value="fcpxml"]');
    if (mediaOption) mediaOption.textContent = '原始多机位素材目录（推荐 · 自动音频同步）';
    if (fcpxmlOption) fcpxmlOption.textContent = '已有同步 FCPXML（高级入口）';
    const mediaField = document.querySelector('[data-project-input="media-directory"]');
    if (mediaField?.firstChild) mediaField.firstChild.textContent = '原始多机位素材目录\n        ';
    const scriptField = document.querySelector('#new-project-script')?.closest('label');
    if (scriptField?.firstChild) scriptField.firstChild.textContent = '剧本（DOCX、TXT 或 Markdown）\n        ';
    const createButton = document.querySelector('#project-form .primary-button');
    if (createButton) createButton.textContent = '创建并自动整理';
    const note = document.querySelector('#project-dialog .modal-title-row p');
    if (note) {
      note.textContent = APP_CLIENT
        ? '选择这台 Mac 上的原始素材与剧本；项目由 MirrorOrder Host 创建并自动同步、ASR、剧本归集。'
        : '选择 Host 本机可访问的原始素材与剧本；项目由 Host 创建并自动同步、ASR、剧本归集。';
    }
    installProjectCreationBoundary();
    installProjectInputActions();
    if (!HOST_LOCAL && triggerLabel()) {
      triggerLabel().title = '请在 Host 本机或镜序 App 创建项目';
    }
    const actions = document.querySelector('#task-dialog .task-actions');
    if (actions && !actions.querySelector('[data-task-type="prepare_project"]')) {
      const prepare = document.createElement('button');
      prepare.type = 'button'; prepare.dataset.taskType = 'prepare_project'; prepare.textContent = '重新自动整理当前项目';
      const resolve = document.createElement('button');
      resolve.type = 'button'; resolve.dataset.taskType = 'auto_resolve'; resolve.textContent = '重跑自动归集 / AI救援';
      actions.prepend(resolve); actions.prepend(prepare);
      for (const button of [prepare, resolve]) {
        button.addEventListener('click', () => submitTask(button.dataset.taskType).catch((error) => showToast(error.message)));
      }
    }
  }

  function triggerLabel() {
    return document.querySelector('#create-project');
  }

  const baseTaskLabel = taskLabel;
  taskLabel = function automationTaskLabel(task) {
    return ({prepare_project:'自动整理', multicam_sync:'多机位同步', auto_resolve:'自动归集/AI救援'})[task.type]
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
    target.innerHTML = `<span>自动归集 <strong>${auto}</strong></span><span>AI归集 <strong>${ai}</strong></span><span>人工归集 <strong>${human}</strong></span><button id="automation-review" class="automation-review-button ${review ? 'attention' : ''}" type="button">待处理 ${review}</button>`;
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
      row.classList.toggle('automation-needs-review', NEEDS_ATTENTION.has(entry?.status));
      row.querySelector('.automation-badge')?.remove();
      if (!entry?.status) return;
      const labels = {
        auto_confirmed: '已自动归集',
        ai_confirmed: 'AI 已归集',
        human_override: '人工归集',
        needs_review: '归集待确认',
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
    const replace = document.querySelector('#replace-project-script');
    if (replace) replace.title = state.project?.script_path ? `当前剧本：${state.project.script_path}` : '更换当前项目剧本';
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
