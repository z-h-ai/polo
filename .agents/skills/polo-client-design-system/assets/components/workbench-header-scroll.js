// Shared product behavior: reveal the fixed header divider only when its page
// content has scrolled underneath it. Nested chat/list panes own their borders.
(() => {
  let scheduled = false;
  const update = () => {
    scheduled = false;
    document.querySelectorAll('.workbench-bar, .polo-host-bar').forEach(header => {
      const scene = header.closest('[data-prototype-scene]');
      if (!scene || !scene.getClientRects().length) return;
      const page = scene.querySelector('.workspace-main, .polo-preferences, .polo-skill-manager');
      const scrolled = Boolean(page && page.scrollHeight > page.clientHeight + 1 && page.scrollTop > 0);
      const value = String(scrolled);
      if (header.dataset.scrolled !== value) header.dataset.scrolled = value;
    });
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  };
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'data-current-scene']
  });
  schedule();
})();
