(() => {
  const baseCandidateForSegment = candidateForSegment;
  const baseUpdateProgress = updateProgress;
  const baseSavePlacement = savePlacement;

  function placementScriptIds(group) {
    return (placementForGroup(group).entry?.script_segment_ids || [])
      .filter((id) => state.segmentMap.get(id)?.type !== 'scene_heading');
  }

  // A manual script-range correction is authoritative. If a Take was moved away
  // from an automatic line, do not keep showing it on the old line. Episode-only
  // placement remains contextual and does not pretend the exact line was confirmed.
  candidateForSegment = function patchedCandidateForSegment(segmentId) {
    const candidates = baseCandidateForSegment(segmentId);
    return candidates
      .filter((candidate) => {
        const group = state.groupMap.get(candidate.group_id);
        if (!group) return false;
        const ids = placementScriptIds(group);
        return !ids.length || ids.includes(segmentId);
      })
      .map((candidate) => {
        const group = state.groupMap.get(candidate.group_id);
        const ids = placementScriptIds(group);
        if (!ids.length || !ids.includes(segmentId)) return candidate;
        return {
          ...candidate,
          confidence: 'manual',
          total_score: 1,
          script_segment_id: ids[ids.length - 1] || candidate.script_segment_id,
          script_segment_ids: ids,
          evidence: ['人工归集到此剧本范围'],
        };
      });
  };

  confidencePresentation = function patchedConfidencePresentation(candidate, group) {
    const placement = placementForGroup(group);
    const placementIds = placementScriptIds(group);
    const candidateIds = candidateScriptIds(candidate);
    const manualLineConfirmed = placementIds.length > 0
      && candidateIds.some((id) => placementIds.includes(id));
    if (manualLineConfirmed || candidate?.confidence === 'manual') {
      return {
        className: 'manual',
        title: '人工确认',
        detail: placement.inherited ? '继承归集' : '人工归集',
        percent: '',
      };
    }
    const score = Number(candidate?.total_score);
    const percent = Number.isFinite(score) && score > 0 ? `评分${Math.round(score * 100)}` : '';
    if (candidate?.confidence === 'exact_dialogue') {
      return {className: 'exact', title: '高', detail: '对白匹配', percent};
    }
    if (candidate?.confidence === 'possible_dialogue') {
      return {className: 'possible', title: '中', detail: '存在歧义', percent};
    }
    return {className: 'context', title: '低', detail: '邻近线索', percent};
  };

  // Reject must win over automatic candidates once every candidate for the line
  // has been explicitly rejected; otherwise progress and "只看未核对" never finish.
  stateForSegment = function patchedStateForSegment(segmentId) {
    const candidates = candidateForSegment(segmentId);
    const states = candidates.map((candidate) => (
      assignmentState(segmentId, state.groupMap.get(candidate.group_id))
    ));
    if (states.includes('best')) return 'best';
    if (states.includes('keep')) return 'keep';
    if (states.length && states.every((value) => value === 'reject')) return 'reject';
    if (candidates.some((candidate) => ['manual', 'exact_dialogue'].includes(candidate.confidence))) return 'possible';
    if (candidates.some((candidate) => candidate.confidence === 'possible_dialogue')) return 'possible';
    const contextGroups = Object.entries(state.matches?.groups || {}).filter(([, item]) => (
      item.context_segment_ids || []
    ).includes(segmentId));
    if (contextGroups.length) return 'context';
    if (scriptGapForSegment(segmentId)) return 'gap';
    return 'unknown';
  };

  // Keyboard review must never guess which Take the editor meant when several
  // candidates are visible. One candidate is safe; otherwise require selection.
  selectedCandidate = function patchedSelectedCandidate() {
    if (state.mode === 'unassigned') {
      const groups = visibleUnassignedGroups();
      if (state.selectedGroupId) {
        const group = state.groupMap.get(state.selectedGroupId);
        return group ? {group_id: group.group_id, contextOnly: true} : null;
      }
      return groups.length === 1 ? {group_id: groups[0].group_id, contextOnly: true} : null;
    }
    const candidates = candidateForSegment(state.segmentId);
    if (state.selectedGroupId) {
      return candidates.find((candidate) => candidate.group_id === state.selectedGroupId) || null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  };

  updateProgress = function patchedUpdateProgress() {
    baseUpdateProgress();
    const button = $('#show-unknown');
    if (!button) return;
    const disabled = state.mode === 'unassigned';
    button.disabled = disabled;
    button.title = disabled ? '此筛选只用于剧本时间轴' : '';
    if (disabled) button.textContent = '只看未核对';
  };

  // If a manual range crosses episodes, make episode metadata consistent with the
  // selected range instead of allowing contradictory placement data.
  savePlacement = async function patchedSavePlacement() {
    const startId = $('#placement-start').value;
    const endId = $('#placement-end').value;
    if (startId || endId) {
      const segments = matchableSegments();
      const positions = new Map(segments.map((segment, index) => [segment.segment_id, index]));
      const left = positions.get(startId || endId);
      const right = positions.get(endId || startId);
      if (left !== undefined && right !== undefined) {
        const start = Math.min(left, right);
        const end = Math.max(left, right);
        const episodes = new Set(
          segments.slice(start, end + 1)
            .map((segment) => Number(segment.episode))
            .filter(Number.isFinite),
        );
        $('#placement-episodes').querySelectorAll('input[type="checkbox"]').forEach((input) => {
          if (episodes.has(Number(input.value))) input.checked = true;
        });
      }
    }
    return baseSavePlacement();
  };

  // Skip non-actionable scene-heading rows when navigating the script with arrows.
  document.addEventListener('keydown', (event) => {
    if (ignoreKeyboard(event)) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.mode !== 'script') return;
    const segments = visibleSegments().filter((segment) => segment.type !== 'scene_heading');
    const index = segments.findIndex((segment) => segment.segment_id === state.segmentId);
    const nextIndex = event.key === 'ArrowDown'
      ? (index < 0 ? 0 : index + 1)
      : (index < 0 ? segments.length - 1 : index - 1);
    if (nextIndex < 0 || nextIndex >= segments.length) return;
    state.segmentId = segments[nextIndex].segment_id;
    state.selectedGroupId = null;
    renderContent({candidateTop: 0});
    requestAnimationFrame(() => {
      document.querySelector(`[data-segment-id="${CSS.escape(state.segmentId)}"]`)
        ?.scrollIntoView({block: 'center'});
    });
  }, true);

  // Prevent B/K/X/U from silently acting on the first row when multiple Takes are visible.
  document.addEventListener('keydown', (event) => {
    if (ignoreKeyboard(event)) return;
    if (!['b', 'k', 'x', 'u'].includes(event.key.toLowerCase())) return;
    if (selectedCandidate()) return;
    const count = state.mode === 'unassigned'
      ? visibleUnassignedGroups().length
      : candidateForSegment(state.segmentId).length;
    if (count <= 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showToast('有多个候选，请先点选一个 Take 的机位卡片');
  }, true);

  // Search already supports Enter; add expected arrow-key result navigation.
  $('#search')?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...document.querySelectorAll('#search-results .search-result')];
    if (!rows.length) return;
    event.preventDefault();
    const current = Math.max(0, rows.findIndex((row) => row.classList.contains('active')));
    const next = event.key === 'ArrowDown'
      ? Math.min(rows.length - 1, current + 1)
      : Math.max(0, current - 1);
    rows.forEach((row, index) => row.classList.toggle('active', index === next));
    rows[next]?.scrollIntoView({block: 'nearest'});
  });

  // Timeline and native file-drag features live in a separate extension so the
  // core review UI remains small and deterministic.
  const timelineScript = document.createElement('script');
  timelineScript.src = '/timeline.js';
  timelineScript.defer = true;
  document.body.appendChild(timelineScript);
})();
