(() => {
  if (window.__mirrorOrderReviewModelInstalled) return;
  window.__mirrorOrderReviewModelInstalled = true;

  const nativeApp = Boolean(window.webkit?.messageHandlers?.mirrorOrder);
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

  function nativeMediaPaths(groups) {
    const paths = new Map();
    for (const group of groups || []) {
      for (const member of group.members || []) {
        if (!member?.clip_id) continue;
        paths.set(member.clip_id, {
          media_path: member.media_path || '',
          source_media_path: member.source_media_path || '',
          resolved_media_path: member.resolved_media_path || '',
          local_exists: member.local_exists,
          exists: member.exists,
        });
      }
    }
    return paths;
  }

  function legacyMember(angle, paths) {
    const available = angle.playback?.available;
    const exists = available === undefined ? true : Boolean(available);
    const nativePath = nativeApp ? paths.get(angle.clip_id) : null;
    return {
      clip_id: angle.clip_id || '',
      media_id: angle.media_id || '',
      camera: angle.camera || '',
      name: angle.name || angle.clip_id || '未命名素材',
      // review.v1 stays path-free for Team Web. The native App reads the
      // current Mac's local resolver projection only to prepare AppKit drags.
      media_path: nativePath?.media_path || angle.name || '',
      source_media_path: nativePath?.source_media_path || '',
      resolved_media_path: nativePath?.resolved_media_path || '',
      timeline_start: Number(angle.timeline_start || 0),
      timeline_end: Number(angle.timeline_end || 0),
      duration: Number(angle.duration || 0),
      source_start: Number(angle.source_start || 0),
      source_end: angle.source_end === null || angle.source_end === undefined
        ? null : Number(angle.source_end),
      shot_type: angle.shot_type || 'unknown',
      coverage_role: angle.coverage_role || 'unknown',
      visible_people: [...(angle.visible_people || [])],
      technical_issues: [...(angle.technical_issues || [])],
      local_exists: nativePath?.local_exists ?? exists,
      exists: nativePath?.exists ?? exists,
    };
  }

  function legacyGroup(take, paths) {
    const members = (take.angles || []).map((angle) => legacyMember(angle, paths));
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
      audit_state: take.audit_state ? {...take.audit_state} : null,
      role_suggestions: [...(take.role_suggestions || [])],
      issues: [...(take.issues || [])],
      people: take.people ? {...take.people} : {faces: [], speakers: []},
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

  function applyReviewModel(model, paths = new Map()) {
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
      audit: {...(model.summary?.audit || {})},
    };
    state.script = flattenScript(model);
    state.groups = (model.take_groups || []).map((take) => legacyGroup(take, paths));
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
    state.auditRevision = Number(revisions.audit || 0);
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
    let paths = new Map();
    if (nativeApp) {
      try {
        paths = nativeMediaPaths(await legacyFetchJson(projectApi('/groups')));
      } catch (_error) {
        // The review model remains usable when the App-local path supplement
        // is temporarily unavailable; only external file dragging is omitted.
      }
    }
    applyReviewModel(model, paths);
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
  // review.v1 projection whenever production, review, collaboration, or audit
  // evidence changes. Audit is still read-only evidence, not review authority.
  pollState = async function reviewModelPollState() {
    try {
      const next = await legacyFetchJson(projectApi('/state'));
      const analysisChanged = Boolean(
        next.analysis_revision && next.analysis_revision !== state.analysisRevision
      );
      const reviewChanged = Number(next.review_revision || 0) !== Number(state.reviewRevision || 0);
      const editorialChanged = Number(next.editorial_revision || 0) !== Number(state.editorialRevision || 0);
      const auditChanged = Number(next.audit_revision || 0) !== Number(state.auditRevision || 0);
      if (analysisChanged || reviewChanged || editorialChanged || auditChanged) {
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
