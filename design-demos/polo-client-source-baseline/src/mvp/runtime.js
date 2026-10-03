import { byId, resolveScene, id } from './scenes.mjs'
let current = id('personal','new'), session=null, epoch=-1, sequence=0, hint=null
let settings={theme:'light',language:'zh-CN'}, resetVersion=0
const listeners=new Set(), drafts=new Map(), submitted=new Map(), attachments=new Map(), attachmentContents=new Map()
const sessions={personal:'draft',enterprise:'saved'}, counters={personal:0,enterprise:0}
const contexts={personal:{blocks:new Set(),denied:new Set(),role:'member',creditOrigin:'preblock',skill:null,circleSources:null,sourceStatus:null,running:false},enterprise:{blocks:new Set(),denied:new Set(),role:'member',creditOrigin:'preblock',skill:null,circleSources:null,sourceStatus:null,running:false}}
const preferenceDefaults={send:'enter',spell:true,name:'小王',answer:'',labels:'工作、资料整理',read:'ask',write:'ask',command:'ask'}
const preferences={personal:{saved:{...preferenceDefaults},draft:{...preferenceDefaults}},enterprise:{saved:{...preferenceDefaults},draft:{...preferenceDefaults}}}
export const getPreferences=scope=>({...preferences[scope].draft})
export const changePreference=(scope,key,value)=>{preferences[scope].draft[key]=value}
export const savePreferences=scope=>{preferences[scope].saved={...preferences[scope].draft}}
export const preferencesDirty=scope=>JSON.stringify(preferences[scope].saved)!==JSON.stringify(preferences[scope].draft)
export const discardPreferences=scope=>{preferences[scope].draft={...preferences[scope].saved}}
let pending=null
const transferDrafts=new Map(), imported=new Map(), importRecords=new Map(), transferResults=new Map();let transferCounter=0,transferSelectionVersion=0
const storageKey=(scope,key='conversation')=>key==='source-auth'?`${scope}:source-auth`:`${scope}:${sessions[scope]}:${key}`
export const getConversationId=scope=>sessions[scope]
export const getImportedMessages=scope=>imported.get(storageKey(scope))||null
export const getImportedConversations=scope=>[...importRecords.values()].filter(r=>r.scope===scope)
export const getImportedTitle=scope=>importRecords.get(scope+':'+sessions[scope])?.title
export const selectImportedConversation=(scope,conversation)=>{if(importRecords.has(scope+':'+conversation)){sessions[scope]=conversation;act('open-imported')}}
export const getTransferDraft=scope=>transferDrafts.get(scope)||null
export const getTransferResult=scope=>transferResults.get(scope)||null
export const transferSelectionToken=()=>`${current}:${epoch}:${resetVersion}:${++transferSelectionVersion}`
export function selectTransferFile(scope,text,token){
 if(token!==`${current}:${epoch}:${resetVersion}:${transferSelectionVersion}`||current!==id(scope,'transfer-import'))return;
 try{const data=JSON.parse(text);if(data.format!=='polo-conversation-content-v1'||!Array.isArray(data.messages)||!data.messages.length||data.messages.length>200||data.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>20000))throw Error('format');
  transferDrafts.set(scope,{messages:data.messages.map(({role,text})=>({role,text})),title:typeof data.title==='string'?data.title.slice(0,100):'导入的对话'});
  act('select-import');
 }catch{transferDrafts.set(scope,{error:'文件格式不受支持，未导入任何内容。'});notify();}
}

export const getActivity=scope=>({running:!!contexts[scope].running,session:contexts[scope].runningSession})
export const isSavedConversation=scope=>sessions[scope]==='saved'
export const getSourceStatus=scope=>contexts[scope].sourceStatus||'connected'
export const canSend=scope=>!contexts[scope].blocks.size&&!contexts[scope].denied.has(sessions[scope])
export const canRead=scope=>!contexts[scope].blocks.has('governance')&&!contexts[scope].revoked&&!contexts[scope].denied.has(sessions[scope])
export const blockingText=scope=>[...contexts[scope].blocks].map(k=>({credits:'积分不足',budget:'企业预算已达上限',offline:'网络未恢复',governance:'当前企业治理限制尚未解除',membership:'已失去企业访问资格',permission:'需要访问权限'}[k])).join('；')
function fixture(scene){
 const c=contexts[scene.scope],k=scene.key
 if(['generating','question','reopen','answered','close','closefailed'].includes(k)){c.running=true;c.runningSession=sessions[scene.scope]}
 if(['stopped','cut','completezero','preblock'].includes(k))c.running=false
 const sourceState={sources:'connected',sourceauth:'auth',sourcefailed:'failed',sourcedenied:'denied',sourcedisconnected:'disconnected',sourceconnecting:'connecting'}[k];if(sourceState)c.sourceStatus=sourceState
 if(k.startsWith('owner')||k.startsWith('budget')&&k!=='budget'&&!k.startsWith('budgetmember')&&k!=='budgetnotified'){c.role='owner';c.roleKnown=true;}
 if(['notify','budget','budgetnotified'].includes(k)||k.startsWith('budgetmember')){c.role='member';c.roleKnown=true;}
 if(['preblock','cut'].includes(k))c.creditOrigin=k
 if(['new'].includes(k))sessions[scene.scope]='draft'
 if(['conversation','question','reopen','expired','deleted','files','missing'].includes(k))sessions[scene.scope]='saved'
 if(['preblock','cut','notify','ownerblock'].includes(k)){c.blocks.add('credits');c.creditsKnown=true;}
 if(['budget','budgetowner'].includes(k))c.blocks.add('budget')
 if(k==='offline')c.blocks.add('offline')
 if(['permission','permissiondenied'].includes(k))c.blocks.add('permission')
 if(k==='restored')c.blocks.delete('offline')
 if(['resumed','resumedstream','ownerresumed'].includes(k)){c.blocks.delete('credits');c.creditsKnown=true;}
 if(['budgetresumed','budgetmemberresumed'].includes(k))c.blocks.delete('budget')
 if(k==='permissiongranted')c.blocks.delete('permission')
 if(k==='deleted')c.denied.add(sessions[scene.scope])
 if(scene.family==='skills'&&scene.authorization)c.skill=Object.fromEntries(['authorization','enabled','device','version','builtin'].map(k=>[k,scene[k]??(k==='builtin'?true:undefined)]))
}

let snapshot={scene:byId.get(current),settings,resetVersion}
const effectiveScene=()=>{const s=byId.get(current),c=contexts[s.scope];return s.family==='skills'&&c.skill?{...s,...c.skill}:s}
export const getSkillSourceText=scope=>scope==='enterprise'?'晨星科技 · 企业共享':contexts.personal.circleSources?contexts.personal.circleSources.map(([name,valid])=>name+(valid?'':'（已失效）')).join(' / '):'晨星增长圈 / 晨星设计圈'
function receiveMemberships(joined){
 if(typeof joined?.growth!=='boolean'||typeof joined?.design!=='boolean')return;
 const c=contexts.personal;
 if(!joined.growth||!joined.design||c.circleSources){
  c.circleSources=[['晨星增长圈',joined.growth],['晨星设计圈',joined.design]];
  if(!c.skill)c.skill={authorization:'有效',enabled:false,device:'未安装',version:'1.0.0',builtin:true};
  c.skill.authorization=joined.growth&&joined.design?'有效':joined.growth||joined.design?'另一来源有效':'已失效';
  if(c.skill.authorization==='已失效')c.skill.enabled=false;
  notify();
 }
}
const notify=()=>{if(session)publishActivity();snapshot={scene:effectiveScene(),settings,resetVersion};listeners.forEach(f=>f());requestAnimationFrame(measure)}
export const subscribe=f=>{listeners.add(f);return()=>listeners.delete(f)}
export const getSnapshot=()=>snapshot
export const getDraft=(scope,key='conversation')=>drafts.get(storageKey(scope,key))||''
export const setDraft=(scope,value,key='conversation')=>drafts.set(storageKey(scope,key),value)
export const getSubmitted=scope=>submitted.get(storageKey(scope))||[]
export const getAttachment=scope=>attachments.get(storageKey(scope))
export const getAttachmentContent=scope=>attachmentContents.get(storageKey(scope))
export const setAttachment=(scope,name,content=null)=>{attachments.set(storageKey(scope),name);attachmentContents.set(storageKey(scope),content);notify()}
export function actionEnabled(scope,key){
 const c=contexts[scope],skill=c.skill||byId.get(current)
 if(key==='enablebuiltin')return skill.builtin===false
 if(key==='disablebuiltin')return skill.builtin!==false
 if(['viewactivity','stopactivity'].includes(key))return !!c.running
 if(key==='closeidle')return !c.running
 if(key==='closeactive')return c.running
 if(['enable','disable','install','update','remove','confirmremove'].includes(key)&&byId.get(current).family==='skills'){
  const authorized=['有效','另一来源有效'].includes(skill.authorization)
  if(key==='enable')return authorized&&!skill.enabled
  if(key==='disable')return !!skill.enabled
  if(key==='install')return authorized&&!['就绪','准备中'].includes(skill.device)
  if(key==='update')return authorized&&skill.device==='就绪'&&skill.version!=='1.1.0'
  if(key==='remove'||key==='confirmremove')return ['就绪','保留副本'].includes(skill.device)
 }
 if(key==='confirm-import')return !!transferDrafts.get(scope)?.messages&&canRead(scope);
 if(key==='open-imported')return getImportedConversations(scope).length>0;
 if(key==='view-imported')return !!transferResults.get(scope);
 if(key==='export-content'||key==='export')return canRead(scope)&&(isSavedConversation(scope)||!!getImportedMessages(scope)?.length||!!getSubmitted(scope).length);
 if(key==='view')return canRead(scope)&&isSavedConversation(scope)
 if(key==='attachment')return canRead(scope)&&(isSavedConversation(scope)||!!getAttachment(scope))
 if(key==='recovery')return c.blocks.size>0
 if(key==='credit-pre'||key==='credit-cut')return scope==='personal'&&c.blocks.has('credits')&&c.creditOrigin===(key==='credit-cut'?'cut':'preblock')
 if(key==='credit-owner'||key==='credit-member')return c.blocks.has('credits')&&(key==='credit-owner'?c.role==='owner':c.role!=='owner')
 if(key==='budget-owner'||key==='budget-member')return c.blocks.has('budget')&&(key==='budget-owner'?c.role==='owner':c.role!=='owner')
 if(key==='network')return c.blocks.has('offline')
 if(key==='permission')return c.blocks.has('permission')
 return true
}
const send=(type,extra={})=>{if(session)parent.postMessage({type:`product-ui-prototype:${type}`,version:1,session,epoch,scene:current,...extra},'*')}
function publishActivity(request=null){if(session&&contexts.enterprise.roleKnown)parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'assistant-enterprise-role',role:contexts.enterprise.role}},'*');if(session&&contexts.enterprise.creditsKnown)parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'enterprise-credit-state',blocked:contexts.enterprise.blocks.has('credits')}},'*');if(session)parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'assistant-activity',request,states:Object.fromEntries(Object.entries(contexts).map(([scope,c])=>[scope,{running:!!c.running}]))}},'*')}
export function act(key){
 const scene=effectiveScene(),edge=scene.transitions.find(t=>t.key===key);if(!edge||!actionEnabled(scene.scope,key))return
 if(['send','answer'].includes(key)&&!canSend(scene.scope))return
 if(key!=='select-import')transferSelectionVersion++
 if(key==='files'&&!canRead(scene.scope))return
 if(['send','answer'].includes(key)){contexts[scene.scope].running=true;contexts[scene.scope].runningSession=sessions[scene.scope]}
 if(['viewactivity','stopactivity'].includes(key)&&contexts[scene.scope].runningSession)sessions[scene.scope]=contexts[scene.scope].runningSession
 if(['stop','stopclose','stopactivity'].includes(key))contexts[scene.scope].running=false
 if(key==='network'||key==='retry'&&scene.key==='offline'){contexts[scene.scope].blocks.delete('offline');if(session)parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'network-revalidated'}},'*')}
 if(key==='allow')contexts[scene.scope].blocks.delete('permission')
 if(key==='new')sessions[scene.scope]='new-'+(++counters[scene.scope])
 if(key==='sessions'||key==='original')sessions[scene.scope]='saved'
 if(['send','answer'].includes(key)){
  const draftKey=key==='answer'?'question':'conversation',value=getDraft(scene.scope,draftKey).trim();if(!value)return
  submitted.set(storageKey(scene.scope),[...getSubmitted(scene.scope),value]);setDraft(scene.scope,'',draftKey)
 }
 if(key==='export-content'){
  const prior=getImportedMessages(scene.scope),sent=getSubmitted(scene.scope).map(text=>({role:'user',text}));
  const messages=[...(prior||(isSavedConversation(scene.scope)?[{role:'user',text:scene.scope==='personal'?'请整理这份资料，保留关键结论。':'请汇总本周企业项目进展。'},{role:'assistant',text:'已整理第一部分：本周的主要进展与后续待办。'}]:[])),...sent];
  const data={format:'polo-conversation-content-v1',title:'导出的对话',messages};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='Polo-对话内容.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 if(key==='confirm-import'){
  const draft=transferDrafts.get(scene.scope);if(!draft?.messages||!canRead(scene.scope))return;
  const newId='imported-'+(++transferCounter);sessions[scene.scope]=newId;imported.set(storageKey(scene.scope),draft.messages);const record={id:newId,scope:scene.scope,title:draft.title,count:draft.messages.length,preview:draft.messages[0].text.slice(0,40)};importRecords.set(scene.scope+':'+newId,record);transferResults.set(scene.scope,record);transferDrafts.delete(scene.scope);
 }
 if(key==='view-imported'){const result=transferResults.get(scene.scope);if(result)sessions[scene.scope]=result.id;}
 if(['cancel-transfer','retry-import'].includes(key))transferDrafts.delete(scene.scope);
 const destination=byId.get(edge.to),context=contexts[scene.scope]
 if(scene.family==='sources'){if(key==='auth')context.sourceStatus='auth';if(key==='connect')context.sourceStatus=scene.key==='sourcedisconnected'?'auth':'connecting';if(key==='cancel')context.sourceStatus='disconnected'}
 if(scene.family==='skills'){
  if(!context.skill&&scene.authorization)context.skill={authorization:scene.authorization,enabled:scene.enabled,device:scene.device,version:scene.version,builtin:scene.builtin!==false}
  if(context.skill){
   if(key==='enable')context.skill.enabled=true
   if(key==='disable')context.skill.enabled=false
   if(key==='install')context.skill.device='准备中'
   if(key==='update')context.skill.version='1.1.0'
   if(key==='confirmremove')context.skill.device='未安装'
   if(key==='enablebuiltin')context.skill.builtin=true
   if(key==='disablebuiltin')context.skill.builtin=false
  }
 }
 if(destination?.family==='skills'&&!context.skill&&destination.authorization)context.skill={authorization:destination.authorization,enabled:destination.enabled,device:destination.device,version:destination.version,builtin:destination.builtin!==false}
 pending=edge.to
 publishActivity()
 send('scene-change',{scene:edge.to,from:current,transition:edge.id,reason:'action'})
 if(!session){
  if(byId.has(edge.to)){current=edge.to;const url=new URL(location.href);url.searchParams.set('scene',current);history.replaceState(null,'',url);notify()}
  else location.href=`../../docs/mvp-complete-flow-hifi/prototype.html#scene=${encodeURIComponent(edge.to)}`
 }
}
const zero={x:0,y:0,width:0,height:0}
function geometry(el){
 if(!el)return {state:'hidden',rect:zero,clip:zero}
 const r=el.getBoundingClientRect(),rect={x:r.x,y:r.y,width:r.width,height:r.height}
 let l=Math.max(0,r.left),t=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom),hidden=!el.getClientRects().length
 for(let p=el;p;p=p.parentElement){const css=getComputedStyle(p);if(css.display==='none'||css.visibility==='hidden')hidden=true;if(p!==el){const q=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(css.overflowX)){l=Math.max(l,q.left);right=Math.min(right,q.right)}if(/auto|scroll|hidden|clip/.test(css.overflowY)){t=Math.max(t,q.top);bottom=Math.min(bottom,q.bottom)}}}
 const clip={x:Math.min(innerWidth,l),y:Math.min(innerHeight,t),width:Math.max(0,right-l),height:Math.max(0,bottom-t)}
 return {state:hidden?'hidden':clip.width&&clip.height?'visible':'offscreen',rect,clip:hidden?zero:clip}
}
function measure(){
 const control=hint?[...document.querySelectorAll('[data-transition]')].find(e=>e.dataset.transition===hint.transition):null
 send('positions',{sequence:++sequence,width:innerWidth,height:innerHeight,targets:[],hint:hint?{id:hint.transition,...geometry(control)}:null})
}
export function installReviewBridge(){
 if(typeof window==='undefined')return
 const requested=resolveScene(new URLSearchParams(location.hash.slice(1)).get('scene')||new URLSearchParams(location.search).get('scene'))
 if(window===parent&&byId.has(requested)){current=requested;fixture(byId.get(current));notify()}
 window.addEventListener('message',e=>{
  const d=e.data;
  if(e.source===parent&&d?.type==='product-ui-prototype:peer'&&d.version===1&&d.session===session&&d.channel==='polo-workbench'){
   const p=d.payload;if(p?.kind==='verified-enterprise-role'&&['owner','member','manager'].includes(p.role)){if(contexts.enterprise.role!==p.role||!contexts.enterprise.roleKnown){contexts.enterprise.role=p.role;contexts.enterprise.roleKnown=true;notify();}return}if(p?.kind==='app-credit-blocked'){contexts.enterprise.blocks.add('credits');contexts.enterprise.creditsKnown=true;contexts.enterprise.running=false;notify();return}if(p?.kind==='credit-snapshot'){if(contexts.enterprise.creditsKnown)return;if(p.blocked){contexts.enterprise.blocks.add('credits');contexts.enterprise.creditsKnown=true;contexts.enterprise.running=false;}else if(p.verified){contexts.enterprise.blocks.delete('credits');contexts.enterprise.creditsKnown=false;}notify();return}if(p?.kind==='enterprise-eligibility'){if(p.governance){contexts.enterprise.blocks.add('governance');contexts.enterprise.running=false;}else contexts.enterprise.blocks.delete('governance');contexts.enterprise.revoked=p.revoked===true;if(p.revoked){contexts.enterprise.blocks.add('membership');contexts.enterprise.running=false;}else contexts.enterprise.blocks.delete('membership');notify();return}if(p?.kind==='network-state'){for(const c of Object.values(contexts)){if(p.offline===true)c.blocks.add('offline');else if(p.offline===false&&p.verified===true)c.blocks.delete('offline')}notify();return}if(p?.kind==='circle-memberships'){receiveMemberships(p.joined);return}if(p?.kind==='activity-state-request'){publishActivity();return}if(p?.kind==='stop-assistant-scope'&&['personal','enterprise'].includes(p.scope)&&typeof p.request==='string'){contexts[p.scope].running=false;publishActivity(p.request);notify()}return
  }
  if(e.source!==parent||!d||d.version!==1||typeof d.session!=='string'||d.session.length>200||!Number.isSafeInteger(d.epoch)||d.epoch<0||!byId.has(d.scene))return
  if(!['show-scene','settings','reset','measure','reveal'].some(t=>d.type===`product-ui-prototype:${t}`)||session&&session!==d.session||d.epoch<epoch)return
  if(d.epoch>epoch&&!['show-scene','reset','measure'].some(t=>d.type===`product-ui-prototype:${t}`))return
  if(['settings','reveal','measure'].some(t=>d.type===`product-ui-prototype:${t}`)&&d.scene!==current)return
  session=d.session;epoch=d.epoch
  if(d.type==='product-ui-prototype:show-scene')for(const kind of ['eligibility-state-request','credit-state-request','role-state-request'])parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind}},'*')
  if(d.type==='product-ui-prototype:show-scene')parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'memberships-state-request'}},'*')
  if(d.type==='product-ui-prototype:show-scene')parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'network-state-request'}},'*')
  if(['show-scene','reset'].some(t=>d.type===`product-ui-prototype:${t}`)){
   const changed=current!==d.scene
   if(changed)transferSelectionVersion++
   current=d.scene
   if(pending===current)pending=null
   else if(changed&&d.arrival!=='action')fixture(byId.get(current))
   else if(d.arrival==='action'){const sc=byId.get(current);if(sc.key==='new')sessions[sc.scope]='new-'+(++counters[sc.scope]);if(sc.family==='skills'&&!contexts[sc.scope].skill&&sc.authorization)contexts[sc.scope].skill=Object.fromEntries(['authorization','enabled','device','version','builtin'].map(k=>[k,sc[k]??(k==='builtin'?true:undefined)]))}
  }
  if(d.theme&&['light','dark'].includes(d.theme))settings={...settings,theme:d.theme}
  if(d.language&&['zh-CN','zh-Hans','en','es','ja','hu','de','pl'].includes(d.language))settings={...settings,language:d.language}
  if(d.type==='product-ui-prototype:reset'){drafts.clear();submitted.clear();imported.clear();importRecords.clear();transferDrafts.clear();transferResults.clear();transferCounter=0;attachments.clear();attachmentContents.clear();pending=null;for(const scope of ['personal','enterprise']){sessions[scope]='saved';counters[scope]=0;contexts[scope].blocks.clear();contexts[scope].denied.clear();contexts[scope].role='member';contexts[scope].roleKnown=false;contexts[scope].creditOrigin='preblock';contexts[scope].skill=null;contexts[scope].circleSources=null;contexts[scope].sourceStatus=null;contexts[scope].running=false;contexts[scope].revoked=false;contexts[scope].creditsKnown=false;preferences[scope]={saved:{...preferenceDefaults},draft:{...preferenceDefaults}}}fixture(byId.get(current));resetVersion++}
  if(['show-scene','reset'].some(t=>d.type===`product-ui-prototype:${t}`)&&byId.get(current).key==='offline')parent.postMessage({type:'product-ui-prototype:peer',version:1,session,epoch,channel:'polo-workbench',payload:{kind:'network-offline'}},'*');
  if(d.type==='product-ui-prototype:show-scene')hint=byId.get(current).transitions.some(t=>t.id===d.hint?.transition&&t.to===d.hint?.scene)?d.hint:null
  notify()
 })
 window.addEventListener('resize',measure);window.addEventListener('scroll',measure,true)
 document.addEventListener('click',()=>send('dismiss',{keyboard:false}));document.addEventListener('keydown',e=>{if(e.key==='Escape')send('dismiss',{keyboard:true})})
 new MutationObserver(()=>requestAnimationFrame(measure)).observe(document.documentElement,{subtree:true,childList:true,attributes:true})
}
