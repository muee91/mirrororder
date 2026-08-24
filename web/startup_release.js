(() => {
  // All optional workbench modules wrap pollState. Install one outer guard
  // after those wrappers are in place so a slow request cannot fan out into
  // overlapping state/review reloads and leave the console visually stuck.
  if (typeof pollState === 'function' && !window.__mirrorOrderPollGuardInstalled) {
    const basePollState = pollState;
    let inFlight = null;
    pollState = async function guardedPollState() {
      if (inFlight) return inFlight;
      inFlight = Promise.resolve()
        .then(() => basePollState())
        .finally(() => { inFlight = null; });
      return inFlight;
    };
    window.__mirrorOrderPollGuardInstalled = true;
  }
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
