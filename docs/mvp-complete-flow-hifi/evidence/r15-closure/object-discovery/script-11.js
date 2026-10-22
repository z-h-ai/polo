/* Preview-session entitlements are keyed by circle/work identity. Navigation is
   never a new authorization result; only review entry/reset injects fixtures. */
(() => {
  const joined = {growth:true, design:true, data:true, year:true};
  let designExpiry='2026-11-02';
  window.poloCircleMemberships = joined;
  const works = {meeting:['growth','design'],growth:['growth'],brand:['design'],report:['data']};
  const routes = {'P-M04-APP-VIEW-PERSONAL':'meeting','P-M04-APP-GROWTH':'growth','P-M04-APP-BRAND':'brand','P-M04-APP-REPORT':'report'};
  const allowed = key => !works[key] || works[key].some(source=>joined[source]);
  window.poloWorkAuthorized = allowed;
  let session=null,epoch=0;
  function publish(){if(session)parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'circle-memberships',joined:{...joined}}},'*')}
  window.addEventListener('message',event=>{
    const d=event.data;if(event.source!==parent||d?.version!==1)return;
    if(['product-ui-prototype:show-scene','product-ui-prototype:reset'].includes(d.type)){session=d.session;epoch=d.epoch;publish();}
    if(d.type==='product-ui-prototype:peer'&&d.session===session&&d.channel==='polo-workbench'&&d.payload?.kind==='memberships-state-request')publish();
  });
  function paint() {
    const scene = document.querySelector('.scene.active'); if (!scene) return;
    const sid=scene.dataset.prototypeScene;
    const targets=[...scene.querySelectorAll('[data-circle-kind="design"]')];
    if(sid.startsWith('P-M07-DETAIL-PAID'))targets.push(...scene.querySelectorAll('.circle-heading-meta,.permission-summary'));
    for(const root of targets){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(/2026-(?:11|12)-02/.test(node.textContent))node.textContent=node.textContent.replace(/2026-(?:11|12)-02/g,designExpiry);}

    for (const [key,kind] of [['growth','growth'],['design','design'],['data','data'],['year','annual']]) {
      const card=scene.querySelector(`[data-circle-kind="${kind}"]`);
      if(card&&!joined[key])card.hidden=true;
    }
    scene.querySelectorAll('[data-go]').forEach(button=>{
      const key=routes[button.dataset.go];if(!key)return;
      if(!button.dataset.entitlementLabel)button.dataset.entitlementLabel=button.textContent;
      if(!allowed(key)){
        button.disabled=true;button.dataset.entitlementBlocked='true';button.textContent='已失去授权';
      }else if(button.dataset.entitlementBlocked){
        delete button.dataset.entitlementBlocked;button.disabled=false;button.textContent=button.dataset.entitlementLabel;
      }
    });
  }
  function changed(){window.dispatchEvent(new Event('polo:memberships-changed'));paint();publish();}
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-leave-circle]');
    if(!button||button.disabled||!button.closest('.scene.active'))return;
    joined[button.dataset.leaveCircle]=false;changed();
  },true);
  window.addEventListener('polo:scene-shown',event=>{
    const {scene,reason,from}=event.detail;
    if(reason==='reset'){Object.keys(joined).forEach(k=>joined[k]=true);designExpiry='2026-11-02';}
    if(reason==='action'){
      if(scene==='P-M07-DETAIL-FOCUS'&&['P-M07-RETURN','P-M07-RETURN-FAIL'].includes(from))joined.growth=true;
      if((scene==='P-M07-DETAIL-PAID'&&from==='P-M07-PAY-RETURN')||(scene==='P-M07-RENEW-RESULT'&&from==='P-M07-RENEW-RETURN'))joined.design=true;
      if(scene==='P-M07-RENEW-RESULT'&&from==='P-M07-RENEW-RETURN')designExpiry='2026-12-02';
      if(scene==='P-M07-YEAR-RESULT'&&from==='P-M07-YEAR-RETURN')joined.year=true;
    }
    // Historical deep links seed their stated result, without undoing other exits.
    if(reason==='command'&&window.poloReviewArrival!=='action'){
      if(['P-M07-LIST-RENEWED','P-M07-RENEW-RESULT'].includes(scene))designExpiry='2026-12-02';
      if(scene==='P-M07-SOURCE-FALLBACK')joined.growth=false;
      if(['P-M07-DETAIL-PAID-AFTER-LEAVE','P-M07-EXPIRED','P-M11-BLOCKED-EXPIRED'].includes(scene))joined.design=false;
    }
    changed();
  });
  window.addEventListener('polo:memberships-changed',paint);
  // Also guard dispatch, so cached controls cannot bypass a revoked source.
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-go]'),key=button&&routes[button.dataset.go];
    if(key&&!allowed(key)){event.preventDefault();event.stopImmediatePropagation();paint();}
  },true);
})();
