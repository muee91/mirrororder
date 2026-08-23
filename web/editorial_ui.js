(() => {
  if (window.__mirrorOrderEditorialUIInstalled) return;
  window.__mirrorOrderEditorialUIInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  const LABELS = {best: '最佳', keep: '保留', reject: '隐藏', unreviewed: '未核对'};

  function installStyles() {
    if (document.querySelector('style[data-editorial-ui]')) return;
    const style = document.createElement('style');
    style.dataset.editorialUi = '1';
    style.textContent = `
      .editorial-team-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 2px;color:var(--muted,#8f96a3);font-size:11px}
      .editorial-team-row strong{color:var(--text,#e8eaed);font-weight:600}
      .editorial-team-row .editorial-final{color:var(--text,#e8eaed);border-left:1px solid var(--line,#343841);padding-left:8px}
      .editorial-team-details{display:inline-block}
      .editorial-team-details summary{cursor:pointer;list-style:none;color:inherit}
      .editorial-team-details summary::-webkit-details-marker{display:none}
      .editorial-team-list{margin-top:6px;padding:7px 9px;border:1px solid var(--line,#343841);border-radius:7px;background:var(--panel,#1b1b1d);min-width:190px}
      .editorial-team-list div{display:flex;justify-content:space-between;gap:16px;padding:2px 0}
      .editorial-team-list span:last-child{color:var(--text,#e8eaed)}
      .native-editorial-section{border-top:1px solid var(--line,#343841);padding-top:12px}
      .native-editorial-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:7px}
      .native-editorial-head strong{font-size:12px}
      .native-editorial-head span{font-size:10px;color:var(--muted,#8f96a3)}
      .native-editorial-summary{font-size:11px;color:var(--muted,#8f96a3);line-height:1.45;margin-bottom:8px}
      .native-editorial-summary b{color:var(--text,#e8eaed);font-weight:600}
      .native-editorial-actions{display:flex;gap:5px;flex-wrap:wrap}
      .native-editorial-actions button{font-size:11px;padding:5px 7px;border:1px solid var(--line,#343841);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
      .native-editorial-actions button.selected{background:var(--elevated,#222326);border-color:currentColor}
      .native-editorial-actions button[data-final-state="best"].selected{color:#8fd4ae}
      .native-editorial-actions button[data-final-state="reject"].selected{color:#ef9a9a}
      .native-editorial-note{margin-top:7px;font-size:10px;color:var(--muted,#8f96a3);line-height:1.4}
    `;
    document.head.appendChild(style);
  }

  function stableReviewerId() {
    if (state.reviewerId) return state.reviewerId;
    const key = 'mirrororder-reviewer-id';
    try {
      const existing = localStorage.getItem(key);
      if (existing) {
        state.reviewerId = existing;
        return existing;
      }
    } catch (_error) {}
    let value = '';
    try {
      value = crypto.randomUUID();
    } catch (_error) {
      value = `reviewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
    state.reviewerId = value;
    try { localStorage.setItem(key, value); } catch (_error) {}
    return value;
  }

  function takeModel(groupId) {
    return (state.reviewModel?.take_groups || []).find((take) => take.group_id === groupId) || null;
  }

  function targetOpinions(take, segmentId, contextOnly) {
    const opinions = take?.editorial_state?.individual_opinions || {};
    if (contextOnly) return [...(opinions.group || [])];
    return (opinions.assignments || []).filter((row) => row.target?.segment_id === segmentId);
  }

  function targetDecision(take, segmentId, contextOnly) {
    const decision = take?.editorial_state?.editorial_decision || {};
    if (contextOnly) return decision.group || null;
    return (decision.assignments || []).find((row) => row.target?.segment_id === segmentId) || null;
  }

  function myOpinion(segmentId, group) {
    const take = takeModel(group?.group_id);
    if (!take) return null;
    const contextOnly = !segmentId;
    return targetOpinions(take, segmentId, contextOnly)
      .find((row) => row.reviewer_id && row.reviewer_id === stableReviewerId()) || null;
  }

  function opinionSummary(opinions) {
    const counts = {best: 0, keep: 0, reject: 0};
    for (const row of opinions) {
      if (row?.state in counts) counts[row.state] += 1;
    }
    return Object.entries(counts)
      .filter(([, count]) => count)
      .map(([kind, count]) => `${count} ${LABELS[kind]}`)
      .join(' · ');
  }

  function teamMarkup(groupId, segmentId, contextOnly) {
    const take = takeModel(groupId);
    if (!take) return '';
    const opinions = targetOpinions(take, segmentId, contextOnly);
    const decision = targetDecision(take, segmentId, contextOnly);
    if (!opinions.length && !decision) return '';
    const summary = opinionSummary(opinions) || '暂无个人意见';
    const rows = opinions.map((row) => (
      `<div><span>${esc(row.actor || '审核人')}</span><span>${esc(LABELS[row.state] || row.state || '—')}</span></div>`
    )).join('');
    return `<div class="editorial-team-row">`
      + (opinions.length
        ? `<details class="editorial-team-details"><summary>团队意见 <strong>${esc(summary)}</strong></summary><div class="editorial-team-list">${rows}</div></details>`
        : '<span>团队暂无个人意见</span>')
      + (decision ? `<span class="editorial-final">最终 <strong>${esc(LABELS[decision.state] || decision.state)}</strong></span>` : '')
      + '</div>';
  }

  async function postOpinion(targetKind, segmentId, groupId, decision) {
    if (!state.actor) {
      showToast('请先设置审核人');
      $('#identity-dialog')?.showModal();
      return false;
    }
    const payload = {
      target_kind: targetKind,
      group_id: groupId,
      state: decision,
      actor: state.actor,
      reviewer_id: stableReviewerId(),
    };
    if (targetKind === 'assignment') payload.segment_id = segmentId;
    const response = await fetchJson(projectApi('/opinions'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    state.editorialRevision = Number(response.editorial?.revision || state.editorialRevision || 0);
    await reloadAnalysis(false);
    state.selectedGroupId = groupId;
    renderContent();
    setCollabStatus('已同步', true);
    showToast(decision === 'unreviewed' ? '已清除我的意见' : `我的${LABELS[decision] || '意见'}已保存`);
    return true;
  }

  function installWebOpinionUI() {
    stableReviewerId();
    const baseAssignmentState = assignmentState;
    assignmentState = function editorialAssignmentState(segmentId, group) {
      const opinion = myOpinion(segmentId, group);
      return opinion?.state || 'unreviewed';
    };

    const baseReviewLabel = reviewLabel;
    reviewLabel = function editorialReviewLabel(segmentId, group) {
      const opinion = myOpinion(segmentId, group);
      if (!opinion) return '尚未提交我的意见';
      const time = formatModified(opinion.updated_at);
      return `我的意见${time ? ` · ${time}` : ''}`;
    };

    setDecision = async function editorialSetDecision(segmentId, groupId, decision) {
      try {
        await postOpinion('assignment', segmentId, groupId, decision);
      } catch (error) {
        setCollabStatus('保存失败', false);
        showToast(error.message);
      }
    };

    setGroupDecision = async function editorialSetGroupDecision(groupId, decision) {
      try {
        await postOpinion('group', '', groupId, decision);
      } catch (error) {
        setCollabStatus('保存失败', false);
        showToast(error.message);
      }
    };

    const baseRenderTakeRow = renderTakeRow;
    renderTakeRow = function editorialRenderTakeRow(group, candidate, segmentId, contextOnly = false) {
      let html = baseRenderTakeRow(group, candidate, segmentId, contextOnly);
      html = html.replace('<div class="take-actions">', `${teamMarkup(group.group_id, segmentId, contextOnly)}<div class="take-actions">`);
      html = html.replace('>最佳</button>', '>我的最佳</button>')
        .replace('>保留</button>', '>我的保留</button>')
        .replace('>隐藏</button>', '>我的隐藏</button>')
        .replace('>恢复</button>', '>清除意见</button>');
      return html;
    };

    const baseUpdateProgress = updateProgress;
    updateProgress = function editorialUpdateProgress() {
      baseUpdateProgress();
      const progress = $('#progress');
      if (progress) progress.textContent = progress.textContent.replace('已审核', '我的意见');
      const filter = $('#show-unknown');
      if (filter && !filter.disabled) {
        filter.textContent = state.unknownOnly ? '显示全部剧本' : '只看我未判断';
      }
    };

    const baseUpdateActorDisplay = updateActorDisplay;
    updateActorDisplay = function editorialUpdateActorDisplay() {
      baseUpdateActorDisplay();
      const button = $('#actor-button');
      if (button && state.actor) button.title = '昵称用于显示；浏览器另有稳定 reviewer_id，重名审核人不会互相覆盖';
    };

    // Keep references alive for diagnostic tools that inspect the legacy layer.
    state.legacyEditorialUI = {assignmentState: baseAssignmentState, reviewLabel: baseReviewLabel};
  }

  let nativeEditorial = {version: 2, revision: 0, opinions: {}, decisions: {}};
  let nativeProjectId = '';

  function nativeTarget() {
    const groupId = state.selectedGroupId || '';
    if (!groupId) return null;
    if (state.mode === 'script' && state.segmentId) {
      return {
        kind: 'assignment',
        group_id: groupId,
        segment_id: state.segmentId,
        key: `assignment|${state.segmentId}|${groupId}`,
      };
    }
    return {kind: 'group', group_id: groupId, segment_id: '', key: `group|${groupId}`};
  }

  function nativeOpinionRows(target) {
    if (!target) return [];
    const row = nativeEditorial.opinions?.[target.key] || {};
    return Object.values(row.reviewers || row.actors || {}).filter((value) => value && typeof value === 'object');
  }

  function nativeDecision(target) {
    return target ? nativeEditorial.decisions?.[target.key] || null : null;
  }

  function ensureNativeInspectorSection() {
    let section = $('#native-editorial-section');
    if (section) return section;
    const inspector = document.querySelector('.inspector');
    if (!inspector) return null;
    section = document.createElement('div');
    section.id = 'native-editorial-section';
    section.className = 'inspector-section native-editorial-section';
    inspector.appendChild(section);
    return section;
  }

  function renderNativeInspector() {
    const section = ensureNativeInspectorSection();
    if (!section) return;
    const target = nativeTarget();
    if (!target) {
      section.innerHTML = '<div class="native-editorial-head"><strong>最终编辑决定</strong><span>Production</span></div><div class="native-editorial-summary">选中一个 Take 后，可查看团队意见并确定最终编辑判断。</div>';
      return;
    }
    const opinions = nativeOpinionRows(target);
    const decision = nativeDecision(target);
    const summary = opinionSummary(opinions) || '暂无团队意见';
    const scope = target.kind === 'assignment' ? '当前剧本段 · 当前 Take' : '当前 Take';
    section.innerHTML = `
      <div class="native-editorial-head"><strong>最终编辑决定</strong><span>${esc(scope)}</span></div>
      <div class="native-editorial-summary">团队意见 <b>${esc(summary)}</b>${decision ? ` · 当前最终 <b>${esc(LABELS[decision.state] || decision.state)}</b>` : ' · 尚未形成最终决定'}</div>
      <div class="native-editorial-actions">
        ${['best', 'keep', 'reject'].map((value) => `<button type="button" data-final-state="${value}" class="${decision?.state === value ? 'selected' : ''}">${esc(LABELS[value])}</button>`).join('')}
        ${decision ? '<button type="button" data-final-state="unreviewed">清除</button>' : ''}
      </div>
      <div class="native-editorial-note">最终决定与个人意见分开保存；当前阶段不会改变 FCPXML 或导出结果。</div>
    `;
    section.querySelectorAll('[data-final-state]').forEach((button) => button.addEventListener('click', () => {
      saveNativeDecision(button.dataset.finalState).catch((error) => showToast(error.message));
    }));
  }

  async function refreshNativeEditorial() {
    if (!state.projectId) return;
    const projectId = state.projectId;
    const payload = await fetchJson(projectApi('/editorial'));
    if (state.projectId !== projectId) return;
    nativeEditorial = payload || {version: 2, revision: 0, opinions: {}, decisions: {}};
    nativeProjectId = projectId;
    renderNativeInspector();
  }

  async function saveNativeDecision(decision) {
    const target = nativeTarget();
    if (!target) return;
    if (!state.actor) {
      showToast('请先设置审核人');
      $('#identity-dialog')?.showModal();
      return;
    }
    if (nativeProjectId !== state.projectId) await refreshNativeEditorial();
    try {
      const response = await fetchJson(projectApi('/editorial-decision'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          target_kind: target.kind,
          group_id: target.group_id,
          ...(target.segment_id ? {segment_id: target.segment_id} : {}),
          state: decision,
          actor: state.actor,
          expected_revision: Number(nativeEditorial.revision || 0),
        }),
      });
      nativeEditorial = response.editorial || nativeEditorial;
      renderNativeInspector();
      showToast(decision === 'unreviewed' ? '最终编辑决定已清除' : `最终编辑决定：${LABELS[decision]}`);
    } catch (error) {
      await refreshNativeEditorial().catch(() => {});
      if (String(error.message || '').includes('revision')) {
        showToast('协作状态已更新，请根据最新团队意见重新确认');
        return;
      }
      throw error;
    }
  }

  function installNativeDecisionUI() {
    const baseRenderInspector = renderInspector;
    renderInspector = function editorialRenderInspector(...args) {
      const result = baseRenderInspector(...args);
      renderNativeInspector();
      return result;
    };

    const baseRenderContent = renderContent;
    renderContent = function editorialNativeRenderContent(...args) {
      const result = baseRenderContent(...args);
      requestAnimationFrame(renderNativeInspector);
      return result;
    };

    const baseSwitchProject = switchProject;
    switchProject = async function editorialNativeSwitchProject(...args) {
      const result = await baseSwitchProject(...args);
      await refreshNativeEditorial().catch(() => {});
      return result;
    };

    refreshNativeEditorial().catch(() => {});
    setInterval(() => {
      if (!document.hidden && state.projectId) refreshNativeEditorial().catch(() => {});
    }, Math.max(2500, Number(state.frontendSettings?.poll_interval_ms || 2500)));
  }

  installStyles();
  if (APP_CLIENT) installNativeDecisionUI();
  else installWebOpinionUI();
})();
