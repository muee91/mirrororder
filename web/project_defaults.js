(() => {
  if (window.__mirrorOrderProjectDefaultsInstalled) return;
  window.__mirrorOrderProjectDefaultsInstalled = true;

  function setRawMediaDefault() {
    const kind = document.querySelector('#new-project-kind');
    if (!kind) return;
    kind.value = 'media-directory';
    if (typeof updateProjectKindFields === 'function') updateProjectKindFields();
    const media = document.querySelector('#new-project-media-root');
    requestAnimationFrame(() => media?.focus());
  }

  document.querySelector('#create-project')?.addEventListener('click', () => {
    requestAnimationFrame(setRawMediaDefault);
  });

  const kind = document.querySelector('#new-project-kind');
  if (kind) {
    const media = kind.querySelector('option[value="media-directory"]');
    const xml = kind.querySelector('option[value="fcpxml"]');
    if (media) media.textContent = '原始多机位素材目录（推荐）';
    if (xml) xml.textContent = '已有同步 FCPXML（高级）';
  }

  const scriptInput = document.querySelector('#new-project-script');
  if (scriptInput) scriptInput.placeholder = '选择 DOCX、TXT 或 Markdown 剧本';
})();
