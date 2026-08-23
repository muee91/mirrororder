(() => {
  if (window.__mirrorOrderSupervisorKeyboardInstalled) return;
  window.__mirrorOrderSupervisorKeyboardInstalled = true;
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;

  // The v2 slate owns its counters internally. This keeps one legacy callback
  // used by the autosave path harmless until that call is removed in a later
  // source compaction; it does not mutate review/editorial state.
  if (typeof window.updateCounts !== 'function') window.updateCounts = () => {};

  const editableSelector = '[data-field="episode"],[data-field="scene"],[data-field="shot"],[data-field="take_number"],[data-field="status"],[data-field="range_start"],[data-field="range_end"],[data-field="note"]';

  function active() {
    return document.documentElement.classList.contains('supervisor-mode');
  }

  function focusNext(control, backwards = false) {
    const controls = [...document.querySelectorAll(`.slate-table tbody ${editableSelector}`)]
      .filter((item) => !item.disabled && item.offsetParent !== null);
    const index = controls.indexOf(control);
    if (index < 0 || !controls.length) return;
    const next = controls[(index + (backwards ? -1 : 1) + controls.length) % controls.length];
    next?.focus();
    if (next?.select && next.tagName !== 'SELECT') next.select();
  }

  function shuttle(seconds) {
    const video = document.querySelector('#slate-preview-video');
    if (!video || document.querySelector('#slate-preview')?.hidden) return;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(duration, Number(video.currentTime || 0) + seconds));
  }

  document.addEventListener('keydown', (event) => {
    if (!active()) return;
    const target = event.target;
    const tag = target?.tagName?.toLowerCase();

    if (event.altKey && event.code === 'Space') {
      event.preventDefault();
      document.querySelector('#slate-voice')?.click();
      return;
    }

    if (event.key === 'Escape' && !document.querySelector('#slate-preview')?.hidden) {
      event.preventDefault();
      document.querySelector('#slate-preview-close')?.click();
      return;
    }

    if (target?.matches?.(editableSelector)) {
      if (event.key === 'Enter' && tag !== 'textarea') {
        event.preventDefault();
        target.dispatchEvent(new Event('change', {bubbles: true}));
        focusNext(target, event.shiftKey);
      }
      if (event.key === 'Enter' && tag === 'textarea' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        target.dispatchEvent(new Event('change', {bubbles: true}));
        focusNext(target, false);
      }
      return;
    }

    const video = document.querySelector('#slate-preview-video');
    if (!video || document.querySelector('#slate-preview')?.hidden) return;
    if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (video.paused) video.play().catch(() => {}); else video.pause();
    } else if (event.key.toLowerCase() === 'j') {
      event.preventDefault();
      shuttle(-2);
    } else if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      shuttle(2);
    }
  }, true);
})();
