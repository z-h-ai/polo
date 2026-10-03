
(() => {
 let offline=false;const stopped=new Set();
 function setOffline(value,verified=false){offline=value;window.poloNetworkOffline=value;window.dispatchEvent(new CustomEvent('polo:network-state',{detail:{verified}}));}
 window.addEventListener('polo:network-offline',()=>{setOffline(true);paint()});
 window.addEventListener('polo:task-stopped',event=>{stopped.add(event.detail.scope+':'+event.detail.key)});
 window.addEventListener('polo:network-verified',()=>{setOffline(false,true);paint()});
 window.poloTaskStopped=(scope,key)=>stopped.has(scope+':'+key);
 const starts=new Set(['P-M04-APP-REPORT','P-M04-APP-VIEW-PERSONAL','P-M04-APP-GROWTH','P-M04-APP-BRAND','P-M04-APP-VIEW','P-M04-APP-ACTIVE','P-M04-APP-CONTRACT','A-personal-new','A-enterprise-new']);
 function paint(){const page=document.querySelector('.scene.active');if(!page)return;
  page.querySelectorAll('[data-go]').forEach(button=>{if(!starts.has(button.dataset.go))return;
   if(offline){button.disabled=true;button.dataset.offlineBlocked='true';button.title='联网并重新验证后才能打开';}
   else if(button.dataset.offlineBlocked){delete button.dataset.offlineBlocked;if(!button.dataset.entitlementBlocked)button.disabled=false;button.removeAttribute('title');}
  });
  const scope=page.querySelector('#space-name')?.textContent.includes('我的空间')?'personal':'enterprise';
  page.querySelectorAll('[data-task-close]').forEach(b=>{b.hidden=(b.dataset.closeState==='stopped')!==stopped.has(scope+':'+b.dataset.taskClose)});
  page.querySelectorAll('.runtime-row,.dialog-row').forEach(row=>{
   const key=row.dataset.taskKey;if(!key)return;
   if(!stopped.has(scope+':'+key)){if(row.dataset.stoppedHidden){row.hidden=false;delete row.dataset.stoppedHidden;}return;}
   if(page.dataset.prototypeScene.startsWith('P-M02-CONFIRM')||page.dataset.prototypeScene.startsWith('P-M02-STOPPING')){row.hidden=true;row.dataset.stoppedHidden='true';}
   const state=row.querySelector('.status,.row-state');if(state)state.textContent='已停止';
   const note=row.querySelector('small');if(note)note.textContent='任务已停止；重新打开不会自动执行';
   row.querySelectorAll('button').forEach(b=>{if(['停止','停止任务'].includes(b.textContent.trim()))b.disabled=true;});
  });
 }
 document.addEventListener('click',event=>{const b=event.target.closest('[data-go]');if(!b||b.disabled)return;
  if(offline&&starts.has(b.dataset.go)){event.preventDefault();event.stopImmediatePropagation();return;}
  if(b.dataset.stopTask){const scope=b.closest('.scene').querySelector('#space-name')?.textContent.includes('我的空间')?'personal':'enterprise';stopped.add(scope+':'+b.dataset.stopTask);}
  if(b.dataset.go==='P-M04-REPORT-STOPPED')stopped.add('personal:report');
  if(b.dataset.go==='P-M03-HOME-ENT-AFTER-CLOSE')stopped.add('enterprise:quote');
 },true);
 window.poloPrepareTaskFixture=(scene,reason)=>{
  if(reason==='command'&&window.poloReviewArrival!=='action'&&window.poloReviewArrival!=='system'&&/P-M02-(CONFIRM|STOPPING)/.test(scene)){
   const scope=scene.endsWith('PERSONAL')?'personal':'enterprise';
   for(const key of [...stopped])if(key.startsWith(scope+':'))stopped.delete(key);
  }
 };
 window.poloPaintTaskState=paint;
 window.addEventListener('polo:scope-stopped',event=>{for(const key of ['quote','contract','report'])stopped.add(event.detail.scope+':'+key);paint()});
 window.addEventListener('polo:scene-shown',event=>{
  const {scene,reason,from}=event.detail;
  if(reason==='reset'){setOffline(false,true);stopped.clear();}
  if(reason==='command'&&window.poloReviewArrival!=='action'){
   offline=['P-M11-OFFLINE-HOME','P-M11-OFFLINE-RUNNING','P-M03-HOME-OFFLINE'].includes(scene);if(offline)setOffline(true);
   if(scene==='P-M04-RUNTIME-PERSONAL')stopped.delete('personal:report');
  }
  if(scene==='P-M04-REPORT-STOPPED')stopped.add('personal:report');
  if(['P-M02-STOP-FAILED','P-M02-STOP-CANCEL'].includes(scene)){stopped.add('enterprise:quote');stopped.add('enterprise:contract');}
  if(reason==='action'&&['P-M11-OFFLINE-HOME','P-M03-HOME-OFFLINE','P-M11-OFFLINE-RUNNING'].includes(from)&&scene==='P-M03-HOME-PERSONAL')setOffline(false,true);
  paint();
 });
 if(window===parent)setTimeout(()=>window.dispatchEvent(new CustomEvent('polo:scene-shown',{detail:{scene:document.body.dataset.currentScene,reason:'command'}})),0);
})();
