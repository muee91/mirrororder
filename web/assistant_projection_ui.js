(() => {
  if (window.__mirrorOrderAssistantProjectionInstalled) return;
  if (window.webkit?.messageHandlers?.mirrorOrder) return;
  window.__mirrorOrderAssistantProjectionInstalled = true;

  let loading = false;
  let payload = null;
  const MAX_VISIBLE_ITEMS = 40;

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function ensureSurface() {
    let entry = document.querySelector('#mirror-assistant-entry');
    if (!entry) {
      const target = document.querySelector('.toolbar-summary');
      if (target) {
        entry = document.createElement('button');
        entry.id = 'mirror-assistant-entry';
        entry.className = 'mirror-assistant-entry';
        entry.type = 'button';
        entry.innerHTML = '<span class="mirror-assistant-mark" aria-hidden="true"></span><span>小镜</span><span class="mirror-assistant-count" hidden>0</span>';
        entry.title = '查看制作 Host 已整理的小镜结果';
        const identity = document.querySelector('#identity-library-button');
        target.insertBefore(entry, identity || target.firstChild);
      }
    }

    if (!document.querySelector('#mirror-assistant-panel')) {
      const panel = document.createElement('aside');
      panel.id = 'mirror-assistant-panel';
      panel.className = 'mirror-assistant-panel';
      panel.hidden = true;
      panel.setAttribute('aria-label', '小镜');
      panel.innerHTML = `
        <div class="mirror-assistant-head">
          <div class="mirror-assistant-identity">
            <span class="mirror-assistant-mark" aria-hidden="true"></span>
            <div><strong>小镜</strong><span>由制作 Host 计算 · Web 只展示结果</span></div>
          </div>
          <button class="mirror-assistant-close" type="button" aria-label="关闭小镜">关闭</button>
        </div>
        <div id="mirror-assistant-summary" class="mirror-assistant-summary"><p>打开后读取制作 Host 已整理的结果。</p></div>
        <div id="mirror-assistant-list" class="mirror-assistant-list"></div>
      `;
      document.body.appendChild(panel);
    }
  }

  function priorityClass(item) {
    const value = Number(item?.priority || 0);
    return value >= 90 ? 'priority-high' : value >= 70 ? 'priority-medium' : 'priority-low';
  }

  function kindLabel(kind) {
    return {decision: '需要你判断', production: '制作提醒', people: '人物线索'}[kind] || '其它';
  }

  function renderAssistant(next) {
    payload = next || {};
    const items = asArray(payload.items);
    const summary = document.querySelector('#mirror-assistant-summary');
    if (summary) summary.innerHTML = `<p>${esc(payload.summary || (items.length ? `制作 Host 已整理 ${items.length} 条结果。` : '制作 Host 暂无需要展示的小镜结果。'))}</p>`;

    const entry = document.querySelector('#mirror-assistant-entry');
    const badge = entry?.querySelector('.mirror-assistant-count');
    const attentionCount = items.filter((item) => Number(item?.priority || 0) >= 80).length;
    if (badge) {
      badge.textContent = String(attentionCount);
      badge.hidden = attentionCount <= 0;
    }
    entry?.classList.toggle('has-attention', attentionCount > 0);

    const list = document.querySelector('#mirror-assistant-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="mirror-assistant-empty">当前没有 Host 已确认需要展示的问题。Web 不会自行重新分析整个项目。</div>';
      return;
    }

    const visible = items.slice(0, MAX_VISIBLE_ITEMS);
    const kinds = ['decision', 'production', 'people'];
    list.innerHTML = kinds.map((kind) => {
      const rows = visible.filter((item) => item.kind === kind);
      if (!rows.length) return '';
      return `<div class="mirror-assistant-section-title">${esc(kindLabel(kind))} · ${rows.length}</div>`
        + rows.map((item) => {
          const groupId = String(item.group_id || '');
          const actions = new Set(asArray(item.actions));
          return `<article class="mirror-assistant-item ${priorityClass(item)}">`
            + `<div class="mirror-assistant-item-head"><span class="mirror-assistant-priority"></span><strong>${esc(item.title || groupId || '项目提示')}</strong><span>${esc(item.label || '')}</span></div>`
            + `<p class="mirror-assistant-message">${esc(item.message || '')}</p>`
            + (item.context ? `<div class="mirror-assistant-context">${esc(item.context)}</div>` : '')
            + `<div class="mirror-assistant-item-actions">`
            + (actions.has('focus') && groupId ? `<button type="button" data-assistant-projection-focus="${esc(groupId)}">看片</button>` : '')
            + (actions.has('placement') && groupId ? `<button type="button" data-assistant-projection-place="${esc(groupId)}">判断归集</button>` : '')
            + '</div></article>';
        }).join('');
    }).join('') + (items.length > visible.length
      ? `<div class="mirror-assistant-empty">还有 ${items.length - visible.length} 条低优先结果未展开。请在制作 App 中查看完整分析。</div>`
      : '');
  }

  async function refreshAssistant() {
    if (loading || !state.projectId) return;
    loading = true;
    const projectId = state.projectId;
    const summary = document.querySelector('#mirror-assistant-summary');
    if (summary) summary.innerHTML = '<p>正在读取制作 Host 已整理的小镜结果…</p>';
    try {
      const next = await fetchJson(projectApi('/assistant'), {timeoutMs: 8000});
      if (state.projectId !== projectId) return;
      renderAssistant(next);
    } catch (error) {
      if (summary) summary.innerHTML = `<p>${esc(error?.message || '暂时无法读取小镜结果')}</p>`;
    } finally {
      loading = false;
    }
  }

  function openAssistant() {
    ensureSurface();
    const panel = document.querySelector('#mirror-assistant-panel');
    if (panel) panel.hidden = false;
    refreshAssistant();
  }

  function closeAssistant() {
    const panel = document.querySelector('#mirror-assistant-panel');
    if (panel) panel.hidden = true;
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
    const focus = event.target.closest('[data-assistant-projection-focus]');
    if (focus) {
      closeAssistant();
      focusGroup(String(focus.dataset.assistantProjectionFocus || ''));
      return;
    }
    const placement = event.target.closest('[data-assistant-projection-place]');
    if (placement) {
      const groupId = String(placement.dataset.assistantProjectionPlace || '');
      closeAssistant();
      if (focusGroup(groupId)) requestAnimationFrame(() => openPlacement(groupId));
    }
  }, true);

  document.querySelector('#project-select')?.addEventListener('change', () => { payload = null; });
  document.querySelector('#workspace-select')?.addEventListener('change', () => { payload = null; });
  ensureSurface();
})();
