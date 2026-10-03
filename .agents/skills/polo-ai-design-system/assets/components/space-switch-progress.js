/* Prototype product feedback: only a real confirmation starts the sequence.
   Direct review entry stays still; cancellation/reset invalidates pending work. */
(() => {
  let attempt = 0, playing = false, expectedEcho = null;
  const current = () => document.body.dataset.currentScene;
  const cancelRoot=document.querySelector('[data-prototype-scene="P-M02-STOP-CANCEL"]');
  const cancelFixture=cancelRoot?.querySelector('.dialog-list')?.innerHTML;
  function paintProgress(root, count) {
    const total = [...root.querySelectorAll('.dialog-row')].filter(row=>!row.hidden).length;
    const label = root.querySelector('[data-stop-count],.switch-progress-summary span strong');
    const percent=root.querySelector('.switch-progress-summary>strong');if(percent)percent.textContent=Math.round(total?count/total*100:0)+'%';
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
    const {scene, reason, from} = event.detail;
    if(scene.startsWith('P-M02-STOPPING')&&reason==='action')document.querySelector('.scene.active').querySelectorAll('[data-switch-attempt-row]').forEach(row=>row.removeAttribute('data-switch-attempt-row'));
    window.poloPrepareTaskFixture?.(scene,reason);window.poloPrepareSwitchList?.();window.poloPaintTaskState?.();
    if(scene==='P-M02-STOP-CANCEL'){
      const review=reason==='reset'||reason==='command'&&window.poloReviewArrival!=='action'&&window.poloReviewArrival!=='system';
      if(review&&cancelFixture)cancelRoot.querySelector('.dialog-list').innerHTML=cancelFixture;
      if(reason==='action'&&['P-M02-STOPPING','P-M02-STOP-FAILED'].includes(from)){
        const source=document.querySelector('[data-prototype-scene="'+from+'"] .dialog-list');
        const rows=[...source.querySelectorAll('.dialog-row')].filter(row=>!row.hidden).map(row=>row.cloneNode(true));
        for(const row of rows){const state=row.querySelector('.row-state');if(state.textContent==='正在停止'){state.textContent='运行中';state.className='row-state';}if(state.textContent==='已停止'){state.className='row-state good';const note=row.querySelector('small');if(note)note.textContent='已停止；不会因取消重新执行';}}
        cancelRoot.querySelector('.dialog-list').replaceChildren(...rows);
      }
      const count=[...cancelRoot.querySelectorAll('.dialog-row .row-state')].filter(x=>x.textContent==='已停止').length;paintProgress(cancelRoot,count);
    }
    // The review shell echoes each accepted product action/result once. Only that
    // acknowledgement may preserve playback; later review navigation cancels it.
    if (reason === 'command') {
      if (expectedEcho === scene) {expectedEcho = null; return;}
      attempt++; playing = false; expectedEcho = null;
    }
    expectedEcho = ['action', 'system'].includes(reason) ? scene : null;
    if (reason === 'reset' || (playing && !['P-M02-STOPPING', 'P-M02-TARGET-LOADING','P-M02-STOPPING-PERSONAL','P-M02-TARGET-LOADING-ENT'].includes(scene))) {
      attempt++; playing = false;
    }
    if (scene.startsWith('P-M02-STOPPING') && ['command', 'reset'].includes(reason)) {
      const root = document.querySelector('.scene.active');
      root.querySelectorAll('.dialog-row .row-state').forEach(el => {el.textContent = '正在停止'; el.className = 'row-state stopping';});
      paintProgress(root, 0);
    }
    if (scene.startsWith('P-M02-STOPPING') && reason === 'action') {
      attempt++; playing = true;
      const root = document.querySelector('.scene.active');
      const rows = [...root.querySelectorAll('.dialog-row')].filter(row=>!row.hidden).map(row=>{row.dataset.switchAttemptRow='true';return row.querySelector('.row-state')});
      const target=scene==='P-M02-STOPPING-PERSONAL'?'P-M02-TARGET-LOADING-ENT':'P-M02-TARGET-LOADING';
      const appRows=rows.filter(el=>el.closest('.dialog-row').dataset.taskKey);
      const stoppedCount=()=>rows.filter(el=>el.textContent==='已停止').length;
      const stopRow=el=>{if(!el)return;el.textContent='已停止';const key=el.closest('.dialog-row').dataset.taskKey;if(key)window.dispatchEvent(new CustomEvent('polo:task-stopped',{detail:{scope:scene.endsWith('PERSONAL')?'personal':'enterprise',key}}));};
      rows.forEach(el => {el.textContent = '正在停止'; el.className = 'row-state stopping';});
      paintProgress(root, 0);
      later(scene, 350, () => {stopRow(appRows[0]); paintProgress(root, stoppedCount());});
      later(scene, 700, () => {stopRow(appRows[1]); paintProgress(root, stoppedCount());});
      later(scene, 1100, () => {
        const token = attempt;
        const commit = () => {
          if (!playing || token !== attempt || current() !== scene) return;
          rows.forEach(el => {el.textContent = '已停止';});
          const loading=document.querySelector('[data-prototype-scene="'+target+'"]');
          if(loading){const list=loading.querySelector('.dialog-list');if(list)list.replaceChildren(...rows.map(el=>el.closest('.dialog-row').cloneNode(true)));const count=loading.querySelector('[data-stop-count],.switch-progress-summary strong');if(count)count.textContent=rows.length+' / '+rows.length;paintProgress(loading,rows.length);}

          paintProgress(root, rows.length);
          window.dispatchEvent(new CustomEvent('polo:scope-stopped',{detail:{scope:scene==='P-M02-STOPPING-PERSONAL'?'personal':'enterprise'}}));
          result(scene, target);
        };
        if (!window.poloSwitchGate?.({from: scene, to: target, commit})) commit();
      });
    }
    if (scene.startsWith('P-M02-TARGET-LOADING') && reason === 'system' && playing) {
      later(scene, 700, () => result(scene, scene==='P-M02-TARGET-LOADING-ENT'?'P-M03-HOME-ENT':'P-M03-HOME-PERSONAL'));
    }
  });
  window.addEventListener('polo:surface-suspended', () => {attempt++; playing = false; expectedEcho = null;});
  window.addEventListener('polo:assistant-stop-requested',()=>{const row=document.querySelector('.scene.active [data-assistant-switch-row]');if(!row)return;row.querySelector('.row-state').textContent='等待停止确认';const note=row.querySelector('small');if(note)note.textContent='已请求停止，尚未收到确认';});
  window.addEventListener('polo:switch-stop-failed', () => {
    const from=current(),to=from==='P-M02-STOPPING'?'P-M02-STOP-FAILED':from==='P-M02-STOPPING-PERSONAL'?'P-M02-STOP-FAILED-PERSONAL':null;
    if(!playing||!to)return;
    const source=document.querySelector('[data-prototype-scene="'+from+'"]'),target=document.querySelector('[data-prototype-scene="'+to+'"]');
    const rows=[...source.querySelectorAll('.dialog-row')].filter(row=>!row.hidden).map(row=>row.cloneNode(true));
    for(const row of rows){const state=row.querySelector('.row-state'),note=row.querySelector('small');if(state.textContent!=='已停止'){state.textContent='未确认停止';state.className='row-state bad';if(note)note.textContent='尚未收到停止确认，仍保留原空间';}else if(note)note.textContent='已停止；重试不会重新执行';}
    target.querySelector('.dialog-list').replaceChildren(...rows);paintProgress(target,rows.filter(row=>row.querySelector('.row-state').textContent==='已停止').length);
    result(from,to);
  });
})();
