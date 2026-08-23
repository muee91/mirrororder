(() => {
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderAssemblyUIInstalled) return;
  window.__mirrorOrderAssemblyUIInstalled = true;

  let active = false;
  let payload = null;
  let loading = false;
  let sourceRevision = '';

  const SHOT_LABELS = {
    wide: '全景', full: '全身', medium: '中景', medium_closeup: '中近景',
    closeup: '近景', extreme_closeup: '特写', insert: '细节', unknown: '景别未知',
  };
  const STATUS_LABELS = {
    ready: '可组接', needs_review: '待核对', blocked: '阻塞', selection_pending: '待选择',
  };
  const SELECTION_LABELS = {
    needs_editorial_choice: '尚未确定 Best',
    conflict_multiple_best: '多个 Best 冲突',
    conflict_supervisor_vs_best: 'Best 与场记 NG 冲突',
    no_eligible_take: '没有可用 Take',
  };

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

  function ensureTab() {
    const tabs = document.querySelector('#production-bar .production-tabs');
    if (!tabs) return null;
    let button = document.querySelector('#production-assembly-tab');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'production-assembly-tab';
    button.type = 'button';
    button.dataset.productionTab = 'assembly';
    button.innerHTML = '组接 <span id="production-assembly-count"></span>';
    const people = tabs.querySelector('[data-production-tab="people"]');
    tabs.insertBefore(button, people || null);
    return button;
  }

  function setActive(value) {
    active = Boolean(value);
    const button = ensureTab();
    if (button) button.classList.toggle('active', active);
    if (active) {
      document.querySelectorAll('#production-bar [data-production-tab], #production-coverage-tab, #production-rough-cut-tab')
        .forEach((item) => item !== button && item.classList.remove('active'));
    }
  }

  function angleText(angle) {
    const row = asObject(angle);
    const status = String(row.status || 'missing');
    if (status === 'pending') return `机位待定 · ${asArray(row.candidates).length} 个可选`;
    if (status === 'missing') return '没有可解析机位';
    const shot = SHOT_LABELS[String(row.shot_type || 'unknown')] || '景别未知';
    const source = status === 'manual_preferred' ? '人工优先' : '单机位';
    return `${row.camera || '?'}机 · ${shot} · ${source}`;
  }

  function rangeText(range) {
    const row = asObject(range);
    if (!Object.keys(row).length) return '';
    const start = Number(row.start || 0);
    const end = Number(row.end || 0);
    const prefix = row.status === 'manual' ? '人工范围' : row.status === 'pending' ? '范围待确认' : '完整 Take';
    return `${prefix} ${start.toFixed(1)}–${end.toFixed(1)}s`;
  }

  function blockWidth(block) {
    if (block.kind !== 'source') return 150;
    const duration = Number(block.duration || asObject(block.usable_range).duration || 0);
    return Math.max(125, Math.min(330, 105 + duration * 5));
  }

  function blockIssues(block) {
    return asArray(block.issues)
      .filter((item) => item?.label)
      .slice(0, 3)
      .map((item) => item.label)
      .join('；');
  }

  function renderBlock(block) {
    const status = String(block.assembly_status || (block.kind === 'source' ? 'needs_review' : 'selection_pending'));
    const width = blockWidth(block);
    if (block.kind !== 'source') {
      const selection = String(block.selection_status || 'needs_editorial_choice');
      return `
        <button class="assembly-block selection_pending" type="button" style="width:${width}px" title="${esc(blockIssues(block))}">
          <strong>${esc(SELECTION_LABELS[selection] || '待编辑判断')}</strong>
          <small>${asArray(block.script_segment_ids).map((id) => esc(id)).join(' · ')}</small>
          <em>${esc(STATUS_LABELS.selection_pending)}</em>
        </button>
      `;
    }
    const groupId = String(block.group_id || '');
    const supervisor = asObject(block.script_supervisor);
    const note = String(supervisor.note || '').trim();
    const title = [angleText(block.angle), rangeText(block.usable_range), note].filter(Boolean).join(' · ');
    return `
      <button class="assembly-block ${esc(status)}" type="button" data-focus-group="${esc(groupId)}" style="width:${width}px" title="${esc(title)}">
        <strong>${esc(groupId)} · ${esc(angleText(block.angle))}</strong>
        <small>${esc(rangeText(block.usable_range))}${note ? ` · 场记：${esc(note.slice(0, 70))}` : ''}</small>
        <em>${esc(STATUS_LABELS[status] || status)} · ${Number(block.duration || 0).toFixed(1)}s</em>
      </button>
    `;
  }

  function renderScene(scene) {
    const summary = asObject(scene.summary);
    const readiness = String(scene.readiness || 'needs_review');
    const issues = asArray(scene.blocks)
      .flatMap((block) => asArray(block.issues))
      .filter((item, index, rows) => item?.label && rows.findIndex((row) => row?.code === item.code && row?.label === item.label) === index)
      .slice(0, 6);
    return `
      <details class="assembly-scene" ${readiness !== 'ready' ? 'open' : ''}>
        <summary>
          <span class="assembly-scene-episode">EP${esc(scene.episode || '—')}</span>
          <span class="assembly-scene-main">
            <strong>${esc(scene.heading || scene.scene_id || '未命名场景')}</strong>
            <small>${Number(summary.source_blocks || 0)} 个素材块 · ${Number(summary.unresolved_blocks || 0)} 个待选择 · 预览 ${Number(scene.duration || 0).toFixed(1)}s</small>
          </span>
          <span class="assembly-scene-state ${esc(readiness)}">${esc(STATUS_LABELS[readiness] || readiness)}</span>
          <span class="assembly-disclosure">›</span>
        </summary>
        <div class="assembly-body">
          <div class="assembly-track">${asArray(scene.blocks).map(renderBlock).join('') || '<div class="assembly-empty">当前场景没有可预览组接块。</div>'}</div>
          ${issues.length ? `<div class="assembly-issues">${issues.map((issue) => `<div class="assembly-issue ${esc(issue.severity || '')}">${esc(issue.label)}</div>`).join('')}</div>` : ''}
        </div>
      </details>
    `;
  }

  function renderAssembly() {
    ensureTab();
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    panel.hidden = false;
    if (loading && !payload) {
      panel.innerHTML = '<div class="production-empty"><strong>正在生成组接预览</strong><span>只使用显式 Best 和人工场记约束，不会自动挑 Take 或机位。</span></div>';
      return;
    }
    if (!payload) {
      panel.innerHTML = '<div class="production-empty"><strong>暂时无法读取组接预览</strong><span>粗剪规划与审阅功能不受影响。</span></div>';
      return;
    }
    const summary = asObject(payload.summary);
    const statuses = asObject(summary.statuses);
    const attention = Number(statuses.needs_review || 0) + Number(statuses.selection_pending || 0) + Number(statuses.blocked || 0);
    const count = document.querySelector('#production-assembly-count');
    if (count) count.textContent = attention ? String(attention) : '';
    const readiness = String(payload.readiness || 'needs_review');
    panel.innerHTML = `
      <div class="production-section-head">
        <div><strong>组接预览</strong><span>把连续使用同一 Take 的剧本段合成一个素材块；场记可用范围会裁切预览，多机位未指定时保持“机位待定”。</span></div>
        <span>${Number(summary.blocks || 0)} 块 · ${Number(payload.duration || 0).toFixed(1)}s · ${esc(STATUS_LABELS[readiness] || readiness)}</span>
      </div>
      <div class="production-status-strip">
        <span><strong>${Number(statuses.ready || 0)}</strong>可组接</span>
        <span><strong>${Number(statuses.needs_review || 0)}</strong>待核对</span>
        <span><strong>${Number(statuses.selection_pending || 0)}</strong>待选择</span>
        <span><strong>${Number(statuses.blocked || 0)}</strong>阻塞</span>
      </div>
      <div class="assembly-list">${asArray(payload.scenes).map(renderScene).join('') || '<div class="assembly-empty">当前范围没有组接内容。</div>'}</div>
      <div class="production-note">这是独立 edit model 预览，不写 Selection Manifest、不生成或修改 FCPXML，也不会覆盖原始媒体。正式 NLE Adapter 仍需后续真机验收。</div>
    `;
  }

  async function refreshAssembly(force = false) {
    if (!state.projectId || loading) return;
    loading = true;
    renderAssembly();
    const projectId = state.projectId;
    try {
      const next = await fetchJson(projectApi('/assembly-timeline'));
      if (state.projectId !== projectId) return;
      payload = next;
      sourceRevision = String(next.coverage_revision || '');
    } catch (error) {
      if (force) payload = null;
      if (active) showToast(error.message || '组接预览读取失败');
    } finally {
      loading = false;
      renderAssembly();
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('#production-assembly-tab')) {
      event.preventDefault();
      setActive(true);
      renderAssembly();
      refreshAssembly(true);
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab]:not(#production-assembly-tab), [data-coverage-tab], [data-rough-cut-tab], [data-focus-group]')) {
      setActive(false);
    }
  }, true);

  const baseRenderContent = renderContent;
  renderContent = function assemblyRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderAssembly);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function assemblySwitchProject(...args) {
    payload = null;
    sourceRevision = '';
    const result = await baseSwitchProject(...args);
    if (active) await refreshAssembly(true);
    return result;
  };

  const basePollState = pollState;
  pollState = async function assemblyPollState() {
    const result = await basePollState();
    if (!active || !state.projectId) return result;
    try {
      const next = await fetchJson(projectApi('/state'));
      const revision = String(next.assembly_source_revision || next.coverage_revision || '');
      if (revision && revision !== sourceRevision) await refreshAssembly(true);
    } catch (_error) {}
    return result;
  };

  requestAnimationFrame(ensureTab);
})();
