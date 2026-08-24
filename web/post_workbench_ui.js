(() => {
  if (window.__mirrorOrderPostWorkbenchInstalled) return;
  window.__mirrorOrderPostWorkbenchInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  let applyScheduled = false;

  function appState() {
    try { return typeof state === 'object' && state ? state : null; } catch (_error) { return null; }
  }

  function compactEpisodeNavigation() {
    if (APP_CLIENT) return;
    const target = document.querySelector('#episode-picks');
    if (!target) return;
    const episodeButtons = [...target.querySelectorAll(':scope > .episode-pick[data-episode]')];
    const pendingButton = target.querySelector(':scope > .episode-pick[data-mode="unassigned"]');
    if (episodeButtons.length <= 8) {
      target.classList.remove('compact-episode-nav');
      target.querySelector('.episode-nav-controls')?.remove();
      delete target.dataset.compactSignature;
      return;
    }

    const signature = [
      ...episodeButtons.map((button) => `${button.dataset.episode}:${button.classList.contains('active') ? 1 : 0}`),
      `pending:${pendingButton?.textContent || ''}:${pendingButton?.classList.contains('active') ? 1 : 0}`,
    ].join('|');
    if (target.dataset.compactSignature === signature && target.querySelector('.episode-nav-controls')) return;
    target.dataset.compactSignature = signature;
    target.classList.add('compact-episode-nav');
    target.querySelector('.episode-nav-controls')?.remove();

    const controls = document.createElement('div');
    controls.className = 'episode-nav-controls';
    controls.style.display = 'flex';
    controls.style.alignItems = 'center';
    controls.style.gap = '5px';

    const episodeRows = episodeButtons
      .filter((button) => button.dataset.episode !== 'all')
      .map((button) => ({button, episode: Number(button.dataset.episode)}))
      .filter((row) => Number.isFinite(row.episode))
      .sort((a, b) => a.episode - b.episode);
    const activeRow = episodeRows.find((row) => row.button.classList.contains('active')) || null;
    const allButton = episodeButtons.find((button) => button.dataset.episode === 'all') || null;

    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'episode-nav-button';
    previous.textContent = '‹';
    previous.title = '上一集';
    previous.disabled = !activeRow || activeRow.episode === episodeRows[0]?.episode;
    previous.addEventListener('click', () => {
      if (!activeRow) return;
      const index = episodeRows.findIndex((row) => row.episode === activeRow.episode);
      episodeRows[index - 1]?.button.click();
    });

    const select = document.createElement('select');
    select.className = 'episode-nav-select';
    select.setAttribute('aria-label', '切换集数');
    select.innerHTML = '<option value="all">全部集数</option>' + episodeRows
      .map((row) => `<option value="${row.episode}">第${row.episode}集</option>`)
      .join('');
    select.value = activeRow ? String(activeRow.episode) : 'all';
    select.addEventListener('change', () => {
      if (select.value === 'all') allButton?.click();
      else episodeRows.find((row) => String(row.episode) === select.value)?.button.click();
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'episode-nav-button';
    next.textContent = '›';
    next.title = '下一集';
    next.disabled = !activeRow || activeRow.episode === episodeRows[episodeRows.length - 1]?.episode;
    next.addEventListener('click', () => {
      if (!activeRow) return;
      const index = episodeRows.findIndex((row) => row.episode === activeRow.episode);
      episodeRows[index + 1]?.button.click();
    });

    controls.append(previous, select, next);
    if (pendingButton) {
      const pending = document.createElement('button');
      pending.type = 'button';
      pending.className = 'episode-nav-pending';
      pending.textContent = pendingButton.textContent || '待归集';
      pending.classList.toggle('active', pendingButton.classList.contains('active'));
      pending.addEventListener('click', () => pendingButton.click());
      controls.appendChild(pending);
    }
    target.prepend(controls);
  }

  function replaceAssistantText(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (node.nodeValue?.includes('镜序助理')) node.nodeValue = node.nodeValue.replaceAll('镜序助理', '小镜');
    });
  }

  function brandXiaojing() {
    const entry = document.querySelector('#mirror-assistant-entry');
    if (entry) {
      const spans = entry.querySelectorAll('span');
      if (spans[1] && spans[1].textContent !== '小镜') spans[1].textContent = '小镜';
      if (spans[1]) spans[1].classList.add('entry-label');
      const count = entry.querySelector('.mirror-assistant-count')?.textContent || '0';
      const title = Number(count) > 0 ? `小镜有 ${count} 个优先问题` : '打开小镜';
      if (entry.title !== title) entry.title = title;
      if (entry.getAttribute('aria-label') !== title) entry.setAttribute('aria-label', title);
    }
    const panel = document.querySelector('#mirror-assistant-panel');
    if (panel) {
      panel.setAttribute('aria-label', '小镜');
      const close = panel.querySelector('.mirror-assistant-close');
      if (close) close.setAttribute('aria-label', '关闭小镜');
      replaceAssistantText(panel);
    }
    const nudge = document.querySelector('#mirror-assistant-nudge');
    if (nudge) {
      replaceAssistantText(nudge);
      if (!APP_CLIENT) nudge.hidden = true;
    }
    const control = document.querySelector('#assistant-control-root');
    if (control) replaceAssistantText(control);
    document.querySelectorAll(
      '#mirror-assistant-panel input[placeholder*="镜序助理"],#mirror-assistant-panel textarea[placeholder*="镜序助理"],#assistant-control-root input[placeholder*="镜序助理"],#assistant-control-root textarea[placeholder*="镜序助理"]'
    ).forEach((node) => {
      node.placeholder = node.placeholder.replaceAll('镜序助理', '小镜');
    });
  }

  function installIdentityRoleTitle() {
    if (typeof window.identityTitle !== 'function' || window.identityTitle.__xiaojingPatched) return;
    const original = window.identityTitle;
    const wrapped = function identityTitleWithSuggestion(identity) {
      const explicit = String(identity?.role_name || '').trim();
      const suggested = String(identity?.suggested_role_name || '').trim();
      if (explicit || !suggested) return original(identity);
      const label = String(identity?.label || '').trim();
      return `${label || (identity?.kind === 'face' ? '人物候选' : '声纹候选')} · ${suggested}（推测）`;
    };
    wrapped.__xiaojingPatched = true;
    window.identityTitle = wrapped;
  }

  function decorateIdentitySuggestions() {
    const current = appState();
    const identities = current?.identityLibrary?.identities;
    if (!Array.isArray(identities)) return;
    const filter = current?.identityLibrary?.filter || 'face';
    const visible = identities
      .filter((identity) => identity?.kind === filter)
      .filter((identity) => identity.confirmed || Number(identity.take_count || 0) >= 2);
    document.querySelectorAll('.identity-library-card').forEach((card, index) => {
      const identity = visible[index];
      const role = String(identity?.suggested_role_name || '').trim();
      const confidence = Number(identity?.suggested_role_confidence || 0);
      const signature = `${identity?.identity_id || index}|${role}|${confidence}|${identity?.role_name || ''}`;
      if (card.dataset.roleSuggestionSignature === signature) return;
      card.dataset.roleSuggestionSignature = signature;
      card.querySelector('.identity-role-suggestion')?.remove();
      if (!role || String(identity?.role_name || '').trim()) return;
      const hint = document.createElement('span');
      hint.className = 'identity-role-suggestion';
      const safeRole = role.replace(/[&<>"']/g, '');
      hint.innerHTML = `<span>角色推测</span><strong>${safeRole}</strong><span>${Number.isFinite(confidence) && confidence > 0 ? `${Math.round(confidence * 100)}%` : ''}</span>`;
      card.querySelector('.identity-card-body header')?.after(hint);
    });
  }

  function applyPostWorkbench() {
    compactEpisodeNavigation();
    brandXiaojing();
    installIdentityRoleTitle();
    decorateIdentitySuggestions();
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    requestAnimationFrame(() => {
      applyScheduled = false;
      applyPostWorkbench();
    });
  }

  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.body, {childList: true, subtree: true});
  document.addEventListener('click', scheduleApply, true);
  scheduleApply();
})();