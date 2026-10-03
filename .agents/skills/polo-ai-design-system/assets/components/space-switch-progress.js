/* Prototype product feedback: only a real confirmation starts the sequence.
   Direct review entry stays still; cancellation/reset invalidates pending work. */
(() => {
  let attempt = 0, playing = false, expectedEcho = null;
  const current = () => document.body.dataset.currentScene;
  function paintProgress(root, count) {
    const total = root.querySelectorAll('.dialog-row .row-state').length;
    const label = root.querySelector('[data-stop-count]');
    if (label) label.textContent = `${count} / ${total}`;
    const track = root.querySelector('.progress-track');
    if (track) {
      track.setAttribute('aria-valuemax', total);
      track.setAttribute('aria-valuenow', count);
      track.querySelector('span').style.width = `${total ? count / total * 100 : 0}%`;
    }
  }
  function later(scene, delay, fn) {
    const token = attempt;
    setTimeout(() => {
      if (playing && token === attempt && current() === scene) fn();
    }, delay);
  }
  function result(from, to) {
    window.dispatchEvent(new CustomEvent('polo:system-result', {detail: {from, to}}));
  }
  window.addEventListener('polo:scene-shown', event => {
    const {scene, reason} = event.detail;
    // The review shell echoes each accepted product action/result once. Only that
    // acknowledgement may preserve playback; later review navigation cancels it.
    if (reason === 'command') {
      if (expectedEcho === scene) {expectedEcho = null; return;}
      attempt++; playing = false; expectedEcho = null;
    }
    expectedEcho = ['action', 'system'].includes(reason) ? scene : null;
    if (reason === 'reset' || (playing && !['P-M02-STOPPING', 'P-M02-TARGET-LOADING'].includes(scene))) {
      attempt++; playing = false;
    }
    if (scene === 'P-M02-STOPPING' && ['command', 'reset'].includes(reason)) {
      const root = document.querySelector('.scene.active');
      root.querySelectorAll('.dialog-row .row-state').forEach(el => {el.textContent = '正在停止'; el.className = 'row-state stopping';});
      paintProgress(root, 0);
    }
    if (scene === 'P-M02-STOPPING' && reason === 'action') {
      attempt++; playing = true;
      const root = document.querySelector('.scene.active');
      const rows = [...root.querySelectorAll('.dialog-row .row-state')];
      rows.forEach(el => {el.textContent = '正在停止'; el.className = 'row-state stopping';});
      paintProgress(root, 0);
      later(scene, 350, () => {if(rows[0]) rows[0].textContent = '已停止'; paintProgress(root, 1);});
      later(scene, 700, () => {if(rows[2]) rows[2].textContent = '已停止'; paintProgress(root, 2);});
      later(scene, 1100, () => {
        const token = attempt;
        const commit = () => {
          if (!playing || token !== attempt || current() !== scene) return;
          rows.forEach(el => {el.textContent = '已停止';});
          paintProgress(root, rows.length);
          result(scene, 'P-M02-TARGET-LOADING');
        };
        if (!window.poloSwitchGate?.({from: scene, to: 'P-M02-TARGET-LOADING', commit})) commit();
      });
    }
    if (scene === 'P-M02-TARGET-LOADING' && reason === 'system' && playing) {
      later(scene, 700, () => result(scene, 'P-M03-HOME-PERSONAL'));
    }
  });
  window.addEventListener('polo:surface-suspended', () => {attempt++; playing = false; expectedEcho = null;});
  window.addEventListener('polo:switch-stop-failed', () => {
    if (playing && current() === 'P-M02-STOPPING') result('P-M02-STOPPING', 'P-M02-STOP-FAILED');
  });
})();
