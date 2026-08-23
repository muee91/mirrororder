(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderSemanticSearchInstalled) return;
  window.__mirrorOrderSemanticSearchInstalled = true;

  let mounted = false;
  let modelState = null;
  let currentResults = [];
  const asArray = (value) => Array.isArray(value) ? value : [];
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function ensureSurface() {
    if (mounted) return;
    const controls = document.querySelector('#mirror-assistant-controls');
    if (!controls) return;
    const chat = controls.querySelector('#mirror-assistant-chat');
    const section = document.createElement('section');
    section.id = 'mirror-semantic-search';
    section.className = 'mirror-semantic-search';
    section.innerHTML = `
      <form id="mirror-semantic-search-form" class="mirror-semantic-search-form">
        <div class="mirror-semantic-search-title"><strong>找素材</strong><span id="mirror-semantic-search-mode">画面 · 对白 · 场记</span></div>
        <div class="mirror-semantic-search-row">
          <input id="mirror-semantic-search-input" type="search" maxlength="1000" autocomplete="off" placeholder="例如：门口反应镜头 / 红色杯子 / 后面笑场">
          <button type="submit">搜索</button>
        </div>
      </form>
      <div id="mirror-semantic-search-results" class="mirror-semantic-search-results" hidden></div>
      <details class="mirror-semantic-settings">
        <summary>语义检索设置</summary>
        <div class="mirror-semantic-settings-body">
          <p>未连接语义模型时仍可按对白、场记和描述关键词搜索；连接后会补充语义相似召回。写入和查询使用同一模型。</p>
          <label>模型地址<input id="mirror-semantic-model-url" type="url" placeholder="http://127.0.0.1:1234/v1"></label>
          <label>模型名<input id="mirror-semantic-model-name" type="text" placeholder="embedding-model"></label>
          <label>API Key<input id="mirror-semantic-model-key" type="password" placeholder="可选"></label>
          <label class="mirror-semantic-check"><input id="mirror-semantic-model-enabled" type="checkbox"> 启用语义相似搜索</label>
          <button id="mirror-semantic-model-save" type="button">保存语义检索连接</button>
          <span id="mirror-semantic-model-status"></span>
        </div>
      </details>
    `;
    if (chat) controls.insertBefore(section, chat);
    else controls.appendChild(section);
    mounted = true;
    bind();
    refreshModel().catch(() => {});
  }

  function modeText(mode) {
    if (mode === 'hybrid') return '语义 + 关键词';
    if (mode === 'vector') return '语义相似';
    return '关键词模式';
  }

  function resultTime(row) {
    const start = Number(row?.start || 0);
    const end = Number(row?.end || 0);
    return end > start ? `${start.toFixed(1)}–${end.toFixed(1)}s` : '';
  }

  function renderResults(payload) {
    const target = document.querySelector('#mirror-semantic-search-results');
    const mode = document.querySelector('#mirror-semantic-search-mode');
    if (mode) mode.textContent = modeText(payload?.mode);
    if (!target) return;
    currentResults = asArray(payload?.results);
    target.hidden = false;
    if (!currentResults.length) {
      target.innerHTML = '<div class="mirror-semantic-empty">没有找到足够相关的画面、对白或场记证据。换一个更具体的动作、台词或现场备注试试。</div>';
      return;
    }
    target.innerHTML = currentResults.map((row, index) => {
      const groupId = String(row.group_id || '');
      const label = String(row.source_label || '素材');
      const time = resultTime(row);
      return `
        <article class="mirror-semantic-result">
          <div class="mirror-semantic-result-head"><span>${esc(label)}</span><strong>${esc(groupId ? `Take ${groupId}` : '独立场记素材')}</strong>${time ? `<span>${esc(time)}</span>` : ''}</div>
          <p>${esc(row.snippet || '')}</p>
          ${groupId ? `<button type="button" data-semantic-result-index="${index}">${row.source === 'speech' && time ? '定位对白' : '看片定位'}</button>` : ''}
        </article>`;
    }).join('');
    target.querySelectorAll('[data-semantic-result-index]').forEach((button) => {
      button.addEventListener('click', () => focusResult(currentResults[Number(button.dataset.semanticResultIndex)]));
    });
  }

  function focusResult(row) {
    const groupId = String(row?.group_id || '');
    if (!groupId) return;
    if (typeof window.focusGroup === 'function') window.focusGroup(groupId);
    requestAnimationFrame(() => {
      const group = state.groupMap.get(groupId);
      if (!group) return;
      const clipId = String(row?.clip_id || '') || String(group.members?.[0]?.clip_id || '');
      const member = group.members?.find((item) => item.clip_id === clipId) || group.members?.[0];
      if (!member) return;
      selectMember(groupId, member.clip_id, false);
      const player = document.querySelector('#player');
      if (!player) return;
      const relativeStart = Math.max(0, Number(row?.start || 0));
      const absoluteStart = Math.max(0, Number(member.source_start || 0) + relativeStart);
      const seek = () => {
        const mediaEnd = Number.isFinite(Number(member.source_end)) ? Number(member.source_end) : Number(player.duration || absoluteStart);
        const upper = Number.isFinite(mediaEnd) && mediaEnd > 0 ? Math.max(0, mediaEnd - 0.02) : absoluteStart;
        player.currentTime = Math.min(absoluteStart, upper);
      };
      if (player.readyState >= 1) seek();
      else player.addEventListener('loadedmetadata', seek, {once: true});
    });
  }

  async function runSearch(event) {
    event?.preventDefault?.();
    const input = document.querySelector('#mirror-semantic-search-input');
    const query = input?.value.trim() || '';
    if (!query || !state.projectId) return;
    const button = document.querySelector('#mirror-semantic-search-form button[type="submit"]');
    if (button) button.disabled = true;
    try {
      const payload = await fetchJson(projectApi(`/semantic-search?q=${encodeURIComponent(query)}&limit=16`));
      renderResults(payload);
    } catch (error) {
      showToast(error.message || '素材搜索失败');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function setFields(row) {
    const url = document.querySelector('#mirror-semantic-model-url');
    const name = document.querySelector('#mirror-semantic-model-name');
    const key = document.querySelector('#mirror-semantic-model-key');
    const enabled = document.querySelector('#mirror-semantic-model-enabled');
    if (url && document.activeElement !== url) url.value = row.base_url || '';
    if (name && document.activeElement !== name) name.value = row.model || '';
    if (enabled) enabled.checked = Boolean(row.enabled);
    if (key) key.placeholder = row.has_api_key ? '已保存 · 留空不修改' : '可选';
    const status = document.querySelector('#mirror-semantic-model-status');
    if (status) status.textContent = row.enabled ? '已启用；下一次搜索会更新受影响的语义索引。' : '当前使用关键词检索。';
  }

  async function refreshModel() {
    if (!state.projectId) return;
    modelState = await fetchJson(projectApi('/assistant/models'));
    setFields(asObject(modelState?.connections?.embedding));
  }

  async function saveModel() {
    if (!state.projectId) return;
    const row = {
      enabled: Boolean(document.querySelector('#mirror-semantic-model-enabled')?.checked),
      provider: 'openai-compatible',
      base_url: document.querySelector('#mirror-semantic-model-url')?.value.trim() || '',
      model: document.querySelector('#mirror-semantic-model-name')?.value.trim() || '',
    };
    const key = document.querySelector('#mirror-semantic-model-key')?.value.trim() || '';
    if (key) row.api_key = key;
    const button = document.querySelector('#mirror-semantic-model-save');
    if (button) button.disabled = true;
    try {
      modelState = await fetchJson(projectApi('/assistant/models'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({embedding: row}),
      });
      const keyInput = document.querySelector('#mirror-semantic-model-key');
      if (keyInput) keyInput.value = '';
      await refreshModel();
      showToast('语义检索连接已保存到这台 Mac');
    } catch (error) {
      showToast(error.message || '保存语义检索连接失败');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bind() {
    document.querySelector('#mirror-semantic-search-form')?.addEventListener('submit', runSearch);
    document.querySelector('#mirror-semantic-model-save')?.addEventListener('click', () => saveModel());
  }

  const observer = new MutationObserver(() => ensureSurface());
  observer.observe(document.documentElement, {childList: true, subtree: true});
  document.addEventListener('click', (event) => {
    if (event.target.closest('#mirror-assistant-entry')) requestAnimationFrame(ensureSurface);
  });
  requestAnimationFrame(ensureSurface);
})();
