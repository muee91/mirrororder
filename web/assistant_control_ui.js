(() => {
  if (window.__mirrorOrderAssistantControlInstalled) return;
  window.__mirrorOrderAssistantControlInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  let assistantPayload = null;
  let modelPayload = null;
  let loading = false;

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function priorityClass(item) {
    const value = Number(item?.priority || 0);
    return value >= 90 ? 'priority-high' : value >= 70 ? 'priority-medium' : 'priority-low';
  }
  function kindLabel(kind) {
    return {decision: '需要你判断', production: '制作提醒', people: '人物线索'}[kind] || '其它';
  }

  function ensureControls() {
    const panel = document.querySelector('#mirror-assistant-panel');
    if (!panel || document.querySelector('#mirror-assistant-controls')) return;
    const controls = document.createElement('section');
    controls.id = 'mirror-assistant-controls';
    controls.className = 'mirror-assistant-controls';
    controls.innerHTML = APP_CLIENT ? `
      <div id="mirror-assistant-model-status" class="mirror-assistant-status-row"><strong>AI连接</strong><span>读取中</span></div>
      <div class="mirror-assistant-control-actions">
        <button type="button" data-assistant-plan="1">让助理规划</button>
        <button type="button" data-assistant-model-toggle="1">模型连接</button>
        <button type="button" data-assistant-agent-toggle="1">Agent API</button>
      </div>
      <div id="mirror-assistant-agent-info" class="mirror-assistant-agent-info" hidden></div>
      <form id="mirror-assistant-model-form" class="mirror-assistant-model-form" hidden>
        <div class="wide mirror-assistant-model-heading"><strong>语言模型</strong><span>用于自然语言解释和受限规划。未连接时仍可使用规则队列。</span></div>
        <label class="wide">语言模型地址<input id="mirror-assistant-model-url" type="url" placeholder="http://127.0.0.1:1234/v1"></label>
        <label>模型名<input id="mirror-assistant-model-name" type="text" placeholder="model-name"></label>
        <label>API Key<input id="mirror-assistant-model-key" type="password" placeholder="留空不修改"></label>
        <label class="wide"><span><input id="mirror-assistant-model-enabled" type="checkbox"> 启用语言模型连接</span></label>
        <div class="wide mirror-assistant-model-heading"><strong>增强多模态</strong><span>可选。启用后高价值 Audit 可使用这个端点；默认仍优先使用你已经启用的本地视觉模型。</span></div>
        <label class="wide">多模态模型地址<input id="mirror-assistant-vision-url" type="url" placeholder="https://provider.example/v1"></label>
        <label>模型名<input id="mirror-assistant-vision-name" type="text" placeholder="vision-model"></label>
        <label>API Key<input id="mirror-assistant-vision-key" type="password" placeholder="留空不修改"></label>
        <label class="wide"><span><input id="mirror-assistant-vision-enabled" type="checkbox"> 启用外部多模态连接</span></label>
        <div class="mirror-assistant-control-actions"><button type="submit">保存连接</button></div>
      </form>
      <form id="mirror-assistant-chat" class="mirror-assistant-chat">
        <input id="mirror-assistant-chat-input" type="text" maxlength="3000" placeholder="问镜序助理当前项目的问题">
        <button type="submit">发送</button>
      </form>
    ` : '<div class="mirror-assistant-status-row"><strong>镜序助理</strong><span>由制作 Host 主动整理问题；Web 只显示可审阅结论和提醒。</span></div>';
    panel.appendChild(controls);
    bindControls();
  }

  function renderBackendNudge(payload) {
    const nudge = document.querySelector('#mirror-assistant-nudge');
    if (!nudge || !payload) return;
    const items = asArray(payload.items).filter((item) => Number(item?.priority || 0) >= 80);
    if (!items.length) {
      nudge.hidden = true;
      return;
    }
    const first = items[0];
    const fingerprint = `${state.projectId || ''}|${payload.revision || 0}|${first.key || first.group_id || ''}`;
    const storageKey = `mirrororder-assistant-host-nudge:${state.workspaceId || ''}:${state.projectId || ''}`;
    try {
      if (localStorage.getItem(storageKey) === fingerprint) {
        nudge.hidden = true;
        return;
      }
    } catch (_error) {}
    nudge.dataset.hostFingerprint = fingerprint;
    nudge.dataset.hostStorageKey = storageKey;
    const text = nudge.querySelector('p');
    if (text) text.textContent = items.length === 1
      ? String(first.message || '有一组素材需要你确认。')
      : `我发现 ${items.length} 个需要优先处理的问题。最先建议看：${first.label || '需要判断'} · ${first.title || first.group_id}`;
    nudge.hidden = false;
  }

  function renderBackendItems(payload) {
    if (!payload) return;
    const items = asArray(payload.items);
    const summary = document.querySelector('#mirror-assistant-summary');
    if (summary) {
      summary.innerHTML = `<p>${esc(payload.summary || '当前没有新的高优先问题。')}</p>`
        + `<div class="mirror-assistant-summary-actions">`
        + (items.some((item) => Number(item.priority || 0) >= 80) ? '<button type="button" data-assistant-first-backend="1">先看最优先的一条</button>' : '')
        + '</div>';
    }
    const list = document.querySelector('#mirror-assistant-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="mirror-assistant-empty">没有新的问题。镜序助理会在归集冲突、低置信素材、媒体缺失或审计反例出现时主动提醒。</div>';
      renderBackendNudge(payload);
      return;
    }
    list.innerHTML = ['decision', 'production', 'people'].map((kind) => {
      const rows = items.filter((item) => item.kind === kind);
      if (!rows.length) return '';
      return `<div class="mirror-assistant-section-title">${esc(kindLabel(kind))} · ${rows.length}</div>`
        + rows.map((item) => {
          const actions = new Set(asArray(item.actions));
          const groupId = String(item.group_id || '');
          return `<article class="mirror-assistant-item ${priorityClass(item)}">`
            + `<div class="mirror-assistant-item-head"><span class="mirror-assistant-priority"></span><strong>${esc(item.title || groupId)}</strong><span>${esc(item.label || '')}</span></div>`
            + `<p class="mirror-assistant-message">${esc(item.message || '')}</p>`
            + (item.context ? `<div class="mirror-assistant-context">${esc(item.context)}</div>` : '')
            + `<div class="mirror-assistant-item-actions">`
            + (actions.has('focus') && groupId ? `<button type="button" data-assistant-focus="${esc(groupId)}">看片</button>` : '')
            + (actions.has('placement') && groupId ? `<button type="button" data-assistant-place="${esc(groupId)}">判断归集</button>` : '')
            + (actions.has('people') ? '<button type="button" data-assistant-people="1">确认人物</button>' : '')
            + '</div></article>';
        }).join('');
    }).join('');

    const entry = document.querySelector('#mirror-assistant-entry');
    if (entry) {
      const count = items.filter((item) => Number(item.priority || 0) >= 80).length;
      entry.classList.toggle('has-attention', count > 0);
      const badge = entry.querySelector('.mirror-assistant-count');
      if (badge) badge.textContent = String(count);
    }
    renderBackendNudge(payload);
  }

  function setConnectionFields(prefix, row) {
    const url = document.querySelector(`#mirror-assistant-${prefix}-url`);
    const name = document.querySelector(`#mirror-assistant-${prefix}-name`);
    const enabled = document.querySelector(`#mirror-assistant-${prefix}-enabled`);
    const key = document.querySelector(`#mirror-assistant-${prefix}-key`);
    if (url && document.activeElement !== url) url.value = row.base_url || '';
    if (name && document.activeElement !== name) name.value = row.model || '';
    if (enabled) enabled.checked = Boolean(row.enabled);
    if (key) key.placeholder = row.has_api_key ? '已保存 · 留空不修改' : '可选';
  }

  function renderModelStatus() {
    if (!APP_CLIENT || !modelPayload) return;
    const models = asObject(modelPayload.models);
    const vision = asObject(models.multimodal_audit || models.vision);
    const language = asObject(models.assistant_language);
    const languageLabel = language.source === 'local-vision-text-fallback'
      ? '复用本地视觉模型'
      : (language.enabled ? '已就绪' : '未连接');
    const target = document.querySelector('#mirror-assistant-model-status');
    if (target) {
      target.innerHTML = `<strong>AI连接</strong>`
        + `<span class="mirror-assistant-status-dot ${vision.enabled ? 'ready' : ''}"></span><span>视觉 ${vision.enabled ? '已就绪' : '未启用'}</span>`
        + `<span class="mirror-assistant-status-dot ${language.enabled ? 'ready' : ''}"></span><span>语言 ${esc(languageLabel)}</span>`
        + `<span class="mirror-assistant-status-dot ready"></span><span>Agent API 已启用</span>`;
    }
    const connections = asObject(modelPayload.connections);
    setConnectionFields('model', asObject(connections.text));
    setConnectionFields('vision', asObject(connections.vision));

    const agent = asObject(modelPayload.agent_api);
    const info = document.querySelector('#mirror-assistant-agent-info');
    if (info) {
      info.innerHTML = `<strong>外部智能体接口</strong><p>Bearer 权限分为 read / analyze / propose。智能体可以读取项目、请求分析和提交提案，但不能直接写人工审核。</p>`
        + `<code>${esc(agent.base || '/api/agent/v1/projects/{project_id}')}</code>`
        + `<small>能力入口 ${esc(agent.capabilities || '/api/agent/v1/capabilities')}</small>`;
    }
  }

  async function refreshAssistant(render = true) {
    if (!state.projectId || loading) return;
    loading = true;
    const projectId = state.projectId;
    try {
      const assistant = await fetchJson(projectApi('/assistant'));
      if (state.projectId !== projectId) return;
      assistantPayload = assistant;
      state.assistantRevision = Number(assistant.revision || 0);
      if (APP_CLIENT) {
        modelPayload = await fetchJson(projectApi('/assistant/models')).catch(() => modelPayload);
      }
      if (render) {
        ensureControls();
        renderBackendItems(assistantPayload);
        renderModelStatus();
      }
    } catch (_error) {
      // The deterministic front-end fallback from assistant_ui.js remains usable.
    } finally {
      loading = false;
    }
  }

  async function runPlan() {
    if (!APP_CLIENT) return;
    showToast('镜序助理正在检查项目并规划下一步');
    const payload = await fetchJson(projectApi('/assistant/cycle'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({force_plan: true}),
    });
    assistantPayload = payload;
    renderBackendItems(payload);
    await refreshAssistant(true);
  }

  function formConnection(prefix) {
    const row = {
      enabled: Boolean(document.querySelector(`#mirror-assistant-${prefix}-enabled`)?.checked),
      provider: 'openai-compatible',
      base_url: document.querySelector(`#mirror-assistant-${prefix}-url`)?.value.trim() || '',
      model: document.querySelector(`#mirror-assistant-${prefix}-name`)?.value.trim() || '',
    };
    const key = document.querySelector(`#mirror-assistant-${prefix}-key`)?.value.trim() || '';
    if (key) row.api_key = key;
    return row;
  }

  async function saveModels(event) {
    event.preventDefault();
    if (!APP_CLIENT) return;
    modelPayload = await fetchJson(projectApi('/assistant/models'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text: formConnection('model'),
        vision: formConnection('vision'),
      }),
    });
    for (const id of ['#mirror-assistant-model-key', '#mirror-assistant-vision-key']) {
      const input = document.querySelector(id);
      if (input) input.value = '';
    }
    await refreshAssistant(true);
    showToast('模型连接已保存到这台 Mac');
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!APP_CLIENT) return;
    const input = document.querySelector('#mirror-assistant-chat-input');
    const message = input?.value.trim() || '';
    if (!message) return;
    if (input) input.disabled = true;
    try {
      const payload = await fetchJson(projectApi('/assistant/message'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message}),
      });
      if (input) input.value = '';
      assistantPayload = payload.assistant || assistantPayload;
      renderBackendItems(assistantPayload);
      const summary = document.querySelector('#mirror-assistant-summary p');
      if (summary && payload.answer) summary.textContent = payload.answer;
    } catch (error) {
      showToast(error.message || '镜序助理暂时无法回答');
    } finally {
      if (input) input.disabled = false;
    }
  }

  function bindControls() {
    document.querySelector('[data-assistant-plan]')?.addEventListener('click', () => runPlan().catch((error) => showToast(error.message)));
    document.querySelector('[data-assistant-model-toggle]')?.addEventListener('click', () => {
      const form = document.querySelector('#mirror-assistant-model-form');
      if (form) form.hidden = !form.hidden;
    });
    document.querySelector('[data-assistant-agent-toggle]')?.addEventListener('click', () => {
      const info = document.querySelector('#mirror-assistant-agent-info');
      if (info) info.hidden = !info.hidden;
    });
    document.querySelector('#mirror-assistant-model-form')?.addEventListener('submit', (event) => saveModels(event).catch((error) => showToast(error.message)));
    document.querySelector('#mirror-assistant-chat')?.addEventListener('submit', (event) => sendMessage(event));
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('#mirror-assistant-entry')) {
      requestAnimationFrame(() => refreshAssistant(true));
      return;
    }
    if (event.target.closest('.mirror-assistant-nudge-close')) {
      const nudge = document.querySelector('#mirror-assistant-nudge');
      if (nudge?.dataset.hostFingerprint && nudge.dataset.hostStorageKey) {
        try { localStorage.setItem(nudge.dataset.hostStorageKey, nudge.dataset.hostFingerprint); } catch (_error) {}
      }
      return;
    }
    if (event.target.closest('[data-assistant-first-backend]')) {
      const first = asArray(assistantPayload?.items).find((item) => Number(item?.priority || 0) >= 80);
      const groupId = String(first?.group_id || '');
      if (groupId) {
        document.querySelector('#mirror-assistant-panel').hidden = true;
        focusGroup(groupId);
      }
    }
  }, false);

  const baseSwitchProject = switchProject;
  switchProject = async function assistantControlSwitchProject(...args) {
    assistantPayload = null;
    modelPayload = null;
    const result = await baseSwitchProject(...args);
    await refreshAssistant(true);
    return result;
  };

  const basePollState = pollState;
  pollState = async function assistantControlPollState() {
    const result = await basePollState();
    try {
      const next = await fetchJson(projectApi('/state'));
      if (Number(next.assistant_revision || 0) !== Number(state.assistantRevision || 0)) {
        await refreshAssistant(true);
      }
    } catch (_error) {}
    return result;
  };

  requestAnimationFrame(() => {
    ensureControls();
    refreshAssistant(true);
  });
})();
