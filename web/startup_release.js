(() => {
  const gate = window.__mirrorOrderStartupGate;
  if (!gate) return;
  const timelineReady = window.__mirrorOrderTimelineReady;
  if (!timelineReady || typeof timelineReady.then !== 'function') {
    gate.release();
    return;
  }
  timelineReady.catch(() => undefined).finally(() => gate.release());
})();
