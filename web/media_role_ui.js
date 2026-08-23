(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderMediaRoleUIInstalled) return;
  window.__mirrorOrderMediaRoleUIInstalled = true;

  let active = false;
  let loading = false;
  let inventory = null;
  let roles = null;
  let query = '';
  let filter = 'all';

  const sourceRoleLabels = {
    sync_camera: '同步机位',
    aerial: '航拍',
    broll: '空镜',
    gopro: 'GoPro',
    insert: '细节',
    custom: '自定义',
  };

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function roleFor(item) {
    const local = asObject(item?.label);
    if (Object.keys(local).length) return local;
    return asObject(roles?.media?.[item?.media_id]);
  }

  function sourceRole(row) {
    return String(row?.source_role || 'sync_camera');
  }

  function isAuxiliary(row) {
    return sourceRole(row) !== 'sync_camera' || String(row?.sync_policy || 'auto') === 'exclude';
  }

  function effectiveCamera(item, row = roleFor(item)) {
    return String(row?.camera_override || item?.inferred_camera || '?');
  }

  function roleTitle(row) {
    const role = sourceRole(row);
    if (role === 'custom' && row?.role_label) return String(row.role_label);
    return sourceRoleLabels[role] || role;
  }

  function sceneIds() {
    return [...new Set(
      asArray(state.script?.segments)
        .map((segment) => String(segment?.scene_id || '').trim())
        .filter(Boolean),
    )].sort((a, b) => a.localeCompare(b, 'zh-CN', {numeric: true}));
  }

  function filteredItems() {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    return asArray(inventory?.items).filter((item) => {
      const row = roleFor(item);
      if (filter === 'auxiliary' && !isAuxiliary(row)) return false;
      if (filter === 'unindexed' && item.indexed) return false;
      if (filter === 'labeled' && !Object.keys(row).length) return false;
      if (!needle) return true;
      const haystack = [
        item.display_name,
        item.folder_label,
        item.inferred_camera,
        row.camera_override,
        roleTitle(row),
        row.scene_id,
        row.note,
      ].join(' ').toLocaleLowerCase('zh-CN');
      return haystack.includes(needle);
    });
  }

  function editorMarkup(item, row) {
    const role = sourceRole(row);
    const syncPolicy = String(row.sync_policy || (role === 'sync_camera' ? 'auto' : 'exclude'));
    const inferred = String(item.inferred_camera || '?');
    return `
      <div class="media-role-editor" data-media-role-editor="${esc(item.media_id)}">
        <label>
          <span>机位覆盖</span>
          <input data-field="camera_override" maxlength="40" value="${esc(row.camera_override || '')}" placeholder="默认 ${esc(inferred)}">
        </label>
        <label>
          <span>素材角色</span>
          <select data-field="source_role">
            ${Object.entries(sourceRoleLabels).map(([value, label]) => `<option value="${value}" ${role === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
        </label>
        <label>
          <span>同步</span>
          <select data-field="sync_policy">
            <option value="auto" ${syncPolicy === 'auto' ? 'selected' : ''}>参与同步</option>
            <option value="exclude" ${syncPolicy === 'exclude' ? 'selected' : ''}>不参与同步</option>
          </select>
        </label>
        <label>
          <span>场景归属</span>
          <input data-field="scene_id" list="media-role-scenes" maxlength="160" value="${esc(row.scene_id || '')}" placeholder="例如 24-3">
        </label>
        <label>
          <span>自定义标签</span>
          <input data-field="role_label" maxlength="80" value="${esc(row.role_label || '')}" placeholder="可留空">
        </label>
        <textarea data-field="note" maxlength="1200" placeholder="场记或剪辑用途，例如：饭店外景建立镜头，开场和转场可用">${esc(row.note || '')}</textarea>
        <div class="media-role-help">机位覆盖和素材角色是人工制作事实。航拍、空镜、GoPro 等可没有时间码或音频；标为“不参与同步”后，重新同步会按 media_id 排除，不会记成同步失败。</div>
        <button class="media-role-save" type="button" data-save-media-role="${esc(item.media_id)}">保存</button>
      </div>
    `;
  }

  function itemMarkup(item) {
    const row = roleFor(item);
    const auxiliary = isAuxiliary(row);
    const role = roleTitle(row);
    const camera = effectiveCamera(item, row);
    const detail = [
      row.scene_id ? `场景 ${row.scene_id}` : '',
      row.note ? String(row.note).replace(/\s+/g, ' ').slice(0, 70) : '',
    ].filter(Boolean).join(' · ');
    return `
      <details class="media-role-row" data-media-id="${esc(item.media_id)}">
        <summary>
          <span class="media-role-camera">${esc(camera)}</span>
          <span class="media-role-main">
            <strong>${esc(item.display_name || item.media_id)}</strong>
            <small>${esc(item.folder_label || '素材')}</small>
          </span>
          <span class="media-role-state">
            <strong>${esc(auxiliary ? role : (Object.keys(row).length ? role : '同步机位'))}</strong>
            <small>${esc(detail || (row.camera_override ? `人工机位 · 原识别 ${item.inferred_camera || '?'}` : ''))}</small>
          </span>
          <span class="media-role-index ${item.indexed ? '' : 'unindexed'}">${item.indexed ? '已入索引' : '未入索引'}</span>
          <span class="media-role-disclosure">›</span>
        </summary>
        ${editorMarkup(item, row)}
      </details>
    `;
  }

  function render() {
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    panel.hidden = false;
    if (loading && !inventory) {
      panel.innerHTML = '<div class="production-empty"><strong>正在读取素材清单</strong><span>扫描当前 Mac 已绑定素材目录，并以 media_id 对照项目索引。</span></div>';
      return;
    }
    if (!inventory) {
      panel.innerHTML = '<div class="production-empty"><strong>暂时无法读取素材角色</strong><span>其它制作与审阅功能不受影响。</span></div>';
      return;
    }
    const summary = asObject(inventory.summary);
    const items = filteredItems();
    const visible = items.slice(0, 500);
    const scenes = sceneIds();
    panel.innerHTML = `
      <div class="production-section-head">
        <div><strong>素材与机位</strong><span>按行业命名自动识别 A/B/C；这里可纠正机位，并管理航拍、空镜、GoPro 等不参与同步的辅助素材。</span></div>
        <span>${Number(summary.files || 0)} 素材 · ${Number(summary.auxiliary || 0)} 辅助</span>
      </div>
      <div class="production-status-strip">
        <span><strong>${Number(summary.indexed || 0)}</strong>已入索引</span>
        <span><strong>${Number(summary.unindexed || 0)}</strong>未入索引</span>
        <span><strong>${Number(summary.labeled || 0)}</strong>人工标记</span>
        <span><strong>${Number(summary.auxiliary || 0)}</strong>辅助素材</span>
      </div>
      <div class="media-role-toolbar">
        <input class="media-role-search" type="search" data-media-role-search value="${esc(query)}" placeholder="搜索文件、机位、场景或备注">
        <div class="media-role-filters">
          ${[['all', '全部'], ['auxiliary', '只看辅助'], ['unindexed', '未入索引'], ['labeled', '已标记']].map(([value, label]) => `<button type="button" data-media-role-filter="${value}" class="${filter === value ? 'active' : ''}">${label}</button>`).join('')}
        </div>
      </div>
      <datalist id="media-role-scenes">${scenes.map((sceneId) => `<option value="${esc(sceneId)}"></option>`).join('')}</datalist>
      <div class="media-role-list">
        ${visible.length ? visible.map(itemMarkup).join('') : '<div class="media-role-empty">当前筛选下没有素材。</div>'}
      </div>
      ${items.length > visible.length ? `<div class="production-note">当前显示前 ${visible.length} 条。继续缩小搜索范围以定位其它素材。</div>` : ''}
      <div class="production-note">这些标记不会写入 review.json / editorial.json，也不会直接修改 FCPXML。辅助素材只进入场景 Coverage 与粗剪素材池；创意 Best 仍由编辑决定。</div>
    `;
  }

  async function refresh(force = false) {
    if (!state.projectId || loading) return;
    if (!force && inventory && Number(inventory.role_revision || 0) === Number(roles?.revision || 0)) {
      render();
      return;
    }
    loading = true;
    render();
    const projectId = state.projectId;
    try {
      const [nextInventory, nextRoles] = await Promise.all([
        fetchJson(projectApi('/media-inventory')),
        fetchJson(projectApi('/media-roles')),
      ]);
      if (state.projectId !== projectId) return;
      inventory = nextInventory;
      roles = nextRoles;
    } catch (error) {
      if (force) {
        inventory = null;
        roles = null;
      }
      if (active) showToast(error.message || '素材角色读取失败');
    } finally {
      loading = false;
      render();
    }
  }

  function field(editor, name) {
    return editor.querySelector(`[data-field="${CSS.escape(name)}"]`);
  }

  async function saveMediaRole(mediaId, button) {
    const editor = button.closest('[data-media-role-editor]');
    if (!editor || !roles) return;
    if (!state.actor) {
      showToast('请先设置操作者昵称');
      $('#identity-dialog')?.showModal();
      return;
    }
    const item = asArray(inventory?.items).find((row) => row.media_id === mediaId);
    if (!item) return;
    button.disabled = true;
    const entry = {
      display_name: item.display_name || '',
      camera_override: field(editor, 'camera_override')?.value?.trim() || '',
      source_role: field(editor, 'source_role')?.value || 'sync_camera',
      role_label: field(editor, 'role_label')?.value?.trim() || '',
      sync_policy: field(editor, 'sync_policy')?.value || 'auto',
      scene_id: field(editor, 'scene_id')?.value?.trim() || '',
      note: field(editor, 'note')?.value?.trim() || '',
    };
    try {
      roles = await fetchJson(projectApi('/media-roles'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          expected_revision: Number(roles.revision || 0),
          actor: state.actor,
          changes: [{media_id: mediaId, entry}],
        }),
      });
      await refresh(true);
      showToast('素材标记已保存');
    } catch (error) {
      await refresh(true);
      showToast(`${error.message || '保存失败'} · 已刷新最新状态`);
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', (event) => {
    const mediaTab = event.target.closest('[data-production-tab="media"]');
    if (mediaTab) {
      active = true;
      requestAnimationFrame(render);
      refresh(true);
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab]:not([data-production-tab="media"]), [data-coverage-tab], [data-rough-cut-tab], [data-assembly-tab], [data-focus-group], [data-focus-segment], [data-focus-episode]')) {
      active = false;
      return;
    }
    const filterButton = event.target.closest('[data-media-role-filter]');
    if (filterButton && active) {
      event.preventDefault();
      filter = String(filterButton.dataset.mediaRoleFilter || 'all');
      render();
      return;
    }
    const save = event.target.closest('[data-save-media-role]');
    if (save && active) {
      event.preventDefault();
      saveMediaRole(String(save.dataset.saveMediaRole || ''), save);
    }
  }, true);

  document.addEventListener('input', (event) => {
    if (!active || !event.target.matches('[data-media-role-search]')) return;
    query = event.target.value || '';
    render();
    requestAnimationFrame(() => {
      const search = document.querySelector('[data-media-role-search]');
      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    });
  });

  document.addEventListener('change', (event) => {
    if (!active || !event.target.matches('[data-field="source_role"]')) return;
    const editor = event.target.closest('[data-media-role-editor]');
    const sync = editor?.querySelector('[data-field="sync_policy"]');
    if (!sync) return;
    sync.value = event.target.value === 'sync_camera' ? 'auto' : 'exclude';
  });

  const baseRenderContent = renderContent;
  renderContent = function mediaRoleRenderContent(...args) {
    const result = baseRenderContent(...args);
    if (active) requestAnimationFrame(render);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function mediaRoleSwitchProject(...args) {
    inventory = null;
    roles = null;
    query = '';
    filter = 'all';
    const result = await baseSwitchProject(...args);
    if (active) await refresh(true);
    return result;
  };
})();
