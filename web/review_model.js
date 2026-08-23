(() => {
  // The native App keeps the richer production data path because AppKit file
  // dragging requires device-local resolved paths. Normal Web consumes only
  // the Host-projected review.v1 contract.
  if (window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderReviewModelInstalled) return;
  window.__mirrorOrderReviewModelInstalled = true;

  const legacyFetchJson = fetchJson;
  const legacySwitchProject = switchProject;
  let switchingProject = false;
  let cachedSwitchReview = null;

  function flattenScript(model) {
    const rows = [];
    for (const episode of model.episodes || []) {
      for (const scene of episode.scenes || []) {
        for (const block of scene.script_blocks || []) rows.push({...block});
      }
    }
    rows.sort((left, right) => (
      Number(left.episode || 0) - Number(right.episode || 0)
      || Number(left.order || 0) - Number(right.order || 0)
      || String(left.segment_id || '').localeCompare(String(right.segment_id || ''))
    ));
    return {segments: rows};
  }

  function legacyMember(angle) {
    const available = angle.playback?.available;
    const exists = available === undefined ? true : Boolean(available);
    return {
      clip_id: angle.clip_id || '',
      media_id: angle.media_id || '',
      camera: angle.camera || '',
      name: angle.name || angle.clip_id || '未命名素材',
      // Review Web deliberately receives no Host absolute path. Keeping only
      // the display name also prevents timeline helpers from mistaking a Host
      // filesystem path for a browser-client path.
      media_path: angle.name || '',
      source_media_path: '',
      resolved_media_path: '',
      timeline_start: Number(angle.timeline_start || 0),
      timeline_end: Number(angle.timeline_end || 0),
      duration: Number(angle.duration || 0),
      source_start: Number(angle.source_start || 0),
      source_end: angle.source_end === null || angle.source_end === undefined
        ? null : Number(angle.source_end),
      local_exists: exists,
      exists,
    };
  }

  function legacyGroup(take) {
    const members = (take.angles || []).map(legacyMember);
    const automation = take.automatic_state?.available ? {...take.automatic_state} : undefined;
    return {
      group_id: take.group_id || '',
      parent_group_id: take.parent_group_id || '',
      kind: take.kind || 'multicam',
      take_index: Number(take.take_index || 1),
      split_reason: take.split_reason || '',
      start: Number(take.start || 0),
      end: Number(take.end || 0),
      duration: Number(take.duration || 0),
      cameras: [...(take.cameras || [])],
      members,
      ...(automation ? {automation} : {}),
    };
  }

  function legacyMatches(model) {
    const groups = {};
    const bySegment = {};
    for (const take of model.take_groups || []) {
      const candidates = (take.candidates || []).map((candidate) => ({...candidate}));
      groups[take.group_id] = {
        candidates,
        context_episodes: [...(take.context?.episode_ids || [])],
        context_segment_ids: [...(take.context?.script_segment_ids || [])],
      };
      for (const candidate of candidates) {
        const ids = candidate.script_segment_ids?.length
          ? candidate.script_segment_ids
          : (candidate.script_segment_id ? [candidate.script_segment_id] : []);
        for (const segmentId of ids) {
          if (!bySegment[segmentId]) bySegment[segmentId] = [];
          bySegment[segmentId].push(candidate);
        }
      }
    }
    return {
      groups,
      by_segment: bySegment,
      script_gaps: (model.script_gaps || []).map((gap) => ({...gap})),
    };
  }

  function applyReviewModel(model) {
    if (!model || model.contract_version !== 'review.v1') {
      throw new Error(`不支持的审阅数据契约：${model?.contract_version || 'unknown'}`);
    }
    const project = model.project || {};
    const revisions = model.revisions || {};
    const automationSummary = model.summary?.automation || {};
    state.reviewModel = model;
    state.project = {
      project_id: project.project_id || state.projectId,
      project: project.name || state.projectId,
      input_kind: project.input_kind || '',
      analysis_revision: revisions.analysis || '',
      stats: {...(project.stats || {})},
      errors: {},
      local_media: {...(project.local_media || {})},
      automation: {
        updated_at: revisions.automation_updated_at || '',
        analysis_revision: revisions.automation_analysis || '',
        summary: {...automationSummary},
      },
    };
    state.script = flattenScript(model);
    state.groups = (model.take_groups || []).map(legacyGroup);
    state.matches = legacyMatches(model);
    state.review = model.review_state?.legacy_review || {
      version: 2,
      revision: 0,
      assignments: {},
      groups: {},
      clips: {},
      placements: {},
    };
    state.groupMap = new Map(state.groups.map((group) => [group.group_id, group]));
    state.segmentMap = new Map(allSegments().map((segment) => [segment.segment_id, segment]));
    state.analysisRevision = revisions.analysis || state.analysisRevision;
    state.reviewRevision = Number(state.review.revision || revisions.review || 0);
    state.editorialRevision = Number(revisions.editorial || 0);
  }

  fetchJson = async function reviewModelFetchJson(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (
      switchingProject
      && method === 'GET'
      && cachedSwitchReview
      && url === projectApi('/review')
    ) {
      const review = cachedSwitchReview;
      cachedSwitchReview = null;
      return review;
    }
    return legacyFetchJson(url, options);
  };

  reloadAnalysis = async function reviewModelReloadAnalysis(showNotice = false) {
    const model = await legacyFetchJson(projectApi('/review-model'));
    applyReviewModel(model);
    if (switchingProject) cachedSwitchReview = state.review;
    if (!state.episode && state.episode !== null) state.episode = episodeList()[0] ?? null;
    $('#project-name').textContent = state.project.project;
    $('#analysis-status').textContent = `${state.project.stats?.groups || model.summary?.take_groups || 0}组 · ${state.project.stats?.clips || 0}条素材`;
    renderContent();
    focusRequestedGroup();
    if (showNotice) {
      $('#update-banner').hidden = false;
      playUpdateSound();
    }
  };

  switchProject = async function reviewModelSwitchProject(...args) {
    switchingProject = true;
    cachedSwitchReview = null;
    try {
      return await legacySwitchProject(...args);
    } finally {
      switchingProject = false;
      cachedSwitchReview = null;
    }
  };

  // Team Web polls one compact state endpoint, then reloads the authoritative
  // review.v1 projection whenever production analysis, legacy review, or the
  // new collaboration revision changes. This keeps opinions live without
  // teaching the browser how editorial.json is stored internally.
  pollState = async function reviewModelPollState() {
    try {
      const next = await legacyFetchJson(projectApi('/state'));
      const analysisChanged = Boolean(
        next.analysis_revision && next.analysis_revision !== state.analysisRevision
      );
      const reviewChanged = Number(next.review_revision || 0) !== Number(state.reviewRevision || 0);
      const editorialChanged = Number(next.editorial_revision || 0) !== Number(state.editorialRevision || 0);
      if (analysisChanged || reviewChanged || editorialChanged) {
        await reloadAnalysis(analysisChanged);
        if (reviewChanged) {
          const actor = latestReviewActor(state.review);
          if (actor && actor !== state.actor) showToast(`${actor} 的修改已同步`);
        }
      }
      setCollabStatus('协作已连接', true);
    } catch (_error) {
      setCollabStatus('协作连接中断', false);
    }
  };

  // Production-only extensions can still be present in the shared static
  // bundle for the native App. Remove their entry points from every ordinary
  // browser, including a browser opened on the Host Mac itself.
  requestAnimationFrame(() => {
    document.querySelector('#replace-project-script')?.remove();
    document.querySelector('#timeline-button')?.remove();
    document.querySelector('#timeline-dialog')?.remove();
  });
})();
