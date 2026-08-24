(() => {
  if (window.__mirrorOrderStartupGate) return;

  const nativeFetch = window.fetch.bind(window);
  let released = false;
  let releasePending = () => {};
  let lastRuntimeError = '';
  const pending = new Promise((resolve) => { releasePending = resolve; });

  function statusText() {
    return document.querySelector('#analysis-status')?.textContent?.trim() || '';
  }

  function coreReady() {
    const status = statusText();
    if (!status || status === '读取项目' || status === '读取失败') return false;
    const scriptReady = Boolean(document.querySelector('#script-list')?.children.length);
    const candidateReady = Boolean(document.querySelector('#candidate-list')?.children.length);
    return scriptReady || candidateReady;
  }

  function ensureFailureSurface() {
    let surface = document.querySelector('#mirrororder-boot-failure');
    if (surface) return surface;
    surface = document.createElement('section');
    surface.id = 'mirrororder-boot-failure';
    surface.hidden = true;
    surface.setAttribute('role', 'alert');
    surface.style.cssText = [
      'position:fixed',
      'z-index:10000',
      'left:50%',
      'top:50%',
      'transform:translate(-50%,-50%)',
      'width:min(680px,calc(100vw - 48px))',
      'padding:18px 20px',
      'border:1px solid var(--line-strong,#cbd4df)',
      'border-radius:8px',
      'background:var(--panel,#fff)',
      'color:var(--ink,#172033)',
      'box-shadow:0 18px 52px rgba(0,0,0,.22)',
      'font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif',
    ].join(';');
    surface.innerHTML = `
      <strong style="display:block;font-size:15px;margin-bottom:6px">工作台未完成加载</strong>
      <p data-boot-detail style="margin:0;color:var(--muted,#687386);white-space:pre-wrap"></p>
      <div style="margin-top:14px;display:flex;gap:8px">
        <button type="button" data-boot-reload style="min-height:30px;padding:0 10px">重新加载</button>
      </div>
    `;
    document.body.appendChild(surface);
    surface.querySelector('[data-boot-reload]')?.addEventListener('click', () => location.reload());
    return surface;
  }

  function showFailure(reason = '') {
    if (coreReady()) return;
    const candidateText = document.querySelector('#candidate-list')?.textContent?.trim() || '';
    const detail = String(reason || candidateText || lastRuntimeError || '项目数据没有完成初始化。请重新加载；如果仍然出现，请打开状态中心查看制作主机日志。');
    const surface = ensureFailureSurface();
    const target = surface.querySelector('[data-boot-detail]');
    if (target) target.textContent = detail;
    surface.hidden = false;
  }

  function hideFailureIfReady() {
    if (!coreReady()) return;
    const surface = document.querySelector('#mirrororder-boot-failure');
    if (surface) surface.hidden = true;
  }

  function release() {
    if (released) return;
    released = true;
    window.fetch = nativeFetch;
    releasePending();
    window.setTimeout(() => {
      if (coreReady()) return;
      if (statusText() === '读取失败') {
        showFailure();
        return;
      }
      showFailure('工作台启动超过 12 秒仍未完成。制作主机可能返回了错误，或某个前端扩展在初始化时失败。');
    }, 12000);
  }

  window.__mirrorOrderStartupGate = {
    release,
    get released() { return released; },
  };

  // app.js starts boot immediately. Hold only API fetches until every static
  // extension has installed its wrappers; script/css resource loading is not
  // affected by this gate.
  window.fetch = (...args) => pending.then(() => nativeFetch(...args));

  window.addEventListener('error', (event) => {
    lastRuntimeError = String(event?.message || '前端脚本执行失败');
  });
  window.addEventListener('unhandledrejection', (event) => {
    lastRuntimeError = String(event?.reason?.message || event?.reason || '前端异步任务失败');
  });

  const status = document.querySelector('#analysis-status');
  if (status) {
    new MutationObserver(() => {
      if (statusText() === '读取失败') showFailure();
      else hideFailureIfReady();
    }).observe(status, {childList: true, characterData: true, subtree: true});
  }

  // Emergency fail-open only. Normal boot is released by startup_release.js;
  // leave enough time for native compatibility scripts to finish or fail.
  window.addEventListener('load', () => window.setTimeout(release, 5000), {once: true});
})();
