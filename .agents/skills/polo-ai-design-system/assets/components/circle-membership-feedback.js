/* Session-only fixtures for the explicit data/annual circle exit operations.
   Shared-work authorization is unchanged; only each confirmed source is removed. */
(() => {
  const joined = {data: true, year: true};
  window.poloCircleMemberships = joined;
  function paint() {
    const scene = document.querySelector('.scene.active');
    if (!scene) return;
    for (const [key, kind] of [['data', 'data'], ['year', 'annual']]) {
      const card = scene.querySelector(`[data-circle-kind="${kind}"]`);
      if (card && !joined[key]) card.hidden = true;
    }
    if (!joined.data) {
      scene.querySelectorAll('[data-app-key="report"]').forEach(card => card.hidden = true);
      scene.querySelectorAll('.circle-app-grid [data-go="P-M04-APP-REPORT"]').forEach(button => {
        button.disabled = true; button.textContent = '已失去授权';
      });
    }
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-leave-circle]');
    if (!button || button.disabled || !button.closest('.scene.active')) return;
    joined[button.dataset.leaveCircle] = false;
    window.dispatchEvent(new Event('polo:memberships-changed'));
  }, true);
  window.addEventListener('polo:scene-shown', event => {
    if (event.detail.reason === 'reset') {
      joined.data = joined.year = true;
      document.querySelectorAll('.circle-app-grid [data-go="P-M04-APP-REPORT"]').forEach(button => {
        button.disabled = false; button.textContent = '打开';
      });
      window.dispatchEvent(new Event('polo:memberships-changed'));
    }
    paint();
  });
  window.addEventListener('polo:memberships-changed', paint);
})();
