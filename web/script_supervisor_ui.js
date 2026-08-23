(() => {
  if (window.__mirrorOrderScriptSupervisorUIInstalled) return;
  window.__mirrorOrderScriptSupervisorUIInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  const SHOT_LABELS = {
    unknown: '未标记', wide: '全景', full: '全身', medium: '中景',
    medium_closeup: '中近景', closeup: '近景', extreme_closeup: '特写', insert: '细节',
  };
  const STATUS_LABELS = {
    unmarked: '未标记', usable: '可用', partial: '部分可用', ng: 'NG',
  };

  let active = false;
  let board = {revision: 0, entries: {}};
  let loading = false;
  let filterText = '';

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

  function currentTake(groupId) {
    return asArray(state.reviewModel?.take_groups).find((take) => take.group_id === groupId) || null;
  }

  function entryForGroup(groupId) {
    if (APP_CLIENT) return asObject(board.entries?.[groupId]);
    return asObject(currentTake(groupId)?.script_supervisor);
  }

  window.mirrorOrderScriptSupervisorEntry = entryForGroup;

  function groupTitle(group) {
    return asArray(group?.members)
      .slice()
      .sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
      .slice(0, 3)
      .map((member) => `${member.camera || '?'} · ${memberFileName(member)}`)
      .join(' / ') || group?.group_id || '未命名 Take';
  }

  function slateLabel(entry) {
    const parts = [];
    if (entry.scene) parts.push(`场 ${entry.scene}`);
    if (entry.shot) parts.push(`镜 ${entry.shot}`);
    if (entry.take_number) parts.push(`T${entry.take_number}`);
    return parts.join(' · ') || '未填场记';
  }

  function statusClass(status) {
    return ['usable', 'partial', 'ng'].includes(status) ? status : '';
  }

  function annotationChip(groupId) {
    const entry = entryForGroup(groupId);
    if (!Object.keys(entry).length) return '';
    const status = String(entry.status || 'unmarked');
    const label = slateLabel(entry);
    const statusText = status !== 'unmarked' ? ` · ${STATUS_LABELS[status] || status}` : '';
    return `<span class="supervisor-chip ${esc(statusClass(status))}" title="人工场记标注">场记 · ${esc(label)}${esc(statusText)}</span>`;
  }

  const baseRenderMemberStrip = renderMemberStrip;
  renderMemberStrip = function supervisorRenderMemberStrip(group) {
    const html = baseRenderMemberStrip(group);
    const entry = entryForGroup(group?.group_id);
    const angles = asObject(entry.angles);
    if (!Object.keys(angles).length) return html;
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('[data-member-clip]').forEach((card) => {
      const manual = asObject(angles[card.dataset.memberClip]);
      const shot = String(manual.shot_type || 'unknown');
      if (shot === 'unknown' || !SHOT_LABELS[shot]) return;
      const bottom = card.querySelector('.member-bottom');
      if (!bottom) return;
      let chip = bottom.querySelector('.shot-chip');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'shot-chip';
        const time = bottom.querySelector('.member-time');
        if (time) bottom.insertBefore(chip, time);
        else bottom.appendChild(chip);
      }
      chip.classList.add('supervisor-shot');
      chip.textContent = SHOT_LABELS[shot];
      chip.title = `人工场记景别：${SHOT_LABELS[shot]}${manual.note ? ` · ${manual.note}` : ''}`;
    });
    return container.innerHTML;
  };

  const baseRenderTakeRow = renderTakeRow;
  renderTakeRow = function supervisorRenderTakeRow(group, candidate, segmentId, contextOnly = false) {
    const html = baseRenderTakeRow(group, candidate, segmentId, contextOnly);
    const entry = entryForGroup(group?.group_id);
    if (!Object.keys(entry).length) return html;
    const container = document.createElement('div');
    container.innerHTML = html;
    const row = container.firstElementChild;
    if (!row) return html;
    const top = row.querySelector('.take-info-top');
    if (top) top.insertAdjacentHTML('beforeend', annotationChip(group.group_id));
    const detail = row.querySelector('.take-details-body');
    if (detail && entry.note) {
      detail.insertAdjacentHTML(
        'beforeend',
        `<div class="supervisor-review-note"><strong>场记备注</strong><br>${esc(entry.note)}</div>`,
      );
    }
    return row.outerHTML;
  };

  if (!APP_CLIENT) return;

  function ensureTab() {
    const tabs = document.querySelector('#production-bar .production-tabs');
    if (!tabs) return null;
    let button = document.querySelector('#production-supervisor-tab');
    if (button) return button;
    button = document.createElement('button');
    button.id = 'production-supervisor-tab';
    button.type = 'button';
    button.dataset.productionTab = 'supervisor';
    button.innerHTML = '场记 <span id="production-supervisor-count"></span>';
    const coverage = tabs.querySelector('#production-coverage-tab');
    const rough = tabs.querySelector('#production-rough-cut-tab');
    const people = tabs.querySelector('[data-production-tab="people"]');
    tabs.insertBefore(button, coverage || rough || people || null);
    return button;
  }

  function setActive(value) {
    active = Boolean(value);
    const button = ensureTab();
    if (button) button.classList.toggle('active', active);
    if (active) {
      document.querySelectorAll('#production-bar [data-production-tab], #production-coverage-tab, #production-rough-cut-tab, #production-assembly-tab')
        .forEach((item) => item !== button && item.classList.remove('active'));
    }
  }

  function aiAngleFor(groupId, clipId) {
    const angle = asArray(currentTake(groupId)?.angles).find((item) => item.clip_id === clipId);
    return angle || {};
  }

  function options(values, current) {
    return values.map(([value, label]) => `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }

  function renderAngleFields(group, entry) {
    const manualAngles = asObject(entry.angles);
    return asArray(group.members)
      .slice()
      .sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
      .map((member) => {
        const manual = asObject(manualAngles[member.clip_id]);
        const ai = aiAngleFor(group.group_id, member.clip_id);
        const aiShot = String(ai.shot_type || 'unknown');
        const aiText = aiShot !== 'unknown' ? ` · AI ${SHOT_LABELS[aiShot] || aiShot}` : '';
        return `
          <div class="supervisor-angle-row" data-supervisor-angle="${esc(member.clip_id)}">
            <strong>${esc(member.camera || '?')} · ${esc(memberFileName(member))}${esc(aiText)}</strong>
            <select data-angle-shot>
              ${options(Object.entries(SHOT_LABELS), manual.shot_type || 'unknown')}
            </select>
            <input data-angle-note maxlength="500" placeholder="机位备注（可选）" value="${esc(manual.note || '')}">
          </div>
        `;
      }).join('');
  }

  function renderForm(group, entry) {
    const usable = asObject(entry.usable_range);
    const preferredOptions = [
      ['', '不指定优先机位'],
      ...asArray(group.members)
        .slice()
        .sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
        .map((member) => [member.clip_id, `${member.camera || '?'} · ${memberFileName(member)}`]),
    ];
    return `
      <form class="supervisor-form" data-supervisor-form="${esc(group.group_id)}">
        <div class="supervisor-grid">
          <label class="supervisor-field"><span>场次</span><input name="scene" maxlength="80" placeholder="如 12A" value="${esc(entry.scene || '')}"></label>
          <label class="supervisor-field"><span>镜号</span><input name="shot" maxlength="80" placeholder="如 3 / 3B" value="${esc(entry.shot || '')}"></label>
          <label class="supervisor-field"><span>拍摄次数</span><input name="take_number" type="number" min="1" step="1" value="${entry.take_number || ''}"></label>
          <label class="supervisor-field"><span>现场可用性</span><select name="status">${options(Object.entries(STATUS_LABELS), entry.status || 'unmarked')}</select></label>
          <label class="supervisor-field"><span>优先机位（组接提示）</span><select name="preferred_clip_id">${options(preferredOptions, entry.preferred_clip_id || '')}</select></label>
          <label class="supervisor-field"><span>可用范围 · 相对 Take 秒数</span><span class="supervisor-range"><input name="range_start" type="number" min="0" step="0.1" placeholder="开始" value="${usable.start ?? ''}"><input name="range_end" type="number" min="0" step="0.1" placeholder="结束" value="${usable.end ?? ''}"></span></label>
          <label class="supervisor-field note"><span>备注 · 给剪辑、团队与镜序助理看</span><textarea name="note" maxlength="2000" placeholder="例如：只要前半段；后半段穿帮；这一条是保底；演员最后一句最好。">${esc(entry.note || '')}</textarea></label>
        </div>
        <div class="supervisor-angles">
          <span class="supervisor-angle-head">各机位景别 · 人工标注会覆盖 AI 景别</span>
          ${renderAngleFields(group, entry)}
        </div>
        <div class="supervisor-form-actions">
          <button class="clear" type="button" data-supervisor-clear="${esc(group.group_id)}">清除场记</button>
          <button class="primary" type="submit">保存场记</button>
        </div>
      </form>
    `;
  }

  function renderRow(group) {
    const entry = asObject(board.entries?.[group.group_id]);
    const status = String(entry.status || 'unmarked');
    const note = String(entry.note || '').trim();
    const range = asObject(entry.usable_range);
    const secondary = [
      note ? note.replace(/\s+/g, ' ').slice(0, 90) : '',
      range.end != null ? `可用 ${range.start || 0}–${range.end}s` : '',
    ].filter(Boolean).join(' · ') || '看片后补充场次、镜号、拍摄次数、景别和备注';
    return `
      <details class="supervisor-row" data-supervisor-row="${esc(group.group_id)}">
        <summary>
          <span class="supervisor-slate">${esc(slateLabel(entry))}</span>
          <span class="supervisor-main"><strong>${esc(groupTitle(group))}</strong><small>${esc(secondary)}</small></span>
          <span class="supervisor-state ${esc(statusClass(status))}">${esc(STATUS_LABELS[status] || status)}</span>
          <span class="supervisor-disclosure">›</span>
        </summary>
        ${renderForm(group, entry)}
      </details>
    `;
  }

  function visibleGroups() {
    const needle = filterText.trim().toLowerCase();
    return asArray(state.groups)
      .slice()
      .sort((a, b) => Number(a.start || 0) - Number(b.start || 0))
      .filter((group) => {
        if (!needle) return true;
        const entry = asObject(board.entries?.[group.group_id]);
        return [groupTitle(group), group.group_id, slateLabel(entry), entry.note || '']
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
  }

  function renderBoard() {
    ensureTab();
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    panel.hidden = false;
    if (loading && !Object.keys(board.entries || {}).length) {
      panel.innerHTML = '<div class="production-empty"><strong>正在读取场记看板</strong><span>场记属于共享人工生产事实，不会覆盖最终编辑决定。</span></div>';
      return;
    }
    const groups = visibleGroups();
    const annotated = Object.keys(board.entries || {}).length;
    const count = document.querySelector('#production-supervisor-count');
    if (count) count.textContent = annotated ? String(annotated) : '';
    panel.innerHTML = `
      <div class="production-section-head">
        <div><strong>场记看板</strong><span>看片后人工补充拍摄事实；备注同时提供给团队和镜序助理，用于 Coverage、粗剪和组接准备。</span></div>
        <span>${annotated} 条已标注 · rev ${Number(board.revision || 0)}</span>
      </div>
      <div class="supervisor-toolbar">
        <input id="supervisor-search" type="search" placeholder="搜索场次、镜号、素材或备注" value="${esc(filterText)}">
        <span>NG/部分可用是生产约束，不会自动写成 Reject/Best</span>
      </div>
      <div class="supervisor-list">${groups.map(renderRow).join('') || '<div class="production-empty"><strong>没有匹配的 Take</strong></div>'}</div>
    `;
    document.querySelector('#supervisor-search')?.addEventListener('input', (event) => {
      filterText = event.target.value;
      renderBoard();
      requestAnimationFrame(() => document.querySelector('#supervisor-search')?.focus());
    });
  }

  function formEntry(form) {
    const data = new FormData(form);
    const startRaw = String(data.get('range_start') || '').trim();
    const endRaw = String(data.get('range_end') || '').trim();
    const usableRange = startRaw || endRaw ? {
      start: startRaw ? Number(startRaw) : 0,
      end: endRaw ? Number(endRaw) : null,
    } : {};
    const angles = {};
    form.querySelectorAll('[data-supervisor-angle]').forEach((row) => {
      const shotType = row.querySelector('[data-angle-shot]')?.value || 'unknown';
      const note = row.querySelector('[data-angle-note]')?.value?.trim() || '';
      if (shotType !== 'unknown' || note) angles[row.dataset.supervisorAngle] = {shot_type: shotType, note};
    });
    return {
      scene: String(data.get('scene') || '').trim(),
      shot: String(data.get('shot') || '').trim(),
      take_number: String(data.get('take_number') || '').trim() || null,
      status: String(data.get('status') || 'unmarked'),
      note: String(data.get('note') || '').trim(),
      preferred_clip_id: String(data.get('preferred_clip_id') || ''),
      usable_range: usableRange,
      angles,
    };
  }

  async function saveForm(form) {
    const groupId = form.dataset.supervisorForm;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      board = await fetchJson(projectApi('/script-supervisor'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          group_id: groupId,
          expected_revision: Number(board.revision || 0),
          actor: state.actor || '本机剪辑',
          entry: formEntry(form),
        }),
      });
      showToast('场记已保存');
      renderContent();
      renderBoard();
    } catch (error) {
      showToast(error.message || '场记保存失败');
      if (/revision/i.test(error.message || '')) await refreshBoard(true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function clearEntry(groupId) {
    try {
      board = await fetchJson(projectApi('/script-supervisor'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          group_id: groupId,
          expected_revision: Number(board.revision || 0),
          actor: state.actor || '本机剪辑',
          entry: {},
        }),
      });
      showToast('场记已清除');
      renderContent();
      renderBoard();
    } catch (error) {
      showToast(error.message || '清除场记失败');
      if (/revision/i.test(error.message || '')) await refreshBoard(true);
    }
  }

  async function refreshBoard(force = false) {
    if (!state.projectId || loading) return;
    loading = true;
    renderBoard();
    const projectId = state.projectId;
    try {
      const next = await fetchJson(projectApi('/script-supervisor'));
      if (state.projectId !== projectId) return;
      board = next;
      state.scriptSupervisorRevision = Number(next.revision || 0);
    } catch (error) {
      if (force) board = {revision: 0, entries: {}};
      if (active) showToast(error.message || '场记看板读取失败');
    } finally {
      loading = false;
      renderBoard();
    }
  }

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-supervisor-form]');
    if (!form) return;
    event.preventDefault();
    saveForm(form);
  }, true);

  document.addEventListener('click', (event) => {
    const supervisorTab = event.target.closest('#production-supervisor-tab');
    if (supervisorTab) {
      event.preventDefault();
      setActive(true);
      renderBoard();
      refreshBoard(true);
      return;
    }
    const clear = event.target.closest('[data-supervisor-clear]');
    if (clear) {
      event.preventDefault();
      clearEntry(clear.dataset.supervisorClear);
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab]:not(#production-supervisor-tab), [data-coverage-tab], [data-rough-cut-tab], [data-assembly-tab], [data-focus-group]')) {
      setActive(false);
    }
  }, true);

  const baseRenderContent = renderContent;
  renderContent = function supervisorRenderContent(...args) {
    const result = baseRenderContent(...args);
    requestAnimationFrame(renderBoard);
    return result;
  };

  const baseSwitchProject = switchProject;
  switchProject = async function supervisorSwitchProject(...args) {
    board = {revision: 0, entries: {}};
    const result = await baseSwitchProject(...args);
    await refreshBoard(false);
    return result;
  };

  const basePollState = pollState;
  pollState = async function supervisorPollState() {
    const result = await basePollState();
    if (!state.projectId) return result;
    try {
      const next = await fetchJson(projectApi('/state'));
      const revision = Number(next.script_supervisor_revision || 0);
      if (revision !== Number(state.scriptSupervisorRevision || 0)) await refreshBoard(false);
    } catch (_error) {}
    return result;
  };

  requestAnimationFrame(() => {
    ensureTab();
    refreshBoard(false);
  });
})();
