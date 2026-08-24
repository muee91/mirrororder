(() => {
  const MIME = 'application/x-mirrororder-placement';
  const SOURCE_SELECTOR = '.take-row, .member-card';
  const TARGET_SELECTOR = '.script-line[data-segment-id]';

  function canReview() {
    return ['reviewer', 'manager'].includes(String(state.userRole || ''));
  }

  function sourcePayload(node) {
    const member = node.closest('.member-card[data-member-group][data-member-clip]');
    if (member) {
      return {
        group_id: String(member.dataset.memberGroup || ''),
        source_kind: 'clip',
        source_clip_id: String(member.dataset.memberClip || ''),
      };
    }
    const take = node.closest('.take-row[data-take-group]');
    if (take) {
      return {
        group_id: String(take.dataset.takeGroup || ''),
        source_kind: 'take',
        source_clip_id: '',
      };
    }
    return null;
  }

  function decorate(root = document) {
    root.querySelectorAll(SOURCE_SELECTOR).forEach((node) => {
      if (node.matches('.member-card') && node.disabled) return;
      node.draggable = canReview();
      node.classList.toggle('placement-draggable', canReview());
      if (canReview()) {
        node.setAttribute('aria-description', node.matches('.member-card')
          ? '可拖到左侧剧本段完成当前 Take 的人工归集'
          : '可拖到左侧剧本段完成人工归集');
      }
    });
    root.querySelectorAll(TARGET_SELECTOR).forEach((node) => {
      node.classList.toggle('placement-drop-enabled', canReview());
    });
  }

  function readPayload(event) {
    const raw = event.dataTransfer?.getData(MIME)
      || event.dataTransfer?.getData('text/x-mirrororder-placement')
      || '';
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.group_id) return null;
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  function clearDragState() {
    document.querySelectorAll('.placement-drag-source').forEach((node) => node.classList.remove('placement-drag-source'));
    document.querySelectorAll('.placement-drop-target').forEach((node) => node.classList.remove('placement-drop-target'));
    document.body.classList.remove('placement-dragging');
  }

  document.addEventListener('dragstart', (event) => {
    if (!canReview()) return;
    const source = event.target.closest(SOURCE_SELECTOR);
    if (!source) return;
    const payload = sourcePayload(source);
    if (!payload?.group_id || !state.groupMap.has(payload.group_id)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(MIME, JSON.stringify(payload));
    event.dataTransfer.setData('text/x-mirrororder-placement', JSON.stringify(payload));
    source.classList.add('placement-drag-source');
    document.body.classList.add('placement-dragging');
  });

  document.addEventListener('dragend', clearDragState);

  document.addEventListener('dragover', (event) => {
    if (!canReview()) return;
    const target = event.target.closest(TARGET_SELECTOR);
    if (!target) return;
    if (!event.dataTransfer?.types?.includes(MIME)
        && !event.dataTransfer?.types?.includes('text/x-mirrororder-placement')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.placement-drop-target').forEach((node) => {
      if (node !== target) node.classList.remove('placement-drop-target');
    });
    target.classList.add('placement-drop-target');
  });

  document.addEventListener('dragleave', (event) => {
    const target = event.target.closest(TARGET_SELECTOR);
    if (!target) return;
    const related = event.relatedTarget;
    if (!related || !target.contains(related)) target.classList.remove('placement-drop-target');
  });

  document.addEventListener('drop', async (event) => {
    const target = event.target.closest(TARGET_SELECTOR);
    if (!target || !canReview()) return;
    const payload = readPayload(event);
    if (!payload) return;
    event.preventDefault();
    clearDragState();

    const segmentId = String(target.dataset.segmentId || '');
    const segment = state.segmentMap.get(segmentId);
    const group = state.groupMap.get(String(payload.group_id || ''));
    if (!segment || segment.type === 'scene_heading' || !group) {
      showToast('归集目标已经变化，请刷新后重试');
      return;
    }

    const episode = Number(segment.episode);
    try {
      await postReviewAction({
        action: 'set_group_placement',
        group_id: group.group_id,
        episode_ids: Number.isFinite(episode) ? [episode] : [],
        script_segment_ids: [segmentId],
        interaction: 'drag_drop',
        source_surface: 'web_review',
        source_kind: payload.source_kind === 'clip' ? 'clip' : 'take',
        source_clip_id: payload.source_kind === 'clip' ? String(payload.source_clip_id || '') : '',
      });
      state.mode = 'script';
      state.episode = Number.isFinite(episode) ? episode : state.episode;
      state.segmentId = segmentId;
      state.selectedGroupId = group.group_id;
      state.selectedClipId = payload.source_kind === 'clip' ? String(payload.source_clip_id || '') : null;
      renderContent();
      requestAnimationFrame(() => {
        document.querySelector(`[data-segment-id="${CSS.escape(segmentId)}"]`)?.scrollIntoView({block: 'center'});
        document.querySelector(`[data-take-group="${CSS.escape(group.group_id)}"]`)?.scrollIntoView({block: 'center'});
      });
      if (state.selectedClipId) selectMember(group.group_id, state.selectedClipId, false);
      const label = payload.source_kind === 'clip'
        ? memberFileName((group.members || []).find((item) => item.clip_id === payload.source_clip_id) || {})
        : `Take ${group.take_index || ''}`.trim();
      showToast(`${label} 已人工归集到第 ${segment.order || ''} 段`);
    } catch (error) {
      setCollabStatus('保存失败', false);
      showToast(error.message || '归集失败');
    }
  });

  const candidateList = document.querySelector('#candidate-list');
  const scriptList = document.querySelector('#script-list');
  const observer = new MutationObserver(() => decorate());
  if (candidateList) observer.observe(candidateList, {childList: true, subtree: true});
  if (scriptList) observer.observe(scriptList, {childList: true, subtree: true});
  window.addEventListener('focus', () => decorate());
  decorate();
})();
