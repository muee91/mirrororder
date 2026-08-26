const SHOT_TYPE_LABELS = Object.freeze({
  wide: '全景',
  full: '全身',
  medium: '中景',
  medium_closeup: '中近景',
  closeup: '近景',
  extreme_closeup: '特写',
  big_closeup: '大特写',
  insert: '细节',
  unknown: '景别—',
});

let shotTypesByClip = new Map();
let decorateScheduled = false;

function normalizeShotType(value) {
  const type = String(value || 'unknown').trim();
  return Object.prototype.hasOwnProperty.call(SHOT_TYPE_LABELS, type) ? type : 'unknown';
}

function rebuildShotTypeIndexFromReviewModel() {
  const next = new Map();
  // `state.groups` is populated by review_model.js from the path-free
  // review.v1 projection. Team Web must never call Host-only script-supervisor
  // endpoints merely to decorate material cards. Human Script Supervisor shot
  // evidence is already embedded on each take as `script_supervisor.angles`;
  // prefer it for display without turning Slate into Review mapping authority.
  for (const group of state?.groups || []) {
    const supervisorAngles = group?.script_supervisor?.angles || {};
    for (const member of group?.members || []) {
      const clipId = String(member?.clip_id || '').trim();
      if (!clipId) continue;
      const supervisorType = supervisorAngles?.[clipId]?.shot_type;
      next.set(clipId, normalizeShotType(supervisorType || member?.shot_type));
    }
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
  const label = SHOT_TYPE_LABELS[type] || SHOT_TYPE_LABELS.unknown;
  // MutationObserver watches childList changes. Replacing textContent with the
  // same value still mutates the text node and can create a self-triggering
  // observer loop, so all DOM writes below are idempotent.
  if (chip.textContent !== label) chip.textContent = label;
  const unknown = type === 'unknown';
  if (chip.classList.contains('unknown') !== unknown) chip.classList.toggle('unknown', unknown);
  const title = unknown ? '场记尚未标记景别' : `场记景别：${label}`;
  if (chip.title !== title) chip.title = title;
  if (card.dataset.shotType !== type) card.dataset.shotType = type;
}

function decorateMaterialCards(root = document) {
  rebuildShotTypeIndexFromReviewModel();
  root.querySelectorAll?.('.member-card[data-member-clip]').forEach(ensureShotTypeChip);
}

function scheduleDecoration(root = document) {
  if (decorateScheduled) return;
  decorateScheduled = true;
  requestAnimationFrame(() => {
    decorateScheduled = false;
    decorateMaterialCards(root);
  });
}

function mutationNeedsDecoration(record) {
  if (record.type !== 'childList') return false;
  const target = record.target;
  // Ignore the chip's own text-node insertion/replacement. This is the second
  // guard against recursive decoration in addition to idempotent writes.
  if (target instanceof Element && target.closest('.shot-type-chip')) return false;
  return [...record.addedNodes, ...record.removedNodes].some((node) => {
    if (!(node instanceof Element)) return false;
    return node.matches('.member-card[data-member-clip]')
      || Boolean(node.querySelector?.('.member-card[data-member-clip]'));
  });
}

function installMaterialCardProjection() {
  const candidateList = document.querySelector('#candidate-list');
  if (candidateList) {
    new MutationObserver((records) => {
      if (records.some(mutationNeedsDecoration)) scheduleDecoration(candidateList);
    }).observe(candidateList, {childList: true, subtree: true});
  }
  document.querySelector('#project-select')?.addEventListener('change', () => {
    shotTypesByClip = new Map();
    scheduleDecoration(candidateList || document);
  });
  document.querySelector('#workspace-select')?.addEventListener('change', () => {
    shotTypesByClip = new Map();
    scheduleDecoration(candidateList || document);
  });
  decorateMaterialCards(candidateList || document);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installMaterialCardProjection, {once: true});
} else {
  installMaterialCardProjection();
}
