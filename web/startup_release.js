(() => {
  if (!document.querySelector('link[data-mirrororder-material-cards]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/material_card.css';
    link.dataset.mirrororderMaterialCards = '1';
    document.head.appendChild(link);
  }
  import('/material_card_ui.js').catch(() => undefined);
  import('/post_workbench_ui.js').catch(() => undefined);

  const gate = window.__mirrorOrderStartupGate;
  if (!gate) return;
  const timelineReady = window.__mirrorOrderTimelineReady;
  if (!timelineReady || typeof timelineReady.then !== 'function') {
    gate.release();
    return;
  }
  timelineReady.catch(() => undefined).finally(() => gate.release());
})();