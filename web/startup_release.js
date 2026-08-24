(() => {
  // Install the outer poll guard before optional workbench modules. A slow
  // request must not fan out into overlapping state/review reloads.
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

  const APP_CLIENT = Boolean(window.webkit?.messageHandlers?.mirrorOrder);

  function loadScript(src) {
    if (document.querySelector(`script[data-mirrororder-lazy="${src}"]`)) return Promise.resolve();
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.mirrororderLazy = src;
      script.addEventListener('load', resolve, {once: true});
      script.addEventListener('error', resolve, {once: true});
      document.body.appendChild(script);
    });
  }

  function scheduleIdle(callback, timeout = 1200) {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => callback(), {timeout});
      return;
    }
    window.setTimeout(callback, 160);
  }

  function ensureMaterialCardStyles() {
    if (document.querySelector('link[data-mirrororder-material-cards]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/material_card.css';
    link.dataset.mirrororderMaterialCards = '1';
    document.head.appendChild(link);
  }

  async function loadOptionalWorkbench() {
    ensureMaterialCardStyles();

    // These extensions decorate already-rendered DOM. They are deliberately
    // kept out of first paint because their observers/fetches scale with the
    // project and are not required to start reviewing the first episode.
    await loadScript('/material_card_ui.js');
    await loadScript('/post_workbench_ui.js');
    await loadScript('/placement_drag_ui.js');

    if (APP_CLIENT) {
      // The production App owns assistant computation/configuration. Load the
      // full controls only there, after the core workbench is interactive.
      await loadScript('/assistant_ui.js');
      await loadScript('/assistant_control_ui.js');
      await loadScript('/semantic_search_ui.js');
    } else {
      // Team Web never recomputes Xiaojing from every Take. It only projects
      // the Host-generated assistant payload, and fetches it on user demand.
      await loadScript('/assistant_projection_ui.js');
    }
  }

  const gate = window.__mirrorOrderStartupGate;
  const timelineReady = window.__mirrorOrderTimelineReady;
  const ready = timelineReady && typeof timelineReady.then === 'function'
    ? timelineReady.catch(() => undefined)
    : Promise.resolve();

  ready.finally(() => {
    gate?.release?.();
    // Give the first episode a paint + input opportunity before optional
    // project-sized observers are installed.
    requestAnimationFrame(() => scheduleIdle(() => {
      loadOptionalWorkbench().catch(() => undefined);
    }));
  });
})();
