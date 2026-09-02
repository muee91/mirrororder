(() => {
  if (window.__mirrorOrderReviewComponentsV2Installed) return;
  window.__mirrorOrderReviewComponentsV2Installed = true;

  if (
    typeof renderMemberStrip !== 'function'
    || typeof sortedMembers !== 'function'
    || typeof renderTakeRow !== 'function'
  ) return;

  function cameraPresentation(value) {
    const raw = String(value || '').trim();
    const compact = raw.replace(/\s+/g, '').toUpperCase();
    if (/^A(机|机位)?$/.test(compact)) return {key: 'a', rank: 0, tone: 'a', token: 'A', label: 'A'};
    if (/^B(机|机位)?$/.test(compact)) return {key: 'b', rank: 1, tone: 'b', token: 'B', label: 'B'};
    if (/^C(机|机位)?$/.test(compact)) return {key: 'c', rank: 2, tone: 'c', token: 'C', label: 'C'};
    if (/^(AUX|辅助|特殊|辅助[\/／]特殊)(机|机位)?$/.test(compact)) {
      return {key: 'aux', rank: 3, tone: 'aux', token: 'AUX', label: 'AUX'};
    }
    const label = raw || '未标机位';
    return {
      key: `custom:${label.toLocaleLowerCase('zh-CN')}`,
      rank: 50,
      tone: 'custom',
      token: 'custom',
      label,
    };
  }

  function compareMembers(left, right) {
    const leftCamera = cameraPresentation(left?.camera);
    const rightCamera = cameraPresentation(right?.camera);
    return leftCamera.rank - rightCamera.rank
      || leftCamera.label.localeCompare(rightCamera.label, 'zh-CN', {numeric: true})
      || Number(left?.timeline_start || 0) - Number(right?.timeline_start || 0)
      || memberFileName(left).localeCompare(memberFileName(right), 'zh-CN', {numeric: true});
  }

  sortedMembers = function professionalSortedMembers(group) {
    return [...(group?.members || [])].sort(compareMembers);
  };

  renderMemberStrip = function professionalRenderMemberStrip(group) {
    const grouped = new Map();
    for (const member of sortedMembers(group)) {
      const presentation = cameraPresentation(member.camera);
      const current = grouped.get(presentation.key);
      if (current) current.members.push(member);
      else grouped.set(presentation.key, {presentation, members: [member]});
    }

    const runs = [...grouped.values()].sort((left, right) => (
      left.presentation.rank - right.presentation.rank
      || left.presentation.label.localeCompare(right.presentation.label, 'zh-CN', {numeric: true})
    ));

    return runs.map(({presentation, members}) => {
      const repeated = members.length > 1;
      const cards = members.map((member) => {
        const fileName = memberFileName(member);
        const active = state.selectedGroupId === group.group_id && state.selectedClipId === member.clip_id;
        const available = member.exists !== false;
        const healthClass = available ? 'is-ready' : 'is-offline';
        const healthLabel = available ? '可播放' : '离线';
        return `<button class="member-card review-member-tile camera-${presentation.token} ${active ? 'active' : ''}" `
          + `data-camera-tone="${presentation.tone}" data-member-group="${esc(group.group_id)}" data-member-clip="${esc(member.clip_id)}" `
          + `aria-label="${esc(`${presentation.label}机位 · ${fileName} · ${healthLabel}`)}" `
          + `title="${esc(member.media_path || fileName)}" type="button" ${available ? '' : 'disabled'}>`
          + `<strong class="member-file">${esc(fileName)}</strong>`
          + '<span class="member-bottom">'
          + `<span class="camera-chip camera-${presentation.token}" data-camera-tone="${presentation.tone}">${esc(presentation.label)}</span>`
          + `<span class="member-time">${esc(memberRangeText(member))}</span>`
          + '</span>'
          + `<span class="media-health-indicator ${healthClass}" aria-label="媒体状态：${healthLabel}">${healthLabel}</span>`
          + '</button>';
      }).join('');
      return `<div class="camera-run review-camera-run camera-${presentation.token}" data-camera-tone="${presentation.tone}">`
        + (repeated ? `<span class="repeat-label">${esc(presentation.label)}×${members.length}</span>` : '')
        + cards
        + '</div>';
    }).join('');
  };

  const baseRenderTakeRow = renderTakeRow;
  renderTakeRow = function professionalRenderTakeRow(...args) {
    return baseRenderTakeRow(...args)
      .replace('<article class="take-row ', '<article class="take-row review-take-row ')
      .replace('<span class="badge badge-', '<span class="badge review-opinion-indicator badge-')
      .replace(/class="decision-button/g, 'class="decision-button review-opinion-control')
      .replace('class="placement-button"', 'class="placement-button placement-indicator"')
      .replace('class="editorial-team-row"', 'class="editorial-team-row review-opinion-summary"')
      .replace('class="editorial-final"', 'class="editorial-final editorial-decision-indicator"');
  };

  window.MirrorOrderReviewComponentsV2 = {cameraPresentation};
})();
