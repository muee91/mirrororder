(() => {
  if (window.__mirrorOrderIntelligenceUIInstalled) return;
  window.__mirrorOrderIntelligenceUIInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  const SHOT_LABELS = {
    wide: '全景',
    full: '全身',
    medium: '中景',
    medium_closeup: '中近景',
    closeup: '近景',
    extreme_closeup: '特写',
    insert: '细节',
  };
  let nativeAudit = null;
  let nativeRolesByGroup = new Map();
  let nativeProjectId = '';

  function currentTake(groupId) {
    return (state.reviewModel?.take_groups || []).find((take) => take.group_id === groupId) || null;
  }

  function nativeAuditRow(groupId) {
    if (!nativeAudit || nativeAudit.stale) return null;
    const row = nativeAudit.groups?.[groupId];
    return row && typeof row === 'object' ? row : null;
  }

  function shotFor(group, member) {
    if (member?.shot_type && member.shot_type !== 'unknown') {
      return {
        shot_type: member.shot_type,
        coverage_role: member.coverage_role || 'unknown',
        technical_issues: member.technical_issues || [],
      };
    }
    if (APP_CLIENT) {
      const row = nativeAuditRow(group?.group_id);
      return row?.shot_intelligence?.angles?.[member?.clip_id] || null;
    }
    const angle = currentTake(group?.group_id)?.angles?.find((item) => item.clip_id === member?.clip_id);
    return angle || null;
  }

  function confirmedRoles(group) {
    const roles = new Set();
    if (APP_CLIENT) {
      for (const role of nativeRolesByGroup.get(group?.group_id) || []) roles.add(role);
      return [...roles];
    }
    const people = group?.people || currentTake(group?.group_id)?.people || {};
    for (const person of [...(people.speakers || []), ...(people.faces || [])]) {
      if (!person?.confirmed) continue;
      const role = String(person.role_name || '').trim();
      if (role) roles.add(role);
    }
    return [...roles];
  }

  function roleSuggestions(group) {
    if (APP_CLIENT) return nativeAuditRow(group?.group_id)?.role_suggestions || [];
    return group?.role_suggestions || currentTake(group?.group_id)?.role_suggestions || [];
  }

  function issuesFor(group) {
    if (APP_CLIENT) return nativeAuditRow(group?.group_id)?.issues || [];
    return (group?.issues || currentTake(group?.group_id)?.issues || []).filter((item) => (
      item?.source === 'ai_audit' || item?.source === 'audit'
    ));
  }

  function intelligenceRoleMarkup(group) {
    const confirmed = confirmedRoles(group);
    if (confirmed.length) {
      return `<span class="role-chip confirmed" title="已确认角色">角色 · ${esc(confirmed.slice(0, 2).join(' / '))}</span>`;
    }
    const suggestions = roleSuggestions(group)
      .filter((item) => item?.role_name && Number(item.confidence || 0) >= 0.70)
      .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
    if (!suggestions.length) return '';
    const first = suggestions[0];
    return `<span class="role-chip suggested" title="声纹与当前剧本对白一致，仍需人工确认">角色候选 · ${esc(first.role_name)}</span>`;
  }

  const baseRenderMemberStrip = renderMemberStrip;
  renderMemberStrip = function intelligenceRenderMemberStrip(group) {
    const html = baseRenderMemberStrip(group);
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('[data-member-clip]').forEach((card) => {
      const member = (group.members || []).find((item) => item.clip_id === card.dataset.memberClip);
      const intelligence = shotFor(group, member);
      const label = SHOT_LABELS[intelligence?.shot_type];
      if (!label) return;
      const bottom = card.querySelector('.member-bottom');
      if (!bottom || bottom.querySelector('.shot-chip')) return;
      const span = document.createElement('span');
      span.className = 'shot-chip';
      span.textContent = label;
      const technical = intelligence?.technical_issues || [];
      if (technical.length) span.title = `景别：${label} · 素材提示：${technical.join('；')}`;
      else span.title = `景别：${label}`;
      const time = bottom.querySelector('.member-time');
      if (time) bottom.insertBefore(span, time);
      else bottom.appendChild(span);
    });
    return container.innerHTML;
  };

  const baseRenderTakeRow = renderTakeRow;
  renderTakeRow = function intelligenceRenderTakeRow(group, candidate, segmentId, contextOnly = false) {
    const html = baseRenderTakeRow(group, candidate, segmentId, contextOnly);
    const container = document.createElement('div');
    container.innerHTML = html;
    const row = container.firstElementChild;
    if (!row) return html;
    const top = row.querySelector('.take-info-top');
    const role = intelligenceRoleMarkup(group);
    if (top && role) top.insertAdjacentHTML('beforeend', role);
    const issues = issuesFor(group);
    if (top && issues.length) {
      top.insertAdjacentHTML('beforeend', `<span class="audit-issue-chip" title="素材审计发现 ${issues.length} 项需要留意">素材问题 ${issues.length}</span>`);
    }
    const detail = row.querySelector('.take-details-body');
    if (detail && issues.length) {
      const list = issues.slice(0, 6).map((item) => {
        const label = item.label || item.code || '素材问题';
        const text = item.detail ? `${label}：${item.detail}` : label;
        return `<li>${esc(text)}</li>`;
      }).join('');
      detail.insertAdjacentHTML('beforeend', `<ul class="audit-detail-list">${list}</ul>`);
    }
    return row.outerHTML;
  };

  const baseRenderInspector = renderInspector;
  renderInspector = function intelligenceRenderInspector(group, member) {
    const result = baseRenderInspector(group, member);
    const intelligence = shotFor(group, member);
    const label = SHOT_LABELS[intelligence?.shot_type];
    const range = $('#player-range');
    if (range && label && !range.dataset.shotDecorated) {
      range.textContent = `${label} · ${range.textContent}`;
      range.dataset.shotDecorated = '1';
    } else if (range && !label) {
      delete range.dataset.shotDecorated;
    }
    return result;
  };

  function buildNativeRoleIndex(identities) {
    const result = new Map();
    for (const identity of identities || []) {
      if (!identity?.confirmed) continue;
      const role = String(identity.role_name || identity.label || '').trim();
      if (!role) continue;
      for (const occurrence of identity.occurrences || []) {
        const groupId = String(occurrence?.group_id || '');
        if (!groupId) continue;
        if (!result.has(groupId)) result.set(groupId, new Set());
        result.get(groupId).add(role);
      }
    }
    return new Map([...result.entries()].map(([groupId, roles]) => [groupId, [...roles]]));
  }

  function rerenderNativeIntelligence() {
    renderContent();
    const group = state.groupMap.get(state.selectedGroupId);
    const member = group?.members?.find((item) => item.clip_id === state.selectedClipId);
    if (group && member) renderInspector(group, member);
    ensureAuditButton();
  }

  async function refreshNativeIntelligence(render = true) {
    if (!APP_CLIENT || !state.projectId) return;
    const projectId = state.projectId;
    const [audit, identities] = await Promise.all([
      fetchJson(projectApi('/audit')).catch(() => null),
      fetchJson(projectApi('/identities')).catch(() => ({identities: []})),
    ]);
    if (state.projectId !== projectId) return;
    nativeAudit = audit;
    nativeProjectId = projectId;
    nativeRolesByGroup = buildNativeRoleIndex(identities?.identities || []);
    state.auditRevision = Number(audit?.revision || 0);
    if (render) rerenderNativeIntelligence();
  }

  async function runPriorityAudit(button) {
    if (!APP_CLIENT || !state.projectId) return;
    button.disabled = true;
    try {
      const response = await fetchJson(projectApi('/audit'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({mode: 'priority', max_groups: 60}),
      });
      const taskId = response.task?.task_id || '';
      showToast(taskId ? '素材审计已进入后台队列' : '素材审计已提交');
      if (typeof refreshTasks === 'function') refreshTasks().catch(() => {});
    } catch (error) {
      showToast(error.message || '素材审计提交失败');
    } finally {
      button.disabled = false;
    }
  }

  function ensureAuditButton() {
    if (!APP_CLIENT || document.querySelector('#native-audit-button')) return;
    const meta = document.querySelector('#production-bar .production-bar-meta');
    if (!meta) return;
    const button = document.createElement('button');
    button.id = 'native-audit-button';
    button.className = 'native-audit-button';
    button.type = 'button';
    button.textContent = '审计素材';
    button.title = '优先审计冲突、待处理和证据不足的 Take；已缓存结果不会重复推理';
    button.addEventListener('click', () => runPriorityAudit(button));
    meta.prepend(button);
  }

  if (APP_CLIENT) {
    const baseReloadAnalysis = reloadAnalysis;
    reloadAnalysis = async function intelligenceReloadAnalysis(...args) {
      const result = await baseReloadAnalysis(...args);
      await refreshNativeIntelligence(false);
      rerenderNativeIntelligence();
      return result;
    };

    const basePollState = pollState;
    pollState = async function intelligencePollState() {
      await basePollState();
      if (!state.projectId) return;
      try {
        const next = await fetchJson(projectApi('/state'));
        if (
          Number(next.audit_revision || 0) !== Number(state.auditRevision || 0)
          || (nativeAudit && Boolean(next.audit_stale) !== Boolean(nativeAudit.stale))
        ) {
          await refreshNativeIntelligence(true);
        }
      } catch (_error) {}
    };

    requestAnimationFrame(ensureAuditButton);
  }
})();
