(() => {
  if (window.__mirrorOrderPostWorkbenchInstalled) return;
  window.__mirrorOrderPostWorkbenchInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  let applyScheduled = false;

  function appState() {
    try { return typeof state === 'object' && state ? state : null; } catch (_error) { return null; }
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
      '#mirror-assistant-panel input[placeholder*="镜序助理"],#mirror-assistant-panel textarea[placeholder*="镜序助理"],#assistant-control-root input[placeholder*="镜序助理"],#assistant-control-root textarea[placeholder*="镜序助理"],#mirror-assistant-panel input[placeholder*="小镜"],#mirror-assistant-panel textarea[placeholder*="小镜"],#assistant-control-root input[placeholder*="小镜"],#assistant-control-root textarea[placeholder*="小镜"]'
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
