(() => {
  for (const src of ['/timeline_v3.js', '/device_media.js', '/automation.js']) {
    const script = document.createElement('script');
    script.src = src;
    script.defer = true;
    document.body.appendChild(script);
  }
})();
