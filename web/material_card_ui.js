const SHOT_TYPE_LABELS = Object.freeze({
  wide: '全景',
  full: '全身',
  medium: '中景',
  medium_closeup: '中近景',
  closeup: '近景',
  extreme_closeup: '特写', big_closeup: '大特写',
  insert: '细节',
  unknown: '景别—',
});

let shotTypesByClip = new Map();
let lastProjectKey = '';
let refreshTimer = null;
let refreshInFlight = null;

function activeProjectIdentity() {
  const workspaceSelect = document.querySelector('#workspace-select');
  const projectSelect = document.querySelector('#project-select');
  const url = new URL(window.location.href);
  const workspaceId = String(workspaceSelect?.value || url.searchParams.get('workspace_id') || '').trim();
  const projectId = String(projectSelect?.value || url.searchParams.get('project_id') || '').trim();
  return {workspaceId, projectId, key: `${workspaceId}|${projectId}`};
}

function boardAttachments(board) {
  const records = board?.records && typeof board.records === 'object' ? Object.values(board.records) : [];
  return records.flatMap((record) => Array.isArray(record?.attachments) ? record.attachments : []);
}

function normalizeShotType(value) {
  const type = String(value || 'unknown').trim();
  return Object.prototype.hasOwnProperty.call(SHOT_TYPE_LABELS, type) ? type : 'unknown';
}

function rebuildShotTypeIndex(board) {
  const next = new Map();
  for (const attachment of boardAttachments(board)) {
    const clipId = String(attachment?.clip_id || '').trim();
    if (!clipId) continue;
    next.set(clipId, normalizeShotType(attachment?.shot_type));
  }
  shotTypesByClip = next;
}

function ensureShotTypeChip(card) {
  const clipId = String(card?.dataset?.memberClip || '').trim();
  if (!clipId) return;
  const type = shotTypesByClip.get(clipId) || 'unknown';
  const bottom = card.querySelector('.member-bottom');
  if (!bottom) return;
  let chip = bottom.querySelector('.shot-type-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'shot-type-chip';
    const time = bottom.querySelector('.member-time');
    bottom.insertBefore(chip, time || null);
  }
  chip.textContent = SHOT_TYPE_LABELS[type] || SHOT_TYPE_LABELS.unknown;
  chip.classList.toggle('unknown', type === 'unknown');
  chip.title = type === 'unknown' ? '场记尚未标记景别' : `场记景别：${SHOT_TYPE_LABELS[type]}`;
  card.dataset.shotType = type;
}

function decorateMaterialCards(root = document) {
  root.querySelectorAll?.('.member-card[data-member-clip]').forEach(ensureShotTypeChip);
}

async function refreshSlateFacts(force = false) {
  const identity = activeProjectIdentity();
  if (!identity.workspaceId || !identity.projectId) return;
  if (!force && identity.key === lastProjectKey && refreshInFlight) return refreshInFlight;
  lastProjectKey = identity.key;
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/projects/${encodeURIComponent(identity.projectId)}/script-supervisor`;
  refreshInFlight = fetchJson(endpoint, {timeoutMs: 8000})
    .then((board) => {
      if (board) rebuildShotTypeIndex(board);
      decorateMaterialCards();
      return board;
    })
    .catch(() => null)
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshSlateFacts(false), 120);
}

function installMaterialCardProjection() {
  const candidateList = document.querySelector('#candidate-list');
  if (candidateList) {
    new MutationObserver(() => {
      decorateMaterialCards(candidateList);
      scheduleRefresh();
    }).observe(candidateList, {childList: true, subtree: true});
  }
  document.querySelector('#project-select')?.addEventListener('change', () => {
    lastProjectKey = '';
    shotTypesByClip = new Map();
    refreshSlateFacts(true);
  });
  document.querySelector('#workspace-select')?.addEventListener('change', () => {
    lastProjectKey = '';
    shotTypesByClip = new Map();
    refreshSlateFacts(true);
  });
  decorateMaterialCards();
  refreshSlateFacts(true);
  window.setInterval(() => refreshSlateFacts(false), 8000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installMaterialCardProjection, {once: true});
} else {
  installMaterialCardProjection();
}
