(() => {
  if (window.__mirrorOrderScriptSupervisorUIInstalled) return;
  window.__mirrorOrderScriptSupervisorUIInstalled = true;

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  const SHOT_LABELS = {
    unknown: '—', wide: '全景', full: '全身', medium: '中景',
    medium_closeup: '中近景', closeup: '近景', extreme_closeup: '特写', big_closeup: '大特写', insert: '细节',
  };
  const STATUS_LABELS = {unmarked: '未标记', usable: '可用', partial: '部分可用', ng: 'NG'};
  const ROLE_LABELS = {sync_camera: '同步机位', aerial: '航拍', broll: '空镜', gopro: 'GoPro', insert: '细节', custom: '其它'};

  let board = {version: 2, contract: 'script_supervisor.v2', revision: 0, records: {}, entries: {}};
  let inventory = {items: []};
  let active = false;
  let selectedRecordId = '';
  let intakeQuery = '';
  let tableQuery = '';
  let preview = {recordId: '', clipId: '', mediaId: '', name: ''};
  let saveQueue = Promise.resolve();
  let recognition = null;

  const asArray = (value) => Array.isArray(value) ? value : [];
  const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const records = () => Object.values(asObject(board.records)).filter((row) => row && typeof row === 'object');
  const recordById = (id) => asObject(board.records?.[id]);
  const groupById = (id) => state.groupMap?.get(id) || asArray(state.groups).find((row) => row.group_id === id) || null;

  function actor() {
    const value = String(state.actor || '').trim();
    if (value) return value;
    document.querySelector('#actor-button')?.click();
    throw new Error('请先设置操作者昵称');
  }

  function attachmentKey(row) {
    return `${row.clip_id || ''}|${row.media_id || ''}`;
  }

  function safeName(value) {
    return String(value || '').replaceAll('\\', '/').split('/').pop() || '';
  }

  function sourceRoleForMember(member) {
    const role = asObject(member?.media_role);
    return String(role.source_role || 'sync_camera');
  }

  function attachmentFromMember(member) {
    return {
      clip_id: String(member?.clip_id || ''),
      media_id: String(member?.media_id || ''),
      camera: String(member?.camera || ''),
      display_name: safeName(memberFileName(member) || member?.name || ''),
      shot_type: 'unknown',
      source_role: sourceRoleForMember(member),
      note: '',
    };
  }

  function attachmentFromInventory(row) {
    const label = asObject(row?.label);
    return {
      clip_id: '',
      media_id: String(row?.media_id || ''),
      camera: String(label.camera_override || row?.inferred_camera || ''),
      display_name: safeName(row?.display_name || ''),
      shot_type: 'unknown',
      source_role: String(label.source_role || 'sync_camera'),
      note: '',
    };
  }

  function recordForGroup(groupId) {
    return records()
      .filter((row) => String(row.source_group_id || '') === String(groupId || ''))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
  }

  function entryForGroup(groupId) {
    if (APP_CLIENT) return asObject(board.entries?.[groupId]);
    const take = asArray(state.reviewModel?.take_groups).find((row) => row.group_id === groupId);
    return asObject(take?.script_supervisor);
  }
  window.mirrorOrderScriptSupervisorEntry = entryForGroup;

  // Team Web only consumes compact human slate annotations beside existing Take cards.
  const baseRenderMemberStrip = renderMemberStrip;
  renderMemberStrip = function supervisorMemberStrip(group) {
    const html = baseRenderMemberStrip(group);
    const entry = entryForGroup(group?.group_id);
    const angles = asObject(entry.angles);
    if (!Object.keys(angles).length) return html;
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('[data-member-clip]').forEach((card) => {
      const manual = asObject(angles[card.dataset.memberClip]);
      const shot = String(manual.shot_type || 'unknown');
      if (shot === 'unknown') return;
      const bottom = card.querySelector('.member-bottom');
      if (!bottom) return;
      let chip = bottom.querySelector('.shot-chip');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'shot-chip';
        bottom.prepend(chip);
      }
      chip.classList.add('supervisor-shot');
      chip.textContent = SHOT_LABELS[shot] || shot;
      chip.title = `人工场记景别：${SHOT_LABELS[shot] || shot}`;
    });
    return container.innerHTML;
  };

  const baseRenderTakeRow = renderTakeRow;
  renderTakeRow = function supervisorTakeRow(group, candidate, segmentId, contextOnly = false) {
    const html = baseRenderTakeRow(group, candidate, segmentId, contextOnly);
    const entry = entryForGroup(group?.group_id);
    if (!Object.keys(entry).length) return html;
    const container = document.createElement('div');
    container.innerHTML = html;
    const row = container.firstElementChild;
    if (!row) return html;
    const parts = [];
    if (entry.scene) parts.push(`场${entry.scene}`);
    if (entry.shot) parts.push(`镜${entry.shot}`);
    if (entry.take_number) parts.push(`T${entry.take_number}`);
    const status = String(entry.status || 'unmarked');
    const label = parts.join(' · ') || '场记';
    row.querySelector('.take-info-top')?.insertAdjacentHTML(
      'beforeend',
      `<span class="supervisor-chip ${esc(status)}">${esc(label)}${status !== 'unmarked' ? ` · ${esc(STATUS_LABELS[status] || status)}` : ''}</span>`,
    );
    if (entry.note) row.querySelector('.take-details-body')?.insertAdjacentHTML(
      'beforeend', `<div class="supervisor-review-note"><strong>场记备注</strong><br>${esc(entry.note)}</div>`,
    );
    return row.outerHTML;
  };

  if (!APP_CLIENT) return;

  function newRecordId() {
    if (crypto?.randomUUID) return `slate-${crypto.randomUUID().replaceAll('-', '')}`;
    return `slate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function blankRecord() {
    return {
      record_id: newRecordId(), source_group_id: '', episode: null, scene: '', shot: '', take_number: null,
      status: 'unmarked', note: '', usable_range: {}, preferred_clip_id: '', attachments: [], actor: '', updated_at: '',
    };
  }

  function recordFromGroup(group) {
    const existing = recordForGroup(group.group_id);
    if (existing) return existing;
    const row = blankRecord();
    row.source_group_id = group.group_id;
    row.attachments = asArray(group.members)
      .slice()
      .sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
      .map(attachmentFromMember);
    const placement = placementForGroup(group)?.entry;
    const episodeIds = asArray(placement?.episode_ids);
    if (episodeIds.length === 1) row.episode = Number(episodeIds[0]) || null;
    return row;
  }

  function installLocalRecord(row) {
    board.records ||= {};
    board.records[row.record_id] = structuredClone(row);
    selectedRecordId = row.record_id;
  }

  function dirtyRecordFromDOM(recordId) {
    const row = document.querySelector(`[data-slate-row="${CSS.escape(recordId)}"]`);
    const current = structuredClone(recordById(recordId));
    if (!row || !Object.keys(current).length) return current;
    const value = (name) => row.querySelector(`[data-field="${name}"]`)?.value ?? '';
    current.episode = value('episode').trim() ? Number(value('episode')) : null;
    current.scene = value('scene').trim();
    current.shot = value('shot').trim();
    current.take_number = value('take_number').trim() ? Number(value('take_number')) : null;
    current.status = value('status') || 'unmarked';
    current.note = value('note').trim();
    const start = value('range_start').trim();
    const end = value('range_end').trim();
    current.usable_range = start || end ? {start: start ? Number(start) : 0, end: end ? Number(end) : null} : {};
    current.attachments = asArray(current.attachments).map((attachment) => {
      const key = CSS.escape(attachmentKey(attachment));
      const card = row.querySelector(`[data-attachment-key="${key}"]`);
      if (!card) return attachment;
      return {
        ...attachment,
        shot_type: card.querySelector('[data-attachment-shot]')?.value || 'unknown',
        note: card.querySelector('[data-attachment-note]')?.value?.trim() || '',
      };
    });
    return current;
  }

  async function postRecord(record, deleteRecord = false) {
    const body = {
      action: deleteRecord ? 'delete_record' : 'upsert_record',
      record_id: record.record_id,
      expected_revision: Number(board.revision || 0),
      actor: actor(),
      record,
    };
    const next = await fetchJson(projectApi('/script-supervisor'), {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    board = next;
    state.scriptSupervisorRevision = Number(next.revision || 0);
    return next;
  }

  function queueSave(recordId) {
    saveQueue = saveQueue.then(async () => {
      const record = dirtyRecordFromDOM(recordId);
      if (!record?.record_id) return;
      try {
        await postRecord(record, false);
        const row = document.querySelector(`[data-slate-row="${CSS.escape(recordId)}"]`);
        row?.classList.remove('dirty');
        row?.classList.add('saved');
        setTimeout(() => row?.classList.remove('saved'), 700);
        updateCounts();
      } catch (error) {
        showToast(error.message || '场记保存失败');
        if (/revision/i.test(error.message || '')) await refreshBoard(false);
      }
    });
    return saveQueue;
  }

  function attachmentCard(record, attachment) {
    const camera = String(attachment.camera || '—');
    const role = String(attachment.source_role || 'sync_camera');
    const canPlay = Boolean(attachment.clip_id);
    return `
      <div class="slate-media-card${canPlay ? ' playable' : ''}" data-attachment-key="${esc(attachmentKey(attachment))}">
        <button class="slate-media-preview" type="button" data-preview-record="${esc(record.record_id)}" data-preview-clip="${esc(attachment.clip_id || '')}" data-preview-media="${esc(attachment.media_id || '')}" ${canPlay ? '' : 'disabled'}>
          <span class="slate-camera">${esc(camera)}</span><span class="slate-play">▶</span>
        </button>
        <div class="slate-media-meta"><strong title="${esc(attachment.display_name || '')}">${esc(attachment.display_name || attachment.media_id || '素材')}</strong><small>${esc(ROLE_LABELS[role] || role)}</small></div>
        <select data-attachment-shot title="人工景别">${Object.entries(SHOT_LABELS).map(([value, label]) => `<option value="${esc(value)}"${value === (attachment.shot_type || 'unknown') ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <input data-attachment-note value="${esc(attachment.note || '')}" placeholder="机位备注">
        <button class="slate-media-remove" type="button" data-detach-record="${esc(record.record_id)}" data-detach-key="${esc(attachmentKey(attachment))}" title="从这条场记移除">×</button>
      </div>`;
  }

  function recordRow(record) {
    const usable = asObject(record.usable_range);
    return `
      <tr class="slate-row${record.record_id === selectedRecordId ? ' selected' : ''}" data-slate-row="${esc(record.record_id)}">
        <td class="slate-material-cell"><div class="slate-material-stack">${asArray(record.attachments).map((item) => attachmentCard(record, item)).join('') || '<button class="slate-drop-empty" type="button" data-select-record="' + esc(record.record_id) + '">拖入素材或从左侧添加</button>'}</div></td>
        <td><input class="slate-cell narrow" data-field="episode" inputmode="numeric" value="${record.episode ?? ''}" placeholder="集"></td>
        <td><input class="slate-cell" data-field="scene" value="${esc(record.scene || '')}" placeholder="场"></td>
        <td><input class="slate-cell" data-field="shot" value="${esc(record.shot || '')}" placeholder="镜"></td>
        <td><input class="slate-cell narrow" data-field="take_number" inputmode="numeric" value="${record.take_number ?? ''}" placeholder="次"></td>
        <td><select class="slate-cell" data-field="status">${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}"${value === (record.status || 'unmarked') ? ' selected' : ''}>${label}</option>`).join('')}</select></td>
        <td class="slate-range-cell"><input class="slate-cell range" data-field="range_start" type="number" min="0" step="0.1" value="${usable.start ?? ''}" placeholder="入"><span>–</span><input class="slate-cell range" data-field="range_end" type="number" min="0" step="0.1" value="${usable.end ?? ''}" placeholder="出"></td>
        <td><textarea class="slate-note" data-field="note" rows="2" placeholder="给剪辑、团队和小镜看的现场备注">${esc(record.note || '')}</textarea></td>
        <td class="slate-row-actions"><button type="button" data-select-record="${esc(record.record_id)}">选中</button><button type="button" data-delete-record="${esc(record.record_id)}">删除</button></td>
      </tr>`;
  }

  function filteredRecords() {
    const needle = tableQuery.trim().toLowerCase();
    return records().slice().sort((a, b) => {
      const ae = Number(a.episode || 0), be = Number(b.episode || 0);
      if (ae !== be) return ae - be;
      const scene = String(a.scene || '').localeCompare(String(b.scene || ''), 'zh-CN', {numeric: true});
      if (scene) return scene;
      const shot = String(a.shot || '').localeCompare(String(b.shot || ''), 'zh-CN', {numeric: true});
      if (shot) return shot;
      return Number(a.take_number || 0) - Number(b.take_number || 0);
    }).filter((row) => {
      if (!needle) return true;
      const material = asArray(row.attachments).map((item) => item.display_name).join(' ');
      return [row.episode, row.scene, row.shot, row.take_number, row.note, material].join(' ').toLowerCase().includes(needle);
    });
  }

  function groupTitle(group) {
    return asArray(group?.members).slice().sort((a, b) => (cameraOrder[a.camera] ?? 99) - (cameraOrder[b.camera] ?? 99))
      .map((member) => `${member.camera || '?'} · ${safeName(memberFileName(member))}`).join(' / ') || group?.group_id || '';
  }

  function unrecordedGroups() {
    const needle = intakeQuery.trim().toLowerCase();
    return asArray(state.groups).filter((group) => !recordForGroup(group.group_id)).filter((group) => {
      if (!needle) return true;
      return `${group.group_id} ${groupTitle(group)}`.toLowerCase().includes(needle);
    }).slice(0, 120);
  }

  function inventoryMatches() {
    const needle = intakeQuery.trim().toLowerCase();
    if (!needle) return [];
    return asArray(inventory.items).filter((row) => String(row.display_name || '').toLowerCase().includes(needle)).slice(0, 40);
  }

  function intakeMarkup() {
    const groups = unrecordedGroups();
    const files = inventoryMatches();
    return `
      <aside class="slate-intake">
        <div class="slate-intake-head"><strong>待录入素材</strong><span>${groups.length}${groups.length >= 120 ? '+' : ''} 组</span></div>
        <input id="slate-intake-search" type="search" placeholder="搜索文件名 / Take" value="${esc(intakeQuery)}">
        <div class="slate-drop-zone" id="slate-drop-zone"><strong>Finder 素材可拖到这里</strong><span>按文件名在当前项目素材库中匹配，不上传、不复制。</span></div>
        <div class="slate-intake-section"><span>镜序 Take</span>${groups.slice(0, 36).map((group) => `<button class="slate-intake-row" type="button" data-intake-group="${esc(group.group_id)}"><strong>${esc(groupTitle(group))}</strong><small>${Number(group.duration || 0).toFixed(1)}s · 一键带入 A/B/C</small></button>`).join('') || '<p>当前没有未录入 Take</p>'}</div>
        ${intakeQuery ? `<div class="slate-intake-section"><span>素材文件</span>${files.map((row) => `<button class="slate-intake-row" type="button" data-intake-media="${esc(row.media_id)}"><strong>${esc(row.display_name)}</strong><small>${esc(row.inferred_camera || '—')} · ${row.indexed ? '已索引' : '未进同步组'}</small></button>`).join('') || '<p>没有匹配素材</p>'}</div>` : ''}
      </aside>`;
  }

  function quickMarkup() {
    return `
      <div class="slate-quick-entry">
        <div class="slate-quick-title"><strong>快速录入</strong><span>可说“24场3镜第二次，B近景，前半段可用，后面笑场”</span></div>
        <textarea id="slate-quick-text" rows="2" placeholder="自然语言录入；“上一条/同上”会继承当前记录的基础字段"></textarea>
        <div class="slate-quick-actions"><button id="slate-voice" type="button">🎙 语音</button><button id="slate-parse" class="primary" type="button">解析并填入</button></div>
      </div>`;
  }

  function renderWorkspace() {
    if (!active) return;
    const panel = document.querySelector('#production-panel');
    if (!panel) return;
    document.documentElement.classList.add('supervisor-mode');
    panel.hidden = false;
    panel.classList.add('supervisor-workspace');
    const rows = filteredRecords();
    panel.innerHTML = `
      <div class="slate-shell">
        ${intakeMarkup()}
        <section class="slate-main">
          <header class="slate-header">
            <div><strong>电子场记表</strong><span>人工拍摄事实 · 与算法 Take 解耦 · ${records().length} 条记录 · rev ${Number(board.revision || 0)}</span></div>
            <div class="slate-header-actions"><input id="slate-table-search" type="search" placeholder="筛选场次、镜号、素材、备注" value="${esc(tableQuery)}"><button id="slate-new-record" type="button">＋ 空白记录</button></div>
          </header>
          ${quickMarkup()}
          <div class="slate-table-wrap">
            <table class="slate-table">
              <thead><tr><th>素材</th><th>集</th><th>场次</th><th>镜号</th><th>次数</th><th>现场状态</th><th>可用范围</th><th>备注</th><th></th></tr></thead>
              <tbody>${rows.map(recordRow).join('') || '<tr><td colspan="9" class="slate-empty">从左侧 Take 一键带入，或新建空白场记记录。</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <aside class="slate-preview" id="slate-preview" hidden>
          <header><div><strong id="slate-preview-name">素材预览</strong><span id="slate-preview-meta"></span></div><button type="button" id="slate-preview-close">关闭</button></header>
          <video id="slate-preview-video" controls playsinline preload="metadata"></video>
          <div class="slate-preview-tools"><span>空格 播放/暂停 · I 入点 · O 出点</span><button type="button" id="slate-set-in">设入点</button><button type="button" id="slate-set-out">设出点</button></div>
        </aside>
      </div>`;
    bindWorkspace();
  }

  function exitWorkspace() {
    active = false;
    document.documentElement.classList.remove('supervisor-mode');
    document.querySelector('#production-panel')?.classList.remove('supervisor-workspace');
  }

  function selectRecord(recordId) {
    selectedRecordId = recordId;
    document.querySelectorAll('[data-slate-row]').forEach((row) => row.classList.toggle('selected', row.dataset.slateRow === recordId));
  }

  async function addGroup(groupId) {
    const group = groupById(groupId);
    if (!group) return;
    const row = recordFromGroup(group);
    if (!recordById(row.record_id)) installLocalRecord(row);
    await postRecord(row, false).catch((error) => showToast(error.message || '场记创建失败'));
    selectedRecordId = row.record_id;
    renderWorkspace();
  }

  function ensureSelectedRecord() {
    if (selectedRecordId && recordById(selectedRecordId)) return recordById(selectedRecordId);
    const row = blankRecord();
    installLocalRecord(row);
    renderWorkspace();
    return row;
  }

  async function attachMedia(mediaId) {
    const source = asArray(inventory.items).find((row) => row.media_id === mediaId);
    if (!source) return showToast('当前素材库中找不到这条素材');
    const record = structuredClone(ensureSelectedRecord());
    const attachment = attachmentFromInventory(source);
    if (!asArray(record.attachments).some((item) => attachmentKey(item) === attachmentKey(attachment))) record.attachments.push(attachment);
    board.records[record.record_id] = record;
    await postRecord(record, false).catch((error) => showToast(error.message || '添加素材失败'));
    selectedRecordId = record.record_id;
    renderWorkspace();
  }

  async function detachMedia(recordId, key) {
    const record = structuredClone(recordById(recordId));
    record.attachments = asArray(record.attachments).filter((row) => attachmentKey(row) !== key);
    board.records[recordId] = record;
    await postRecord(record, false).catch((error) => showToast(error.message || '移除素材失败'));
    renderWorkspace();
  }

  function previewAttachment(recordId, clipId, mediaId, name) {
    if (!clipId) return showToast('这条辅助素材尚未进入可播放索引，可先完成场记标注');
    preview = {recordId, clipId, mediaId, name};
    const aside = document.querySelector('#slate-preview');
    const video = document.querySelector('#slate-preview-video');
    if (!aside || !video) return;
    aside.hidden = false;
    document.querySelector('#slate-preview-name').textContent = name || '素材预览';
    document.querySelector('#slate-preview-meta').textContent = recordId;
    video.src = projectApi(`/media/${encodeURIComponent(clipId)}`);
    video.load();
    video.play().catch(() => {});
  }

  function setRangePoint(kind) {
    const video = document.querySelector('#slate-preview-video');
    if (!video || !preview.recordId || !Number.isFinite(video.currentTime)) return;
    selectRecord(preview.recordId);
    const row = document.querySelector(`[data-slate-row="${CSS.escape(preview.recordId)}"]`);
    const input = row?.querySelector(`[data-field="range_${kind}"]`);
    if (!input) return;
    input.value = video.currentTime.toFixed(2);
    row.classList.add('dirty');
    queueSave(preview.recordId);
  }

  function bindWorkspace() {
    document.querySelector('#slate-intake-search')?.addEventListener('input', (event) => {
      intakeQuery = event.target.value;
      renderWorkspace();
      requestAnimationFrame(() => { const input = document.querySelector('#slate-intake-search'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); });
    });
    document.querySelector('#slate-table-search')?.addEventListener('input', (event) => {
      tableQuery = event.target.value;
      renderWorkspace();
    });
    document.querySelector('#slate-new-record')?.addEventListener('click', () => {
      const row = blankRecord(); installLocalRecord(row); renderWorkspace();
      requestAnimationFrame(() => document.querySelector(`[data-slate-row="${CSS.escape(row.record_id)}"] [data-field="scene"]`)?.focus());
    });
    document.querySelector('#slate-parse')?.addEventListener('click', parseQuickEntry);
    document.querySelector('#slate-voice')?.addEventListener('click', startVoiceEntry);
    document.querySelector('#slate-preview-close')?.addEventListener('click', () => { document.querySelector('#slate-preview-video')?.pause(); document.querySelector('#slate-preview').hidden = true; });
    document.querySelector('#slate-set-in')?.addEventListener('click', () => setRangePoint('start'));
    document.querySelector('#slate-set-out')?.addEventListener('click', () => setRangePoint('end'));

    document.querySelectorAll('[data-slate-row]').forEach((row) => {
      row.addEventListener('click', () => selectRecord(row.dataset.slateRow));
      row.querySelectorAll('input,select,textarea').forEach((control) => {
        control.addEventListener('input', () => row.classList.add('dirty'));
        control.addEventListener('change', () => queueSave(row.dataset.slateRow));
        control.addEventListener('blur', () => { if (row.classList.contains('dirty')) queueSave(row.dataset.slateRow); });
      });
    });
  }

  async function parseQuickEntry() {
    const input = document.querySelector('#slate-quick-text');
    const text = input?.value?.trim() || '';
    if (!text) return showToast('先输入或说一句场记');
    const record = structuredClone(ensureSelectedRecord());
    try {
      const payload = await fetchJson(projectApi('/script-supervisor-parse'), {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, previous: record, allow_model: true}),
      });
      const result = asObject(payload.result);
      for (const key of ['episode', 'scene', 'shot', 'take_number', 'status']) {
        if (result[key] !== undefined && result[key] !== null && result[key] !== '') record[key] = result[key];
      }
      record.note = String(result.note || text);
      const angleShots = asObject(result.angle_shots);
      const generic = String(result.generic_shot || '');
      record.attachments = asArray(record.attachments).map((attachment) => ({
        ...attachment,
        shot_type: angleShots[String(attachment.camera || '').toUpperCase()] || (generic && record.attachments.length === 1 ? generic : attachment.shot_type || 'unknown'),
      }));
      board.records[record.record_id] = record;
      await postRecord(record, false);
      selectedRecordId = record.record_id;
      renderWorkspace();
      showToast(result.parser === 'assistant_model' ? '小镜已解析，已填入场记' : '已解析场记');
    } catch (error) {
      showToast(error.message || '快速录入解析失败');
    }
  }

  function startVoiceEntry() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const input = document.querySelector('#slate-quick-text');
    if (!SpeechRecognition) {
      input?.focus();
      showToast('当前 WebView 未提供语音识别；已聚焦输入框，可使用 macOS 系统听写');
      return;
    }
    try {
      recognition?.abort?.();
      recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.interimResults = false;
      recognition.continuous = false;
      recognition.onstart = () => document.querySelector('#slate-voice')?.classList.add('recording');
      recognition.onend = () => document.querySelector('#slate-voice')?.classList.remove('recording');
      recognition.onerror = () => showToast('语音识别没有得到结果，可改用系统听写');
      recognition.onresult = (event) => {
        const text = asArray(Array.from(event.results)).map((row) => row[0]?.transcript || '').join('').trim();
        if (input && text) input.value = text;
        if (text) parseQuickEntry();
      };
      recognition.start();
    } catch (_error) {
      input?.focus();
      showToast('语音入口暂不可用，可使用 macOS 系统听写');
    }
  }

  async function deleteRecord(recordId) {
    const record = recordById(recordId);
    if (!record?.record_id) return;
    if (!confirm('删除这条电子场记记录？素材文件不会被删除。')) return;
    try {
      await postRecord(record, true);
      if (selectedRecordId === recordId) selectedRecordId = '';
      renderWorkspace();
    } catch (error) { showToast(error.message || '删除失败'); }
  }

  async function refreshBoard(render = true) {
    if (!state.projectId) return;
    try {
      board = await fetchJson(projectApi('/script-supervisor'));
      state.scriptSupervisorRevision = Number(board.revision || 0);
      if (render && active) renderWorkspace();
    } catch (error) { if (active) showToast(error.message || '读取场记失败'); }
  }

  async function refreshInventory() {
    if (!state.projectId) return;
    inventory = await fetchJson(projectApi('/media-inventory')).catch(() => ({items: []}));
  }

  function activate() {
    active = true;
    if (!selectedRecordId) selectedRecordId = records()[0]?.record_id || '';
    renderWorkspace();
    refreshBoard(true);
    refreshInventory().then(() => active && renderWorkspace());
  }
  window.openScriptSupervisorWorkspace = activate;
  window.closeScriptSupervisorWorkspace = exitWorkspace;

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-production-target="supervisor"], #production-supervisor-tab');
    if (target) { event.preventDefault(); activate(); return; }
    const group = event.target.closest('[data-intake-group]');
    if (group) { event.preventDefault(); addGroup(group.dataset.intakeGroup); return; }
    const media = event.target.closest('[data-intake-media]');
    if (media) { event.preventDefault(); attachMedia(media.dataset.intakeMedia); return; }
    const select = event.target.closest('[data-select-record]');
    if (select) { selectRecord(select.dataset.selectRecord); return; }
    const detach = event.target.closest('[data-detach-record]');
    if (detach) { event.preventDefault(); detachMedia(detach.dataset.detachRecord, detach.dataset.detachKey); return; }
    const remove = event.target.closest('[data-delete-record]');
    if (remove) { event.preventDefault(); deleteRecord(remove.dataset.deleteRecord); return; }
    const play = event.target.closest('[data-preview-record]');
    if (play) {
      const record = recordById(play.dataset.previewRecord);
      const attachment = asArray(record.attachments).find((row) => String(row.clip_id || '') === play.dataset.previewClip && String(row.media_id || '') === play.dataset.previewMedia)
        || asArray(record.attachments).find((row) => attachmentKey(row) === `${play.dataset.previewClip || ''}|${play.dataset.previewMedia || ''}`);
      previewAttachment(play.dataset.previewRecord, play.dataset.previewClip, play.dataset.previewMedia, attachment?.display_name || '素材');
      return;
    }
    if (event.target.closest('#production-bar [data-production-tab], [data-production-target]:not([data-production-target="supervisor"])')) exitWorkspace();
  }, true);

  document.addEventListener('dragover', (event) => {
    if (!active || !event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    document.querySelector('#slate-drop-zone')?.classList.add('dragover');
  });
  document.addEventListener('dragleave', () => document.querySelector('#slate-drop-zone')?.classList.remove('dragover'));
  document.addEventListener('drop', async (event) => {
    if (!active || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    document.querySelector('#slate-drop-zone')?.classList.remove('dragover');
    for (const file of Array.from(event.dataTransfer.files).slice(0, 12)) {
      const matches = asArray(inventory.items).filter((row) => String(row.display_name || '').toLowerCase() === String(file.name || '').toLowerCase());
      if (matches.length === 1) await attachMedia(matches[0].media_id);
      else if (matches.length > 1) showToast(`${file.name} 有多个同名素材，请用左侧搜索选择`);
      else showToast(`${file.name} 不在当前已绑定素材目录；先在素材页扫描/绑定`);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!active) return;
    const tag = event.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const video = document.querySelector('#slate-preview-video');
    if (event.code === 'Space' && video && !document.querySelector('#slate-preview')?.hidden) {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
    } else if (event.key.toLowerCase() === 'i') setRangePoint('start');
    else if (event.key.toLowerCase() === 'o') setRangePoint('end');
  });

  const baseSwitchProject = switchProject;
  switchProject = async function supervisorSwitchProject(...args) {
    board = {version: 2, revision: 0, records: {}, entries: {}};
    inventory = {items: []}; selectedRecordId = '';
    const result = await baseSwitchProject(...args);
    await refreshBoard(false);
    if (APP_CLIENT) await refreshInventory();
    if (active) renderWorkspace();
    return result;
  };

  const basePollState = pollState;
  pollState = async function supervisorPollState() {
    const result = await basePollState();
    if (state.projectId) {
      try {
        const next = await fetchJson(projectApi('/state'));
        if (Number(next.script_supervisor_revision || 0) !== Number(state.scriptSupervisorRevision || 0)) await refreshBoard(active);
      } catch (_error) {}
    }
    return result;
  };

  requestAnimationFrame(async () => {
    await refreshBoard(false);
    await refreshInventory();
    if (new URLSearchParams(window.location.search).get('production') === 'supervisor') activate();
  });
})();
