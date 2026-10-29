/* Appearance (Automatic, Light or Dark), applied before the page draws so it never flashes. */
(() => {
  'use strict';
  const COLORS = { light: '#f5f5f7', dark: '#000000' };
  function apply(choice) {
    const root = document.documentElement;
    const forced = choice === 'light' || choice === 'dark' ? choice : null;
    if (forced) root.dataset.theme = forced;
    else delete root.dataset.theme;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const scheme = meta.dataset.scheme;
      meta.setAttribute('content', COLORS[forced || scheme]);
      if (forced) meta.removeAttribute('media');
      else meta.setAttribute('media', `(prefers-color-scheme: ${scheme})`);
    }
  }
  let saved = 'auto';
  try {
    saved = JSON.parse(localStorage.getItem('dropspace.theme') || '"auto"');
  } catch {
    /* private mode: Automatic */
  }
  apply(saved);
  window.DropspaceTheme = { apply };
})();
