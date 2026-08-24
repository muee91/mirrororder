(() => {
  if (window.__mirrorOrderDeviceMediaInstalled) return;
  window.__mirrorOrderDeviceMediaInstalled = true;

  function isNativeApp() {
    return Boolean(window.webkit?.messageHandlers?.mirrorOrder);
  }

  function ensureBadge() {
    let badge = document.querySelector('#device-media-status');
    if (badge) return badge;
    badge = document.createElement('span');
    badge.id = 'device-media-status';
    badge.className = 'connection-state';
    badge.title = '素材绝对路径不会写入共享项目。每台 Mac 在镜序 App 设置中选择自己的素材目录。';
    const anchor = document.querySelector('#collab-status');
    anchor?.parentElement?.insertBefore(badge, anchor);
    return badge;
  }

  function updateBadge() {
    const badge = ensureBadge();
    if (!badge) return;
    const local = state.project?.local_media;
    if (!local || !Number.isFinite(Number(local.total))) {
      badge.textContent = '';
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    const resolved = Number(local.resolved || 0);
    const total = Number(local.total || 0);
    const missing = Number(local.missing || 0);
    badge.textContent = `${isNativeApp() ? '本机' : '服务端'}素材 ${resolved}/${total}`;
    badge.classList.toggle('offline', missing > 0);
    badge.title = missing
      ? `还有 ${missing} 个媒体未在这台设备定位。请在镜序 App → 设置 → 这台 Mac 的素材副本中扫描素材目录。`
      : '当前项目媒体已全部在这台设备定位。';
  }

  const baseRenderContent = renderContent;
  renderContent = function deviceAwareRenderContent(...args) {
    const result = baseRenderContent(...args);
    updateBadge();
    return result;
  };

  const baseReloadAnalysis = reloadAnalysis;
  reloadAnalysis = async function deviceAwareReloadAnalysis(...args) {
    const result = await baseReloadAnalysis(...args);
    updateBadge();
    return result;
  };

  requestAnimationFrame(updateBadge);
})();
