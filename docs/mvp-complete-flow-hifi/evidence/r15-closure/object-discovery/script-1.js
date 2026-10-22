
(()=>{'use strict';
const manifest=JSON.parse(document.getElementById('prototype-manifest').textContent);
const byScene=new Map(manifest.scenes.map(scene=>[scene.id,scene]));
const elements=new Map([...document.querySelectorAll('[data-prototype-scene]')].map(el=>[el.dataset.prototypeScene,el]));
let current=manifest.start_scene, session=null, epoch=-1, sequence=0, scheduled=false, revealed=null, hintSpec=null;
const scrolls=new Map();
const initialValues=[...document.querySelectorAll('input,textarea,select')].map(el=>({el,value:el.value,checked:el.checked}));
function settings(d){if(manifest.target.themes.includes(d.theme))document.body.dataset.theme=d.theme;if((manifest.target.languages||[]).includes(d.language))document.documentElement.lang=d.language;if(typeof d.perspective==='string'&&(!d.perspective||manifest.scenes.some(s=>s.perspective===d.perspective)))document.body.dataset.perspective=d.perspective}
function send(type,extra={}){if(session)window.parent.postMessage({type:`product-ui-prototype:${type}`,version:1,session,epoch,scene:current,...extra},'*')}
// r12 surface routing: standalone handoff and embedded action reports.
function show(id,reason='command',transition=null){id=manifest.aliases?.[id]||id;if(!byScene.has(id))return;
 if(byScene.get(id).surface==='assistant'){
  if(window===parent){location.replace('../../design-demos/polo-client-source-baseline/prototype.html?scene='+encodeURIComponent(id));return}
  send('scene-change',{scene:id,reason,from:current,transition});return;
 }const from=current;if(id!==current)scrolls.set(current,{x:scrollX,y:scrollY});elements.forEach((el,key)=>el.classList.toggle('active',key===id));current=id;document.body.dataset.currentScene=id;if(id!==from){const saved=scrolls.get(id)||{x:0,y:0};window.scrollTo(saved.x,saved.y)}send('scene-change',{reason,from,transition});window.dispatchEvent(new CustomEvent('polo:scene-shown',{detail:{scene:id,from,reason}}));measure()}
function rect(r){return {x:r.x,y:r.y,width:r.width,height:r.height}}
function clipTo(a,b,x=true,y=true){const left=x?Math.max(a.x,b.x):a.x,top=y?Math.max(a.y,b.y):a.y;return {x:left,y:top,width:Math.max(0,(x?Math.min(a.x+a.width,b.x+b.width):a.x+a.width)-left),height:Math.max(0,(y?Math.min(a.y+a.height,b.y+b.height):a.y+a.height)-top)}}
function target(a){return [...elements.get(current).querySelectorAll('[data-review-anchor]')].find(el=>el.dataset.reviewAnchor===a.anchor)}
function measureElement(el){const zero={x:0,y:0,width:0,height:0};if(!el)return {state:'hidden',rect:zero,clip:zero};const r=rect(el.getBoundingClientRect());let clip=r,hidden=!el.getClientRects().length||r.width===0||r.height===0;
 for(let parent=el;parent;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)hidden=true;if(parent!==el&&parent!==document.documentElement&&parent!==document.body){const p=parent.getBoundingClientRect();clip=clipTo(clip,{x:p.x+parent.clientLeft,y:p.y+parent.clientTop,width:parent.clientWidth,height:parent.clientHeight},/(auto|scroll|hidden|clip)/.test(style.overflowX),/(auto|scroll|hidden|clip)/.test(style.overflowY))}}
 clip=clipTo(clip,{x:0,y:0,width:innerWidth,height:innerHeight});clip.x=Math.min(innerWidth,Math.max(0,clip.x));clip.y=Math.min(innerHeight,Math.max(0,clip.y));return {state:hidden?'hidden':clip.width>0&&clip.height>0?'visible':'offscreen',rect:r,clip:hidden?zero:clip}}
function geometry(a){return {id:a.id,...measureElement(target(a))}}
// The review console may ask one declared transition control to be reported as the next-step hint target.
function parseHint(hint,sceneId){if(!hint)return null;if(typeof hint!=='object'||typeof hint.transition!=='string'||typeof hint.scene!=='string')return null;const scene=byScene.get(sceneId);return scene&&scene.transitions.some(edge=>edge.id===hint.transition&&edge.to===hint.scene)?{transition:hint.transition,scene:hint.scene}:null}
function hintTarget(){if(!hintSpec)return null;const el=[...elements.get(current).querySelectorAll('[data-go]')].find(el=>el.dataset.go===hintSpec.scene&&el.dataset.transition===hintSpec.transition);return {id:hintSpec.transition,...measureElement(el)}}
function measure(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;send('positions',{sequence:++sequence,width:innerWidth,height:innerHeight,targets:(byScene.get(current).annotations||[]).filter(a=>a.anchor).map(geometry),hint:hintTarget(),revealed});revealed=null})}
document.addEventListener('click',event=>{send('dismiss',{keyboard:false});const action=event.target.closest('[data-go]');if(!action)return;const edge=byScene.get(current).transitions.find(item=>item.id===action.dataset.transition&&item.to===action.dataset.go);if(edge){const commit=()=>show(edge.to,'action',edge.id);if(!window.poloSwitchGate?.({from:current,to:edge.to,commit}))commit()}});
window.addEventListener('polo:system-result',event=>{const {from,to}=event.detail||{};if(from===current&&window.poloSpaceSwitchResults?.[from]?.includes(to))show(to,'system')});
document.addEventListener('keydown',event=>{if(event.key==='Escape')send('dismiss',{keyboard:true})});
window.addEventListener('message',event=>{
 if(event.source!==window.parent)return;const d=event.data;if(!d||d.version!==1||typeof d.session!=='string'||d.session.length>200||!Number.isSafeInteger(d.epoch)||d.epoch<0||!byScene.has(d.scene))return;
 if(d.type==='product-ui-prototype:suspend'&&d.session===session&&d.epoch>=epoch){window.dispatchEvent(new Event('polo:surface-suspended'));return;}
 window.poloReviewArrival=d.arrival||'review';
 const allowed=['show-scene','measure','reveal','settings','reset'].map(type=>`product-ui-prototype:${type}`);if(!allowed.includes(d.type))return;
 if(session&&d.session!==session)return;if(d.epoch<epoch)return;if(d.epoch>epoch&&!['product-ui-prototype:show-scene','product-ui-prototype:measure','product-ui-prototype:reset'].includes(d.type))return;
 session=d.session;epoch=d.epoch;
 if(d.type==='product-ui-prototype:show-scene'){hintSpec=parseHint(d.hint,d.scene);settings(d);show(d.scene);return}
 if(d.type==='product-ui-prototype:reset'){initialValues.forEach(({el,value,checked})=>{el.value=value;if(typeof checked==='boolean')el.checked=checked});scrolls.clear();document.querySelectorAll('*').forEach(el=>{if(el.scrollTop||el.scrollLeft)el.scrollTo(0,0)});settings(d);show(d.scene,'reset');window.scrollTo(0,0);return}
 if(d.scene!==current)return;
 if(d.type==='product-ui-prototype:settings')settings(d);
 if(d.type==='product-ui-prototype:reveal'){const a=(byScene.get(current).annotations||[]).find(a=>a.id===d.annotation&&a.anchor);if(!a)return;const g=geometry(a);if(g.state!=='hidden')target(a).scrollIntoView({block:'center',inline:'center',behavior:'instant'});revealed=a.id}
 measure();
});
window.addEventListener('scroll',measure,{capture:true,passive:true});window.addEventListener('resize',measure);
new MutationObserver(measure).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
const observer=new ResizeObserver(measure);observer.observe(document.body);document.querySelectorAll('[data-review-anchor]').forEach(el=>observer.observe(el));
// Position-only CSS motion does not necessarily trigger ResizeObserver.
setInterval(measure,200);
// Standalone direct-open fallback only (?scene=&theme=&lang=&perspective=): when embedded in the
// review console, all scene/state/branch control arrives through the postMessage channel instead.
const query=new URLSearchParams(location.search),hash=new URLSearchParams(location.hash.slice(1));const requested=manifest.aliases?.[hash.get('scene')||query.get('scene')]||hash.get('scene')||query.get('scene');settings({theme:query.get('theme')||manifest.target.themes[0],language:query.get('lang'),perspective:query.get('perspective')});show(byScene.has(requested)?requested:manifest.start_scene,'ready');
})();
