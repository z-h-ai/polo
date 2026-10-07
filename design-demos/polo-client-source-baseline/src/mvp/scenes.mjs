// Single authority for prototype routes, fixtures and real product operations.
// Product rules: PC-F04/07/08/10, PC-N03/04, C-R05/07; see docs/client-journey-review/spec.md (the sole product SoT).
export const revision = 'poo70-workbench-r15-closure'
export const id = (scope, key) => `A-${scope}-${key}`
export const scenes = []
const row = (scope, key, title, family, options = {}) => {
 const scene = {id:id(scope,key), key, scope, title:`${title} · ${scope === 'personal' ? '我的空间' : '晨星科技'}`, family, module:family==='skills'?'M06':family==='files'?'M08':family==='credits'?'M09':family==='sources'?'M06':'M05', surface:'assistant', journey:family==='credits'?'J-PC-03':'J-PC-04', node:family, state:key, status:'proposed', category:'新基线组件复用 + MVP 状态补充（待复看）', annotation:'组件沿用固定 Renderer 来源的助手基线；本轮状态与导航为设计补充。业务依据：PC-F04/07/08/10、PC-N03/04。布局待复看，测试不构成产品确认。', basis:family==='credits'?'PC-N03':family==='files'?'PC-F04 / D-PC-03':family==='skills'?'PC-F04 / PC-F07 / PC-F08':'PC-F04 / PC-N04 / PC-F10', transitions:[], ...options}
 scenes.push(scene); return scene
}
const edge = (scene, key, label, target, area='body') => scene.transitions.push({id:`${scene.id}-${key}`,key,label,to:target,area,feedback:label})
for (const scope of ['personal','enterprise']) {
 const to = key => id(scope,key)
 for (const [key,title] of Object.entries({new:'新会话',conversation:'原会话',generating:'正在生成',stopped:'已停止',question:'等待回答',reopen:'重开后恢复问题',answered:'已回答',deferred:'暂不回答',expired:'问题已过期',deleted:'原会话不可访问',answerfailed:'回答未提交',offline:'网络已断开',service:'服务暂时不可用',restored:'重新验证完成',completezero:'本次生成已完成'})) row(scope,key,title,'chat')
 for(const [key,title] of Object.entries({files:'原对话附件与生成文件',viewer:'查看生成文件',attachment:'查看原对话附件',missing:'文件已移动或删除',reselected:'已重新选择材料'}))row(scope,key,title,'files')
 for(const [key,title] of Object.entries({sources:'数据源与工具',sourceauth:'数据源需要认证',sourcefailed:'数据源连接失败',sourcedenied:'数据源权限被拒绝',automations:'自动化',browser:'助手浏览器'}))row(scope,key,title,'sources')
 for(const [key,title] of Object.entries({return:'返回后待查询',ownerreturn:'企业返回后待查询',preblock:'发送前积分不足',cut:'生成因积分不足停止',checking:'正在查询',notyet:'尚未到账',queryfailed:'查询失败',resumed:'积分可用',notify:'企业积分不足',notified:'已通知所有者',budget:'企业预算已达上限',budgetowner:'所有者处理企业预算',ownerblock:'所有者处理企业积分',ownerresumed:'企业积分可用'})) {
  if(scope==='personal'&&['notify','notified','budget','budgetowner','ownerblock','ownerresumed','ownerreturn'].includes(key))continue
  row(scope,key,title,'credits')
 }
 for (const [key,title,authorization,enabled,device] of [
 ['skills','技能','有效',false,'未安装'],['discover','获取技能','有效',false,'未安装'],['acquire','技能详情','有效',false,'未安装'],
 ['enabledpending','已启用 · 设备待准备','有效',true,'未安装'],['installing','正在准备本机','有效',true,'准备中'],['installfailed','设备准备失败','有效',true,'失败'],
 ['installed','已安装','有效',false,'就绪'],['enabled','已启用','有效',true,'就绪'],['detail','技能版本','有效',true,'就绪'],['updated','版本已更新','有效',true,'就绪'],['updatefailed','更新失败','有效',true,'就绪'],
 ['remove','卸载确认','有效',true,'就绪'],['uninstalled','本机已卸载','有效',true,'未安装'],['denied','未获授权','无授权',false,'未安装'],
 ['restricted','最后来源失效','已失效',false,'保留副本'],['fallback','部分来源失效','另一来源有效',true,'就绪'],['reauthorized','来源恢复','有效',false,'就绪'],['builtinoff','内置技能已停用','有效',false,'未安装'],['builtinon','内置技能已启用','有效',false,'未安装']
 ]) row(scope,key,title,'skills',{authorization,enabled,device,builtin:key!=='builtinoff',version:key==='updated'?'1.1.0':'1.0.0'})
}
for (const s of scenes) {
 const to=k=>id(s.scope,k), add=(key,label,target,area)=>edge(s,key,label,target,area)
 add('home','首页',s.scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host')
 add('new','新建会话',to('new'),'nav');add('sessions','所有会话',to('conversation'),'nav');add('skills','技能',to('skills'),'nav');add('sources','数据源',to('sources'),'nav')
 if(s.family==='chat'||s.family==='files'||s.family==='credits') {
  if(['generating'].includes(s.key))add('stop','停止生成',to('stopped'),'composer')
  else if(['question','reopen','answerfailed'].includes(s.key)){add('answer','提交回答',to('answered'),'question');add('defer','暂不回答',to('deferred'),'question')}
  else if(!['preblock','cut','checking','notyet','queryfailed','notify','notified','budget','budgetowner','ownerblock','return','ownerreturn','offline','expired','deleted'].includes(s.key))add('send','发送消息',to('generating'),'composer')
  if(['offline','service'].includes(s.key))add('retry','重新验证',to('restored'))
  if(['expired','deleted'].includes(s.key))add('original','回到会话列表',to('conversation'))
  if(s.family!=='files') add('files','查看会话文件',to('files'),'files')
 }
 if(s.family==='files'){
  if(['files','reselected'].includes(s.key)){add('view','查看生成文件',to('viewer'),'files');add('attachment','查看附件',to('attachment'),'files')}
  if(s.key==='missing')add('reselect','重新选择文件',to('reselected'),'files')
  add('back','回到原对话',to('conversation'),'files')
 }
 if(s.family==='skills'){
  if(['skills','installed','enabled','updated','builtinoff','builtinon','uninstalled'].includes(s.key))add('discover','获取技能',to('discover'))
  if(s.key==='discover')add('detail','查看技能',to('acquire'))
  if(['acquire','installed','reauthorized'].includes(s.key))add('enable','为我启用',to(s.device==='就绪'?'enabled':'enabledpending'))
  if(['enabledpending','installfailed','uninstalled'].includes(s.key))add('install',s.key==='installfailed'?'重试准备':'准备本机',to('installing'))
  if(['skills','installed','enabled','updated','fallback'].includes(s.key))add('detail','管理版本',to('detail'))
  if(['enabled','detail','updated'].includes(s.key))add('disable','为我停用',to('installed'))
  if(['detail','updatefailed'].includes(s.key))add('update','更新到 1.1.0',to('updated'))
  if(['detail','restricted','updatefailed'].includes(s.key))add('remove','卸载本机副本',to('remove'))
  if(s.key==='remove'){add('confirmremove','确认卸载',to('uninstalled'));add('cancel','取消',to('detail'))}
  if(s.key==='restricted'){add('recheck','重新验证来源',to('restricted'));add('source','查看来源',s.scope==='personal'?'P-M07-DETAIL-FOCUS':to('denied'))}
  if(s.key==='denied')add('recheck','重新验证授权',to('denied'))
  if(s.key==='fallback')add('use','回到对话',to('conversation'))
  if(s.key==='builtinoff')add('enablebuiltin','启用内置技能',to('builtinon'))
  if(['skills','builtinon'].includes(s.key))add('disablebuiltin','停用内置技能',to('builtinoff'))
 }
 if(s.family==='sources'){
  if(s.key==='sources'){add('automation','自动化',to('automations'));add('browser','浏览器',to('browser'));add('auth','连接数据源',to('sourceauth'))}
  if(['sourceauth','sourcefailed','sourcedenied'].includes(s.key)){add('connect',s.key==='sourceauth'?'保存并连接':'重试连接',to('sources'));add('cancel','取消',to('sources'))}
 }
 if(s.family==='credits'){
  if(['preblock','cut','notyet','queryfailed'].includes(s.key)){
   if(s.scope==='personal')add('recharge','去充值',s.key==='cut'?'P-M09-BROWSER-STREAM':'P-M09-BROWSER')
   else add('notify','通知所有者',to('notified'))
  }
  if(['preblock','cut','notyet','queryfailed','notified','ownerblock','return','ownerreturn'].includes(s.key))add('query','已完成，查询结果',to('checking'))
  if(s.key==='return'||s.key==='ownerreturn')add('notnow','还没有',to(s.key==='ownerreturn'?'ownerblock':'preblock'))
  if(s.key==='notify'||s.key==='budget')add('notify','通知所有者',to('notified'))
  if(s.key==='ownerblock'||s.key==='budgetowner')add('manage',s.key==='budgetowner'?'调整预算':'去充值',s.key==='budgetowner'?'P-M09-BROWSER-BUDGET':'P-M09-BROWSER-OWNER')
 }
}
export const aliases={
 'P-M05-CHAT':id('enterprise','generating'),'P-M05-CHAT-PERSONAL':id('personal','generating'),'P-M05-NEW':id('personal','new'),'P-M05-NEW-ENT':id('enterprise','new'),
 'P-M05-STOPPED':id('enterprise','stopped'),'P-M05-QUESTION':id('enterprise','question'),'P-M05-QUESTION-REOPEN':id('enterprise','reopen'),
 'P-M08-FILES':id('enterprise','files'),'P-M08-FILES-PERSONAL':id('personal','files'),'P-M08-FILE-MISSING':id('enterprise','missing'),
 'P-M09-PRE-BLOCK':id('personal','preblock'),'P-M09-STREAM-CUT':id('personal','cut'),'P-M09-USER-STOP':id('personal','stopped'),'P-M09-ENT-NOTIFY':id('enterprise','notify'),
 'P-M09-CHECKING':id('personal','checking'),'P-M09-NOT-YET':id('personal','notyet'),'P-M09-RESUMED':id('personal','resumed'),
 'P-M06-SKILLS':id('enterprise','skills'),'P-M06-TOOLS':id('enterprise','sources'),'P-M06-TOOLS-PERSONAL':id('personal','sources'),'P-M06-SKILL-DENIED':id('enterprise','denied'),
 'P-M06-INSTALL-FAILED':id('personal','installfailed'),'P-M06-LOCAL-RESTRICTED':id('personal','restricted'),
 // Historical sharing proposals are not confirmed MVP requirements. Keep links
 // on the enterprise catalogue; do not fabricate approval/submission operations.
 'P-M06-SHARE-ENT':id('enterprise','discover'),'P-M06-SHARE-SUBMITTED':id('enterprise','discover')
}
for(const [old,scope] of [['PERSONAL','personal'],['ENT','enterprise']]){
 for(const [key,target] of Object.entries({SKILLS:'skills',DISCOVER:'discover',INSTALL:'acquire',INSTALLED:'installed',ENABLED:'enabled',DETAIL:'detail',UPDATE:'updated',REMOVE:'remove','BUILTIN-OFF':'builtinoff',RESTRICTED:'restricted','REMOVE-RESTRICTED':'remove'}))aliases[`P-M06-${key}-${old}`]=id(scope,target)
 // Legacy deep links carry a version, enabled flag and built-in flag; preserve
 // those state differences with shared components, not copied page layouts.
 for(const version of ['100','110'])for(const enabled of [0,1])for(const builtin of [0,1])for(const family of ['LOCAL','DETAIL','REMOVE']){
  const key=`legacy-${family.toLowerCase()}-${version}-${enabled}-${builtin}`
  const s=row(scope,key,family==='REMOVE'?'卸载确认':'技能版本','skills',{authorization:'有效',enabled:!!enabled,device:'就绪',version:version==='100'?'1.0.0':'1.1.0',builtin:!!builtin,legacyView:family.toLowerCase()})
  // Compatibility states only, not separate active navigation destinations.
  aliases[`P-M06-${family}-${old}-${version}-${enabled}-${builtin}`]=s.id
  edge(s,'home','首页',scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host')
  edge(s,'skills','技能',id(scope,'skills'),'nav')
  edge(s,'cancel','返回技能',id(scope,'skills'))
  if(family==='REMOVE')edge(s,'confirmremove','确认卸载',id(scope,'uninstalled'))
  else {edge(s,enabled?'disable':'enable',enabled?'为我停用':'为我启用',id(scope,enabled?'installed':'enabled'));edge(s,'update','管理版本',id(scope,'detail'))}
 }
}

// Property-preserving skill navigation: detail/close never enables a skill,
// cancellation never restores authorization, and updates retain user preferences.
for(const scope of ['personal','enterprise']) {
 for(const [key,title,device] of [['restricted-remove','卸载已失效副本','保留副本'],['restricted-uninstalled','已失效副本已卸载','未安装']]){
  const s=row(scope,key,title,'skills',{authorization:'已失效',enabled:false,device,version:'1.0.0'})
  if(key==='restricted-remove'){edge(s,'confirmremove','确认卸载',id(scope,'restricted-uninstalled'));edge(s,'cancel','取消',id(scope,'restricted'))}
  else edge(s,'recheck','重新验证来源',id(scope,'restricted-uninstalled'))
  edge(s,'home','首页',scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host')
 }
 for(const version of ['100','110'])for(const enabled of [0,1])for(const builtin of [0,1]){
  const key=`uninstalled-${version}-${enabled}-${builtin}`
  const s=row(scope,key,'本机副本已卸载','skills',{authorization:'有效',enabled:!!enabled,device:'未安装',version:version==='100'?'1.0.0':'1.1.0',builtin:!!builtin})
  edge(s,'install','准备本机',id(scope,'installing'))
  edge(s,'home','首页',scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host')
 }
}
for(const s of scenes.filter(s=>s.family==='skills')){
 const variant=(view,enabled=s.enabled,version=s.version,builtin=s.builtin!==false)=>id(s.scope,`legacy-${view}-${version==='1.1.0'?'110':'100'}-${enabled?1:0}-${builtin?1:0}`)
 if(s.legacyView){
  s.transitions=s.transitions.filter(t=>!['enable','disable','update','cancel','confirmremove'].includes(t.key))
  if(s.legacyView==='remove'){
   edge(s,'confirmremove','确认卸载',id(s.scope,`uninstalled-${s.version==='1.1.0'?'110':'100'}-${s.enabled?1:0}-${s.builtin?1:0}`))
   edge(s,'cancel','取消',variant('detail'))
  }else{
   edge(s,s.enabled?'disable':'enable',s.enabled?'为我停用':'为我启用',variant(s.legacyView,!s.enabled))
   if(s.legacyView==='local')edge(s,'detail','管理版本',variant('detail'))
   else {if(s.version!=='1.1.0')edge(s,'update','更新到 1.1.0',variant('detail',s.enabled,'1.1.0'));edge(s,'remove','卸载本机副本',variant('remove'))}
  }
 }
 for(const t of s.transitions){
  if(s.key==='restricted'&&t.key==='remove')t.to=id(s.scope,'restricted-remove')
  else if(s.authorization==='有效'&&s.device==='就绪'){
   if(t.key==='detail')t.to=variant('detail')
   if(t.key==='remove')t.to=variant('remove')
   if(t.key==='cancel')t.to=variant('detail')
   if(t.key==='disable')t.to=variant('local',false)
   if(t.key==='enable')t.to=variant('local',true)
   if(t.key==='update')t.to=variant('detail',s.enabled,'1.1.0')
   if(t.key==='skills')t.to=variant('local')
  }
 }
}

// Missing/denied sessions have no file access path; enterprise never inherits circles.
for(const s of scenes){
 if(s.key==='deleted')s.transitions=s.transitions.filter(t=>t.key!=='files')
}
scenes.splice(scenes.findIndex(s=>s.id===id('enterprise','fallback')),1)
for(const scope of ['personal','enterprise']){
 for(const [key,title,family] of [['empty-skills','暂无额外技能','skills'],['empty-sources','暂无数据源','sources'],['sourcedisconnected','数据源未连接','sources'],['sourceconnecting','正在连接数据源','sources'],['permission','需要文件访问权限','chat'],['permissiondenied','文件访问权限被拒绝','chat'],['permissiongranted','访问权限已授予','chat']]){
  const s=row(scope,key,title,family)
  edge(s,'home','首页',scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host')
  if(key==='sourcedisconnected')edge(s,'connect','连接数据源',id(scope,'sourceauth'))
  if(key==='permission'){edge(s,'allow','允许本次访问',id(scope,'permissiongranted'));edge(s,'deny','拒绝',id(scope,'permissiondenied'))}
  if(key==='permissiondenied')edge(s,'retry','重新请求权限',id(scope,'permission'))
  if(key==='permissiongranted')edge(s,'send','发送消息',id(scope,'generating'),'composer')
 }
 for(const s of scenes.filter(s=>s.scope===scope)){
  if(['sourceauth','sourcefailed','sourcedenied'].includes(s.key))for(const t of s.transitions){
   if(t.key==='cancel')t.to=id(scope,'sourcedisconnected')
   if(t.key==='connect')t.to=id(scope,'sourceconnecting')
  }
 }
}
for(const [key,title] of [['returnstream','生成中断后返回'],['checkingstream','正在查询充值'],['notyetstream','生成中断 · 未到账'],['failedstream','生成中断 · 查询失败'],['resumedstream','生成中断 · 积分可用']]){
 const s=row('personal',key,title,'credits')
 if(key==='returnstream'){edge(s,'query','已完成，查询结果',id('personal','checkingstream'));edge(s,'notnow','还没有',id('personal','cut'))}
 if(['notyetstream','failedstream'].includes(key)){edge(s,'query','已完成，查询结果',id('personal','checkingstream'));edge(s,'recharge','去充值','P-M09-BROWSER-STREAM')}
 if(key==='resumedstream')edge(s,'send','发送消息',id('personal','generating'),'composer')
 edge(s,'files','查看会话文件',id('personal','files'),'files')
}
for(const prefix of ['owner','budget'])for(const [suffix,title] of [['return','返回后待查询'],['checking','正在查询'],['pending','尚未恢复'],['failed','查询失败'],['resumed','已恢复可用']]){
 const key=prefix+suffix
 let s=scenes.find(s=>s.id===id('enterprise',key))
 if(!s)s=row('enterprise',key,(prefix==='budget'?'企业预算 · ':'企业积分 · ')+title,'credits')
 s.transitions=[]
 if(suffix==='return'){edge(s,'query',prefix==='budget'?'已处理，查询预算':'已完成，查询结果',id('enterprise',prefix+'checking'));edge(s,'notnow','还没有',id('enterprise',prefix==='budget'?'budgetowner':'ownerblock'))}
 if(['pending','failed'].includes(suffix)){edge(s,'query',prefix==='budget'?'重新查询预算':'已完成，查询结果',id('enterprise',prefix+'checking'));edge(s,'manage',prefix==='budget'?'调整预算':'去充值','P-M09-BROWSER-'+(prefix==='budget'?'BUDGET':'OWNER'))}
 if(suffix==='resumed')edge(s,'send','发送消息',id('enterprise','generating'),'composer')
 edge(s,'files','查看会话文件',id('enterprise','files'),'files')
}

// Recovery stays available after viewing files or starting another conversation.
for(const scope of ['personal','enterprise']){
 const s=row(scope,'availability','恢复发送','chat')
 edge(s,'credit-pre','处理积分不足',id(scope,'preblock'))
 edge(s,'credit-cut','处理积分中断',id(scope,'cut'))
 if(scope==='enterprise'){
  edge(s,'credit-owner','处理企业积分',id(scope,'ownerblock'))
  edge(s,'credit-member','通知企业所有者',id(scope,'notify'))
  edge(s,'budget-owner','处理企业预算',id(scope,'budgetowner'))
  edge(s,'budget-member','通知所有者调整预算',id(scope,'budget'))
 }
 edge(s,'network','重新验证网络',id(scope,'restored'))
 edge(s,'permission','重新请求文件权限',id(scope,'permission'))
 edge(s,'back','回到原对话',id(scope,'conversation'))
}
for(const s of scenes.filter(s=>['chat','files'].includes(s.family)&&s.key!=='availability'))edge(s,'recovery','恢复发送',id(s.scope,'availability'))

for(const [suffix,title] of [['notified','已通知所有者调整预算'],['memberchecking','正在核对企业预算'],['memberpending','企业预算仍受限'],['memberfailed','预算查询失败'],['memberresumed','企业预算恢复']]){
 const s=row('enterprise','budget'+suffix,title,'credits')
 if(['notified','memberpending','memberfailed'].includes(suffix))edge(s,'query','已处理，查询预算',id('enterprise','budgetmemberchecking'))
 if(suffix==='memberresumed')edge(s,'send','发送消息',id('enterprise','generating'),'composer')
 edge(s,'files','查看会话文件',id('enterprise','files'),'files')
}
for(const s of scenes){
 if(s.key==='budget')for(const t of s.transitions)if(t.key==='notify')t.to=id('enterprise','budgetnotified')
 if(s.key==='ownerblock')for(const t of s.transitions)if(t.key==='query')t.to=id('enterprise','ownerchecking')
}
// r14: platform chrome and resource management are outside assistant chat.
for(const scope of ['personal','enterprise']){
 const home=scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT'
 const activity=row(scope,'activity','助手任务','activity');activity.module='M04';activity.journey='J-PC-07';edge(activity,'viewactivity','返回原会话',id(scope,'generating'));edge(activity,'stopactivity','停止任务',id(scope,'stopped'));
 row(scope,'preferences','助手偏好','preferences')
 row(scope,'preferences-savefailed','助手偏好保存失败','preferences')
 for(const [key,title] of [['close','关闭 Polo 助手'],['closefailed','未能停止任务']]){
  const c=row(scope,key,title,'close');c.module='M04';c.journey='J-PC-07'
  edge(c,'background','后台继续',home);edge(c,'stopclose',key==='closefailed'?'重试停止并关闭':'停止并关闭',home);edge(c,'cancelclose','取消',id(scope,'generating'))
 }
}
for(const s of scenes){
 const home=s.scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT'
 if(!s.transitions.some(t=>t.key==='home'))edge(s,'home','首页',home,'host')
 const host=(key,label,target)=>{if(!s.transitions.some(t=>t.key===key))edge(s,key,label,target,'chrome')}
 host('account','打开账号菜单',s.scope==='personal'?'P-M10-MENU':'P-M10-MENU-ENT')
 host('runtime','后台任务',id(s.scope,'activity'))
 host('notification','通知',s.scope==='personal'?'P-M04-NOTIFY-PERSONAL':'P-M04-NOTIFY-ENT')
 if(s.family!=='skills'&&s.family!=='close'){
  host('closeidle','关闭助手标签',home);host('closeactive','关闭助手标签',id(s.scope,'close'))
  host('preferences',s.family==='preferences'?'返回助手':'助手偏好',id(s.scope,s.family==='preferences'?'new':'preferences'))
 }
 if(s.family==='skills'){
  for(const t of s.transitions)if(['enablebuiltin','disablebuiltin'].includes(t.key))t.area='builtin'
  if(!s.transitions.some(t=>t.key==='enablebuiltin'))edge(s,'enablebuiltin','启用内置技能',id(s.scope,'builtinon'),'builtin')
  if(!s.transitions.some(t=>t.key==='disablebuiltin'))edge(s,'disablebuiltin','停用内置技能',id(s.scope,'builtinoff'),'builtin')
  s.title=s.title.replace('技能','技能')
  host('assistant','打开 Polo 助手',id(s.scope,'conversation'))
 }
}

// The library entry consumes retained object state after returning from the host.
for (const scope of ['personal','enterprise']) {
 const s=scenes.find(s=>s.id===id(scope,'skills'))
 for(const [key,label,target] of [['enable','为我启用','enabledpending'],['disable','为我停用','installed'],['install','准备本机','installing'],['update','更新到 1.1.0','updated'],['remove','卸载本机副本','remove'],['recheck','重新验证来源','skills']])
  if(!s.transitions.some(t=>t.key===key))edge(s,key,label,id(scope,target))
}

// C-R07: only explicitly permitted conversation content crosses a space boundary.
for(const scope of ['personal','enterprise']){
 for(const [key,title] of [['transfer-export','导出允许的对话内容'],['transfer-exported','对话内容已导出'],['transfer-import','导入对话内容'],['transfer-preview','确认导入'],['transfer-done','已建立导入对话'],['transfer-invalid','无法导入此文件'],['legacy-isolation','旧数据归属待核验']]){
  const s=row(scope,key,title,'transfer',{module:'M08',basis:'C-R07 / PC-F04 / D-PC-03',annotation:'已确认的显式允许内容转移与归属隔离；原型只演练被允许的消息文本，不定义生产 allowlist 或授予文件中声明的权限。'});
  edge(s,'home','首页',scope==='personal'?'P-M03-HOME-PERSONAL':'P-M03-HOME-ENT','host');
  if(key==='transfer-export')edge(s,'export-content','下载允许内容',id(scope,'transfer-exported'));
  if(key==='transfer-import')edge(s,'select-import','选择导出文件',id(scope,'transfer-preview'));
  if(key==='transfer-preview')edge(s,'confirm-import','确认导入',id(scope,'transfer-done'));
  if(key==='transfer-done')edge(s,'view-imported','打开导入对话',id(scope,'conversation'));
  if(key==='transfer-invalid')edge(s,'retry-import','重新选择文件',id(scope,'transfer-import'));
  edge(s,'cancel-transfer',key==='legacy-isolation'?'返回当前空间':key==='transfer-preview'?'取消导入':key==='transfer-done'?'返回对话':'返回原对话',id(scope,'conversation'));
 }
 const files=scenes.find(s=>s.id===id(scope,'files'));edge(files,'export','导出允许内容',id(scope,'transfer-export'),'files');edge(files,'import','导入对话内容',id(scope,'transfer-import'),'files');
}

for(const s of scenes)if(['chat','files','credits'].includes(s.family))edge(s,'open-imported','打开导入对话',id(s.scope,'conversation'),'imported');

export const byId = new Map(scenes.map(s=>[s.id,s]))
export function resolveScene(value){return aliases[value]||value}

// Spec §13.11: explicit design delta; existing chat UI is implementation-owned.
for (const scene of scenes) {
 const skills=scene.family==='skills',transfer=scene.family==='transfer';
 scene.annotation=(transfer?'本轮补齐已确认的内容转移与归属隔离行为；文件格式仅为交互样例。':skills?'本轮评审技能管理及其授权、启用、设备准备、来源与版本差异。':'既有助手行为衔接示意；不作为聊天、输入、附件和会话导航的 UI 重做依据。现有界面沿用 apps/electron/src/renderer/ 当前实现。')+' 画布与首页统一，其他未明确修改的 UI 不从本原型派生实现任务。'+scene.annotation;
 scene.annotations=[...(scene.annotations||[]),{id:'implementation-scope',anchor:null,title:transfer?'已确认恢复规则':skills?'本轮改造范围：技能管理':'沿用现有实现',body:scene.annotation}];
}
