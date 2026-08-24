(() => {
  // Compatibility loader for older App shells. Team Web must never grow the
  // production XML timeline or native-file controls just because this file is
  // present in the bundled web tree.
  if (!window.webkit?.messageHandlers?.mirrorOrder) {
    window.__mirrorOrderTimelineReady = Promise.resolve();
    return;
  }
  if (window.__mirrorOrderTimelineLoaderInstalled) return;
  window.__mirrorOrderTimelineLoaderInstalled = true;

  window.__mirrorOrderTimelineReady = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/timeline_v3.js';
    script.async = false;
    script.addEventListener('load', resolve, {once: true});
    script.addEventListener('error', resolve, {once: true});
    document.body.appendChild(script);
  });
})();
