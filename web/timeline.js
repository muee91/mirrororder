(() => {
  // Compatibility loader for older App shells. Team Web must never grow the
  // production XML timeline or native-file controls just because this file is
  // present in the bundled web tree.
  if (!window.webkit?.messageHandlers?.mirrorOrder) return;
  if (window.__mirrorOrderTimelineLoaderInstalled) return;
  window.__mirrorOrderTimelineLoaderInstalled = true;

  const script = document.createElement('script');
  script.src = '/timeline_v3.js';
  script.async = false;
  document.body.appendChild(script);
})();
