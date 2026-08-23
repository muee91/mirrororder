(() => {
  if (window.__mirrorOrderAssistantInstalled) return;
  window.__mirrorOrderAssistantInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  const PRODUCTION_ISSUE_CODES = new Set([
    'technical_quality',
    'continuity_risk',
    'possible_pickup',
    'multicam_speaker_visual_mismatch',
  ]);
  let nativeAudit = null;
  let currentItems = [];
  let currentFingerprint = '';

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function candidateIds(candidate) {
    return asArray(candidate?.script_segment_ids).length
      ? asArray(candidate.script_segment_ids).map(String)
      : candidate?.script_segment_id ? [String(candidate.script_segment_id)] : [];
  }

  function candidatesFor(group) {
    return asArray(matchRowForGroup(group.group_id)?.candidates)
      .filter((candidate) => candidate && candidate.confidence !== 'context_only')
      .slice()
      .sort((left, right) => Number(right.total_score || 0) - Number(left.total_score || 0));
  }

  function takeModel(groupId) {
    return asArray(state.reviewModel?.take_groups).find((take) => take.group_id === groupId) || null;
  }

  function auditRow(group) {
    if (APP_CLIENT) {
      if (!nativeAudit || nativeAudit.stale) return null;
      const row = nativeAudit.groups?.[group.group_id];
      return row && typeof row === 'object' ? row : null;
    }
    const take = takeModel(group.group_id);
    if (!take?.audit_state?.available || take.audit_state.stale) return null;
    return {
      judge: take.audit_state.judge || {},
      issues: take.issues || group.issues || [],
      role_suggestions: take.role_suggestions || group.role_suggestions || [],
      rough_cut: take.audit_state.rough_cut || {},
    };
  }

  function automationFor(group) {
    if (group?.automation) return group.automation;
    return takeModel(group.group_id)?.automatic_state || {};
  }

  function issuesFor(group) {
    const row = auditRow(group);
    if (row) return asArray(row.issues);
    return asArray(group.issues || takeModel(group.group_id)?.issues);
  }

  function issueCodes(group) {
    return new Set(issuesFor(group).map((item) => String(item?.code || '')).filter(Boolean));
  }

  function groupTitle(group) {
    const rows = asArray(group.members).slice().sort((left, right) => (
      (cameraOrder[left.camera] ?? 99) - (cameraOrder[right.camera] ?? 99)
      || Number(left.timeline_start || 0) - Number(right.timeline_start || 0)
    ));
    const names = rows.slice(0, 3).map((member) => `${member.camera || '?'} · ${memberFileName(member)}`);
    return names.join(' / ') || group.group_id;
  }

  function scoreText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${Math.round(number * 100)}%` : '未知';
  }

  function manualMapping(group) {
    const entry = placementForGroup(group)?.entry;
    if (!entry) return [];
    return asArray(entry.script_segment_ids).map(String).filter(Boolean);
  }

  function missingMembers(group) {
    return asArray(group.members).filter((member) => member?.exists === false || member?.local_exists === false);
  }

  function rangeLabel(candidate) {
    return candidateRangeText(candidate) || '未定位的剧本范围';
  }

  function decisionItem(group) {
    const automatic = automationFor(group);
    const status = String(automatic?.status || '');
    const candidates = candidatesFor(group);
    const first = candidates[0];
    const second = candidates[1];
    const margin = first && second ? Number(first.total_score || 0) - Number(second.total_score || 0) : 1;
    const manualIds = manualMapping(group);
    const topIds = candidateIds(first);
    const codes = issueCodes(group);
    const judge = asObject(auditRow(group)?.judge);
    const mappingConflict = Boolean(manualIds.length && topIds.length && (
      manualIds.length !== topIds.length || manualIds.some((value) => !topIds.includes(value))
    ));

    if (mappingConflict || codes.has('mapping_conflict')) {
      return {
        key: `mapping-conflict:${group.group_id}`,
        groupId: group.group_id,
        kind: 'decision',
        priority: 100,
        title: groupTitle(group),
        label: '归集冲突',
        message: `你已经人工归集了这组素材，但当前算法最像的是「${rangeLabel(first)}」。人工结果不会被覆盖；这正是值得留给下一版算法学习的反例。建议你再看一次素材，确认后保持人工判断即可。`,
        context: first ? `当前首选 ${scoreText(first.total_score)}${second ? ` · 第二候选 ${scoreText(second.total_score)}` : ''}` : '',
        canPlace: true,
      };
    }

    if (String(judge.verdict || '') === 'disagree') {
      return {
        key: `audit-disagree:${group.group_id}`,
        groupId: group.group_id,
        kind: 'decision',
        priority: 96,
        title: groupTitle(group),
        label: '建议复核',
        message: `我对当前自动判断不太放心。${String(judge.reason || '').trim() || '审计证据和当前算法结论没有完全对上。'} 建议先看片，再决定是否保留现在的剧本归集。`,
        context: first ? `当前候选：${rangeLabel(first)} · ${scoreText(first.total_score)}` : '当前没有稳定候选',
        canPlace: true,
      };
    }

    if (status === 'needs_review' || codes.has('needs_review') || codes.has('candidate_competition') || (first && second && margin < 0.08)) {
      const marginText = first && second && Number.isFinite(margin) ? `，两者只差 ${Math.max(0, Math.round(margin * 100))} 个百分点` : '';
      return {
        key: `low-confidence:${group.group_id}`,
        groupId: group.group_id,
        kind: 'decision',
        priority: 88,
        title: groupTitle(group),
        label: '需要你判断',
        message: first && second
          ? `这组素材的前两个剧本候选很接近${marginText}。我不建议自动替你选。请先看片，再用「判断归集」告诉我更接近哪一段。`
          : '这组素材有候选，但证据还不足以自动确认。我不建议替你下结论，看片后再判断会更稳。',
        context: first ? `① ${rangeLabel(first)} · ${scoreText(first.total_score)}${second ? `　② ${rangeLabel(second)} · ${scoreText(second.total_score)}` : ''}` : '',
        canPlace: true,
      };
    }

    if (status === 'unresolved' || codes.has('unresolved') || codes.has('no_candidate') || !first) {
      return {
        key: `unresolved:${group.group_id}`,
        groupId: group.group_id,
        kind: 'decision',
        priority: 84,
        title: groupTitle(group),
        label: '暂时无法归集',
        message: codes.has('no_dialogue_evidence')
          ? '这组没有可靠对白证据，我还不能把它硬绑到某句剧本。先看片；如果它是反应、空镜或过场，只归到集数也可以。'
          : '我还没有足够证据确定这组素材的剧本位置。请先看片；不确定具体台词时，只归到集数比强行匹配更安全。',
        context: '不会因为缺少答案而自动猜一个位置。',
        canPlace: true,
      };
    }

    return null;
  }

  function productionItem(group) {
    const missing = missingMembers(group);
    if (missing.length) {
      return {
        key: `missing-media:${group.group_id}`,
        groupId: group.group_id,
        kind: 'production',
        priority: 98,
        title: groupTitle(group),
        label: '素材不完整',
        message: `当前 Mac 有 ${missing.length} 个机位没有解析到本机素材：${missing.map((member) => `${member.camera || '?'}机`).join('、')}。在素材补齐前，我不建议对这组做最终判断。`,
        context: '先确认媒体绑定，再看片会更可靠。',
        canPlace: false,
      };
    }

    const issues = issuesFor(group).filter((item) => PRODUCTION_ISSUE_CODES.has(String(item?.code || '')));
    const detail = issues.find((item) => item?.detail)?.detail || '';
    if (issues.length) {
      return {
        key: `material-issue:${group.group_id}`,
        groupId: group.group_id,
        kind: 'production',
        priority: 68,
        title: groupTitle(group),
        label: '素材提示',
        message: detail
          ? `我在这组素材里发现一个值得看片时留意的问题：${detail}`
          : `我在这组素材里发现 ${issues.length} 项质量或连续性提示。它们不代表素材一定不能用，但值得你看片时优先确认。`,
        context: '这是素材证据，不会自动变成隐藏或拒绝。',
        canPlace: false,
      };
    }
    return null;
  }

  function peopleItem(group) {
    const suggestions = asArray(auditRow(group)?.role_suggestions || group.role_suggestions || takeModel(group.group_id)?.role_suggestions)
      .filter((item) => item?.role_name && Number(item.confidence || 0) >= 0.70)
      .sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
    if (!suggestions.length) return null;
    const first = suggestions[0];
    return {
      key: `role-suggestion:${group.group_id}:${first.role_name}`,
      groupId: group.group_id,
      kind: 'people',
      priority: 42,
      title: groupTitle(group),
      label: '人物线索',
      message: `我根据现有声纹和已经归集的台词，推测这里的角色可能是「${first.role_name}」。这还不是人工确认；如果你认得演员，可以去人物库确认一次，后面同一身份就不用重复计算。`,
      context: `候选置信 ${scoreText(first.confidence)} · 只作为角色候选`,
      canPlace: false,
    };
  }

  function buildItems() {
    const rows = [];
    for (const group of state.groups || []) {
      const decision = decisionItem(group);
      const production = productionItem(group);
      const people = peopleItem(group);
      if (decision) rows.push(decision);
      if (production) rows.push(production);
      if (people) rows.push(people);
    }
    rows.sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title, 'zh-CN'));
    return rows;
  }

  function attentionItems(items) {
    return items.filter((item) => item.priority >= 80);
  }

  function itemPriorityClass(item) {
    if (item.priority >= 90) return 'priority-high';
    if (item.priority >= 70) return 'priority-medium';
    return 'priority-low';
  }

  function summaryText(items) {
    const attention = attentionItems(items);
    if (!attention.length) {
      if (items.length) return `目前没有需要打断看片的高优先问题。我还留了 ${items.length} 条素材或人物线索，你有空时再看即可。`;
      return '目前没有需要主动打断你的问题。你可以继续看片；我会在算法冲突、低置信素材或素材质量出现明显风险时再提醒你。';
    }
    const decisions = attention.filter((item) => item.kind === 'decision').length;
    const production = attention.filter((item) => item.kind === 'production').length;
    const parts = [];
    if (decisions) parts.push(`${decisions} 组需要你判断`);
    if (production) parts.push(`${production} 组制作问题`);
    return `我发现 ${attention.length} 个值得优先处理的问题：${parts.join('，')}。我按风险排好了顺序，你可以从第一条开始看片。`;
  }

  function ensureSurface() {
    if (!document.querySelector('#mirror-assistant-panel')) {
      const panel = document.createElement('aside');
      panel.id = 'mirror-assistant-panel';
      panel.className = 'mirror-assistant-panel';
      panel.hidden = true;
      panel.setAttribute('aria-label', '镜序助理');
      panel.innerHTML = `
        <div class="mirror-assistant-head">
          <div class="mirror-assistant-identity">
            <span class="mirror-assistant-mark" aria-hidden="true"></span>
            <div><strong>镜序助理</strong><span>看片问题 · 素材线索 · 归集判断</span></div>
          </div>
          <button class="mirror-assistant-close" type="button" aria-label="关闭镜序助理">关闭</button>
        </div>
        <div id="mirror-assistant-summary" class="mirror-assistant-summary"></div>
        <div id="mirror-assistant-list" class="mirror-assistant-list"></div>
      `;
      document.body.appendChild(panel);
    }
    if (!document.querySelector('#mirror-assistant-nudge')) {
      const nudge = document.createElement('div');
      nudge.id = 'mirror-assistant-nudge';
      nudge.className = 'mirror-assistant-nudge';
      nudge.hidden = true;
      nudge.innerHTML = `
        <span class="mirror-assistant-mark" aria-hidden="true"></span>
        <div class="mirror-assistant-nudge-main"><strong>镜序助理</strong><p></p><button class="mirror-assistant-nudge-open" type="button">查看问题</button></div>
        <button class="mirror-assistant-nudge-close" type="button" aria-label="本次稍后提醒">稍后</button>
      `;
      document.body.appendChild(nudge);
    }
    ensureEntry();
  }

  function ensureEntry() {
    if (document.querySelector('#mirror-assistant-entry')) return;
    const target = APP_CLIENT
      ? document.querySelector('#production-bar .production-bar-meta')
      : document.querySelector('.toolbar-summary');
    if (!target) return;
    const button = document.createElement('button');
    button.id = 'mirror-assistant-entry';
    button.className = 'mirror-assistant-entry';
    button.type = 'button';
    button.innerHTML = `<span class="mirror-assistant-mark" aria-hidden="true"></span><span>镜序助理</span><span class="mirror-assistant-count">0</span>`;
    if (APP_CLIENT) target.prepend(button);
    else {
      const identity = document.querySelector('#identity-library-button');
      target.insertBefore(button, identity || target.firstChild);
    }
  }

  function sectionLabel(kind) {
    return {decision: '需要你判断', production: '制作提醒', people: '人物线索'}[kind] || '其它';
  }

  function renderItems(items) {
    const list = document.querySelector('#mirror-assistant-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="mirror-assistant-empty">没有新的问题。继续看片即可；镜序助理只在有明确风险或需要人工判断时主动打断。</div>';
      return;
    }
    const kinds = ['decision', 'production', 'people'];
    list.innerHTML = kinds.map((kind) => {
      const rows = items.filter((item) => item.kind === kind);
      if (!rows.length) return '';
      return `<div class="mirror-assistant-section-title">${esc(sectionLabel(kind))} · ${rows.length}</div>`
        + rows.map((item) => `
          <article class="mirror-assistant-item ${itemPriorityClass(item)}" data-assistant-item="${esc(item.key)}">
            <div class="mirror-assistant-item-head"><span class="mirror-assistant-priority"></span><strong>${esc(item.title)}</strong><span>${esc(item.label)}</span></div>
            <p class="mirror-assistant-message">${esc(item.message)}</p>
            ${item.context ? `<div class="mirror-assistant-context">${esc(item.context)}</div>` : ''}
            <div class="mirror-assistant-item-actions">
              <button type="button" data-assistant-focus="${esc(item.groupId)}">看片</button>
              ${item.canPlace ? `<button type="button" data-assistant-place="${esc(item.groupId)}">判断归集</button>` : ''}
              ${item.kind === 'people' ? '<button type="button" data-assistant-people="1">确认人物</button>' : ''}
            </div>
          </article>
        `).join('');
    }).join('');
  }

  function renderSummary(items) {
    const target = document.querySelector('#mirror-assistant-summary');
    if (!target) return;
    const attention = attentionItems(items);
    target.innerHTML = `<p>${esc(summaryText(items))}</p><div class="mirror-assistant-summary-actions">`
      + (attention.length ? '<button type="button" data-assistant-first="1">先看最优先的一条</button>' : '')
      + (APP_CLIENT ? '<button type="button" data-assistant-audit="1">检查更多素材</button>' : '')
      + '</div>';
  }

  function fingerprint(items) {
    return [state.projectId || '', state.analysisRevision || '', state.auditRevision || '', ...attentionItems(items).slice(0, 12).map((item) => item.key)].join('|');
  }

  function nudgeStorageKey() {
    return `mirrororder-assistant-nudge:${state.workspaceId || ''}:${state.projectId || ''}`;
  }

  function nudgeDismissed(value) {
    try { return localStorage.getItem(nudgeStorageKey()) === value; } catch (_error) { return false; }
  }

  function dismissNudge(value = currentFingerprint) {
    try { localStorage.setItem(nudgeStorageKey(), value); } catch (_error) {}
    const nudge = document.querySelector('#mirror-assistant-nudge');
    if (nudge) nudge.hidden = true;
  }

  function renderNudge(items) {
    const nudge = document.querySelector('#mirror-assistant-nudge');
    if (!nudge) return;
    const attention = attentionItems(items);
    currentFingerprint = fingerprint(items);
    if (!attention.length || nudgeDismissed(currentFingerprint) || !state.projectId) {
      nudge.hidden = true;
      return;
    }
    const first = attention[0];
    const text = nudge.querySelector('p');
    if (text) text.textContent = attention.length === 1
      ? first.message
      : `我发现 ${attention.length} 个需要优先处理的问题。最先建议看：${first.label} · ${first.title}`;
    nudge.hidden = false;
  }

  function renderEntry(items) {
    ensureEntry();
    const button = document.querySelector('#mirror-assistant-entry');
    if (!button) return;
    const count = attentionItems(items).length;
    button.classList.toggle('has-attention', count > 0);
    const counter = button.querySelector('.mirror-assistant-count');
    if (counter) counter.textContent = String(count);
    button.title = count ? `镜序助理有 ${count} 个优先问题` : '镜序助理没有需要优先处理的问题';
  }

  function renderAssistant() {
    ensureSurface();
    currentItems = buildItems();
    renderEntry(currentItems);
    renderSummary(currentItems);
    renderItems(currentItems);
    renderNudge(currentItems);
  }

  function openAssistant() {
    ensureSurface();
    renderAssistant();
    const panel = document.querySelector('#mirror-assistant-panel');
    if (panel) panel.hidden = false;
    dismissNudge();
  }

  function closeAssistant() {
    const panel = document.querySelector('#mirror-assistant-panel');
    if (panel) panel.hidden = true;
  }

  function focusAssistantGroup(groupId, openPlacementAfter = false) {
    closeAssistant();
    if (!focusGroup(groupId)) return;
    if (openPlacementAfter) requestAnimationFrame(() => openPlacement(groupId));
  }

  async function refreshNativeAudit(render = true) {
    if (!APP_CLIENT || !state.projectId) return;
    const projectId = state.projectId;
    const payload = await fetchJson(projectApi('/audit')).catch(() => null);
    if (state.projectId !== projectId) return;
    nativeAudit = payload;
    if (payload) state.auditRevision = Number(payload.revision || 0);
    if (render) renderAssistant();
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('#mirror-assistant-entry')) {
      event.preventDefault();
      openAssistant();
      return;
    }
    if (event.target.closest('.mirror-assistant-close')) {
      closeAssistant();
      return;
    }
    if (event.target.closest('.mirror-assistant-nudge-open')) {
      openAssistant();
      return;
    }
    if (event.target.closest('.mirror-assistant-nudge-close')) {
      dismissNudge();
      return;
    }
    const focus = event.target.closest('[data-assistant-focus]');
    if (focus) {
      focusAssistantGroup(focus.dataset.assistantFocus, false);
      return;
    }
    const placement = event.target.closest('[data-assistant-place]');
    if (placement) {
      focusAssistantGroup(placement.dataset.assistantPlace, true);
      return;
    }
    if (event.target.closest('[data-assistant-people]')) {
      closeAssistant();
      document.querySelector('#identity-library-button')?.click();
      return;
    }
    if (event.target.closest('[data-assistant-first]')) {
      const first = attentionItems(currentItems)[0];
      if (first) focusAssistantGroup(first.groupId, false);
      return;
    }
    if (event.target.closest('[data-assistant-audit]')) {
      const button = document.querySelector('#native-audit-button');
      if (button) button.click();
      else showToast('素材审计入口尚未就绪');
    }
  }, true);

  const baseRenderContent = renderContent;
  renderContent = function assistantRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderAssistant);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function assistantSwitchProject(...args) {
    nativeAudit = null;
    const result = await baseSwitchProject(...args);
    if (APP_CLIENT) await refreshNativeAudit(false);
    renderAssistant();
    return result;
  };

  if (APP_CLIENT) {
    const basePollState = pollState;
    pollState = async function assistantPollState() {
      const result = await basePollState();
      if (Number(nativeAudit?.revision || 0) !== Number(state.auditRevision || 0)) {
        await refreshNativeAudit(false);
      }
      renderAssistant();
      return result;
    };
  }

  ensureSurface();
  requestAnimationFrame(renderAssistant);
})();
