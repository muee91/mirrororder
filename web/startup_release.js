(() => {
  const gate = window.__mirrorOrderStartupGate;
  if (!gate) return;
  const timelineReady = window.__mirrorOrderTimelineReady;
  if (!timelineReady || typeof timelineReady.then !== 'function') {
    gate.release();
    return;
  }
  Promise.race([
    timelineReady.catch(() => undefined),
    new Promise((resolve) => window.setTimeout(resolve, 1500)),
  ]).finally(() => gate.release());
})();
