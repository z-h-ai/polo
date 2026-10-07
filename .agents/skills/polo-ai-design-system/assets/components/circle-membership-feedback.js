/* Preview-session entitlements are keyed by circle/work identity. Navigation is
   never a new authorization result; only review entry/reset injects fixtures. */
(() => {
  const joined = {growth:true, design:true, data:true, year:true};
  let designExpiry='2026-11-02';
  // Fixed authoritative quote fixtures for the demo's 2026-10-02 confirmation
  // instant. The desktop consumes server periods, never computes month lengths.
  const monthlyPeriods=['2026-11-02','2026-12-02','2027-01-02','2027-02-02','2027-03-02','2027-04-02','2027-05-02','2027-06-02','2027-07-02','2027-08-02','2027-09-02','2027-10-02'];
  const monthlyQuotes=monthlyPeriods.slice(0,-1).map((start,i)=>({start,end:monthlyPeriods[i+1],id:'SUB-20261002-'+String(183+i).padStart(4,'0')}));
  let renewalQuote=monthlyQuotes[0],renewalOrder=monthlyQuotes[0],renewalResult=monthlyQuotes[0];
  const quoteForCurrent=()=>monthlyQuotes.find(q=>q.start===designExpiry)||null;
  const period=q=>q.start+' 至 '+q.end;
const left=new Set();const baselineText=new WeakMap();
  window.poloCircleMemberships = joined;const relations={};window.poloCircleRelations=relations;
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
    const sid=scene.dataset.prototypeScene;for(const k of Object.keys(joined))relations[k]=left.has(k)?'left':joined[k]?'active':'expired';
    const targets=[...scene.querySelectorAll('[data-circle-kind="design"]')];
    if(sid.startsWith('P-M07-DETAIL-PAID')||['P-M07-LEAVE-PAID','P-M07-RENEW'].includes(sid))targets.push(...scene.querySelectorAll('.circle-heading-meta,.permission-summary'));
    for(const root of targets){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(!baselineText.has(node))baselineText.set(node,node.textContent);node.textContent=baselineText.get(node).replace(/2026-(?:(?:11|12)-02|09-01)/g,designExpiry);}}

    const quote=sid==='P-M07-RENEW-WEB'?renewalOrder:renewalQuote;
    const relation=left.has('design')?'left':joined.design?'active':'expired';
    scene.querySelectorAll('[data-design-renewal-entry]').forEach(el=>el.hidden=el.dataset.designRenewalEntry!==relation);
    scene.querySelectorAll('[data-renewal-quote-period]').forEach(el=>el.textContent=relation==='left'?'已退出圈子，请重新加入':relation==='expired'?'本圈来源已到期，需重新核对付款起算日':quote?period(quote):'当前权益已达提前购买上限');
    scene.querySelectorAll('[data-renewal-pay]').forEach(el=>{el.disabled=relation!=='active'||!renewalQuote;el.hidden=relation!=='active';});
    scene.querySelectorAll('[data-renewal-limit]').forEach(el=>el.hidden=relation!=='active'||!!renewalQuote);
    scene.querySelectorAll('[data-renewal-order]').forEach(el=>el.textContent=(sid==='P-M07-RENEW-RESULT'?renewalResult:renewalOrder).id);
    scene.querySelectorAll('[data-renewal-result-period]').forEach(el=>el.textContent=period(renewalResult));
    scene.querySelectorAll('[data-renewal-result-expiry]').forEach(el=>el.textContent=designExpiry);

    for (const [key,kind] of [['growth','growth'],['design','design'],['data','data'],['year','annual']]) {
      const card=scene.querySelector(`[data-circle-kind="${kind}"]`);
      if(card){card.dataset.membershipState=joined[key]?'valid':'restore';card.hidden=left.has(key);if(key==='design'){card.querySelectorAll('[data-circle-detail-state]').forEach(b=>b.hidden=b.dataset.circleDetailState!==card.dataset.membershipState);if(!joined[key]){const term=card.querySelector('.circle-term');if(term)term.textContent='月度订阅 · 已到期（'+designExpiry+'）';}}const state=card.querySelector('.status');if(state){state.dataset.originalMembershipText ||= state.textContent;state.textContent=!joined[key]&&!left.has(key)?'已到期':state.dataset.originalMembershipText;}}
    }
    scene.querySelectorAll('[data-circle-exit-impact]').forEach(el=>{const key=el.dataset.circleExitImpact,other=key==='growth'?'design':'growth',name=key==='growth'?'晨星增长圈':'晨星设计圈';el.textContent='只撤销'+name+'这一来源；'+(joined[other]?'会议纪要整理仍有其他有效来源，可继续使用。':'会议纪要整理将失去最后一个有效来源，不能再启动。')+'仅此圈提供的作品将不可用。'});
    scene.querySelectorAll('[data-circle-exit-result]').forEach(el=>{el.textContent='已退出晨星增长圈；'+(joined.design?'晨星设计圈的授权仍然有效。':'会议纪要整理已没有有效来源，恢复任一来源后才可使用。')});
    scene.querySelectorAll('[data-circle-shared-state]').forEach(el=>{el.textContent=allowed('meeting')?'仍有其他有效来源可用':'最后一个有效来源已失效'});
    if(sid.startsWith('P-M07-DETAIL-PAID')&&!joined.design){const status=scene.querySelector('.circle-heading-meta .status');if(status)status.textContent=left.has('design')?'已退出':'已到期';scene.querySelectorAll('.circle-heading-meta').forEach(root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode())if(/(?:有效至|付费订阅|¥39).*2026|付费订阅/.test(n.textContent))n.textContent=left.has('design')?'成员资格已结束':'本圈来源已到期';});}
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
    joined[button.dataset.leaveCircle]=false;left.add(button.dataset.leaveCircle);changed();
  },true);
  window.addEventListener('polo:scene-shown',event=>{
    const {scene,reason,from}=event.detail;
    if(reason==='reset'){Object.keys(joined).forEach(k=>joined[k]=true);designExpiry='2026-11-02';renewalQuote=renewalOrder=renewalResult=monthlyQuotes[0];left.clear();}
    if(reason==='action'){
      if(scene==='P-M07-RENEW')renewalQuote=quoteForCurrent();
      if(scene==='P-M07-RENEW-WEB'&&from==='P-M07-RENEW'&&renewalQuote)renewalOrder=renewalQuote;

      if(scene==='P-M07-DETAIL-FOCUS'&&['P-M07-RETURN','P-M07-RETURN-FAIL'].includes(from)){joined.growth=true;left.delete('growth');}
      if(scene==='P-M07-DETAIL-PAID'&&from==='P-M07-PAY-RETURN'){joined.design=true;left.delete('design');} if(scene==='P-M07-RENEW-RESULT'&&from==='P-M07-RENEW-RETURN'&&!left.has('design'))joined.design=true;
      if(scene==='P-M07-DETAIL-PAID'&&from==='P-M07-PAY-RETURN')designExpiry=designExpiry<'2026-11-02'?'2026-11-02':designExpiry;
      if(scene==='P-M07-RENEW-RESULT'&&from==='P-M07-RENEW-RETURN'){renewalResult=renewalOrder;designExpiry=designExpiry<renewalOrder.end?renewalOrder.end:designExpiry;}
      if(scene==='P-M07-YEAR-RESULT'&&from==='P-M07-YEAR-RETURN'){joined.year=true;left.delete('year');}
    }
    // Historical deep links seed their stated result, without undoing other exits.
    if(reason==='command'&&window.poloReviewArrival!=='action'){
      if(['P-M07-LIST-RENEWED','P-M07-RENEW-RESULT'].includes(scene)){designExpiry='2026-12-02';renewalOrder=renewalResult=monthlyQuotes[0];}
      if(scene==='P-M07-RENEW')renewalQuote=quoteForCurrent();
      if(scene==='P-M07-RENEW-LIMIT'){designExpiry='2027-10-02';renewalOrder=renewalResult=monthlyQuotes[monthlyQuotes.length-1];renewalQuote=null;}

      if(scene==='P-M07-SOURCE-FALLBACK'){joined.growth=false;left.add('growth');}
      if(scene==='P-M07-DETAIL-PAID-AFTER-LEAVE')left.add('design');
      if(scene==='P-M11-BLOCKED-EXPIRED')joined.growth=false;
      if(['P-M07-EXPIRED','P-M07-RENEW-EXPIRED','P-M11-BLOCKED-EXPIRED'].includes(scene)){designExpiry='2026-09-01';joined.design=false;}
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
