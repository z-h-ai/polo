import {useEffect,useState,useSyncExternalStore} from 'react'
import {Paperclip,ArrowUp,Square,Inbox,Zap,DatabaseZap,Plus,FileText} from 'lucide-react'
import {SourceResourceEmptyPanel} from '../source/ResourceEmptyPanels.jsx'
import {SourceBrowserEmptyState} from '../source/BrowserEmptyState.jsx'
import {SourcePoloShell} from '../source/PoloShell.jsx'
import {SourceFaithfulEmptyChat} from '../source/EmptyChat.jsx'
import {UserMessageBubble,AssistantMessageBubble} from '../source/ChatConversation.jsx'
import {EntityRow,ListBadge,SkillIcon,HeroSkillIcon,Hero,InfoPageContent,InfoSection,InfoTable,InfoCard,SourceIcon,HeroSourceIcon} from '../source/ResourceListDetail.jsx'
import {subscribe,getSnapshot,act,getDraft,setDraft,getSubmitted,getAttachment,setAttachment,canSend,canRead,blockingText,isSavedConversation,getConversationId,getAttachmentContent,actionEnabled,getSourceStatus} from './runtime.js'

function Action({scene,edge,children,className='',before}){
 if(edge.key==='reselect')return <label className="mvp-action mvp-attach">重新选择文件<input type="file" aria-label="重新选择文件" data-go={edge.to} data-transition={edge.id} onChange={async e=>{const file=e.target.files?.[0];if(file){setAttachment(scene.scope,file.name,file.type.startsWith('text/')&&file.size<2000000?await file.text():null);act('reselect')}}}/></label>
 return <button type="button" hidden={!actionEnabled(scene.scope,edge.key)} disabled={!actionEnabled(scene.scope,edge.key)} className={'mvp-action '+className} data-go={edge.to} data-transition={edge.id} onClick={()=>{before?.();act(edge.key)}}>{children||edge.label}</button>
}
function Actions({scene,area='body'}){return <div className="mvp-actions">{scene.transitions.filter(t=>t.area===area).map(t=><Action key={t.id} scene={scene} edge={t}/>)}</div>}
function Chat({scene}){
 const question=['question','reopen','answerfailed'].includes(scene.key),key=question?'question':'conversation'
 const [draft,changeDraft]=useState(()=>getDraft(scene.scope,key)),[localAttachment,setLocalAttachment]=useState(getAttachment(scene.scope))
 useEffect(()=>{changeDraft(getDraft(scene.scope,key));setLocalAttachment(getAttachment(scene.scope))},[scene.id,getConversationId(scene.scope)])
 const change=value=>{changeDraft(value);setDraft(scene.scope,value,key)}
 const permitted=canSend(scene.scope), readable=canRead(scene.scope)
 const generating=scene.key==='generating',fresh=['new','preblock'].includes(scene.key),scopeName=scene.scope==='personal'?'个人资料整理':'企业周报'
 const notices={budgetnotified:'已通知所有者调整企业预算。',budgetmemberchecking:'正在核对企业预算…',budgetmemberpending:'企业预算仍受限。',budgetmemberfailed:'企业预算查询失败。',budgetmemberresumed:'企业预算已恢复。',availability:'处理当前发送限制后，再回到会话发送。',returnstream:'已在浏览器完成充值？',checkingstream:'正在查询本次充值结果…',notyetstream:'尚未到账，已生成内容已保留。',failedstream:'查询失败，已生成内容已保留。',resumedstream:'积分可用，可以发送消息。',ownerchecking:'正在查询企业充值结果…',ownerpending:'企业积分尚未恢复。',ownerfailed:'企业积分查询失败。',budgetreturn:'已在浏览器调整预算？',budgetchecking:'正在查询企业预算…',budgetpending:'企业预算仍受限。',budgetfailed:'企业预算查询失败。',budgetresumed:'企业预算已恢复。',permission:'需要读取你选择的文件。是否允许本次访问？',permissiondenied:'文件访问权限被拒绝。请在系统设置 → 隐私与安全性 → 文件与文件夹中允许 Polo 访问，再重新请求。',permissiongranted:'已允许本次访问。',stopped:'已停止生成。',question:'需要汇总哪一个时间范围？',reopen:'需要汇总哪一个时间范围？',answered:'已收到你的回答，正在原会话中继续整理。',deferred:'已暂不回答。',expired:'这个问题已过期，请在原会话重新提问。',deleted:'原会话已删除或你已无权访问。',answerfailed:'回答尚未提交，请重试。',offline:'网络已断开，生成已暂停。',service:'服务暂时不可用，请稍后重试。',restored:'已重新验证，可以发送消息。',completezero:'本次生成已完成。',return:'已在浏览器完成充值？',ownerreturn:'已在浏览器处理企业额度？',preblock:'积分不足，请充值后查询结果。',cut:'积分不足，本次生成已停止。',checking:'正在查询本次充值结果…',notyet:'尚未到账，请稍后再查。',queryfailed:'查询失败，积分状态尚未更新。',resumed:'积分已到账，可以发送消息。',notify:'企业积分不足，请通知所有者处理。',notified:'已通知所有者，等待处理。',budget:'企业预算已达上限，请通知所有者调整。',budgetowner:'企业预算已达上限。',ownerblock:'企业积分不足。',ownerresumed:'企业积分已可用，可以发送消息。'}
 const send=scene.transitions.find(t=>['send','stop'].includes(t.key))
 const questionAction=scene.transitions.find(t=>t.key==='answer')
 const filePicker=<label className="mvp-attach"><Paperclip size={16}/><span>附加文件</span><input aria-label="附加文件" type="file" onChange={async e=>{const file=e.target.files?.[0];if(file){setAttachment(scene.scope,file.name,file.type.startsWith('text/')&&file.size<2000000?await file.text():null);setLocalAttachment(file.name)}}}/></label>
 const transcript=<>
  {!fresh&&scene.key!=='deleted'&&readable&&isSavedConversation(scene.scope)&&<><UserMessageBubble text={scene.scope==='personal'?'请整理这份资料，保留关键结论。':'请汇总本周企业项目进展。'}/><AssistantMessageBubble text={generating?'正在整理资料中的关键结论…':'已整理第一部分：本周的主要进展与后续待办。'}/></>}
  {readable&&getSubmitted(scene.scope).map((text,i)=><UserMessageBubble key={i} text={text}/>)}
  {readable&&!isSavedConversation(scene.scope)&&!fresh&&scene.key!=='deleted'&&<AssistantMessageBubble text={generating?'正在整理你发送的材料…':'已整理第一部分：本周的主要进展与后续待办。'}/>}

  {['cut','stopped'].includes(scene.key)&&<div role="status" className="mvp-alert">{notices[scene.key]}<Actions scene={scene}/></div>}
  {question&&<InfoCard><div className="mvp-question"><p>{notices[scene.key]}</p><textarea aria-label="回答问题" value={draft} placeholder="例如：本周一到周五" onChange={e=>change(e.target.value)}/><div className="mvp-actions">{questionAction&&<button className="mvp-action primary" disabled={!draft.trim()||!permitted} data-transition={questionAction.id} data-go={questionAction.to} onClick={()=>act('answer')}>提交回答</button>}{scene.transitions.filter(t=>t.key==='defer').map(t=><Action key={t.id} scene={scene} edge={t}/>)}</div></div></InfoCard>}
  {scene.family==='files'&&readable&&!isSavedConversation(scene.scope)&&!getAttachment(scene.scope)&&<div><p>当前会话暂无文件。</p><Actions scene={scene} area="files"/></div>}
  {scene.family==='files'&&readable&&(isSavedConversation(scene.scope)||getAttachment(scene.scope))&&<InfoCard><div className="mvp-question"><strong>{scene.key==='missing'?'文件不可用':scene.key==='viewer'?'资料汇总.md':scene.key==='attachment'?(getAttachment(scene.scope)||'项目资料.pdf'):'会话文件'}</strong><p>{scene.key==='missing'?'原文件已移动或删除，请重新选择。':scene.key==='attachment'?(getAttachmentContent(scene.scope)||'此文件暂不支持文本预览。'):scene.key==='viewer'?'本周主要进展\n一、已整理需求材料。\n二、待核对后提交总结。':`附件：${getAttachment(scene.scope)||'项目资料.pdf'}${isSavedConversation(scene.scope)?' · 生成文件：资料汇总.md':''}`}</p><Actions scene={scene} area="files"/></div></InfoCard>}
 </>
 const composer=question?null:<form onSubmit={e=>{e.preventDefault();if(send&&!generating)act('send')}} className="mvp-composer"><textarea aria-label="消息" placeholder="想做什么?" value={draft} onChange={e=>change(e.target.value)}/>{localAttachment&&<span className="mvp-attached">{localAttachment}</span>}<div className="mvp-composer-footer">{filePicker}<span className="mvp-input-context">当前空间</span><span style={{flex:1}}/>{send?<button className="mvp-send" type={generating?'button':'submit'} disabled={!generating&&(!draft.trim()||!permitted)} aria-label={send.label} data-go={send.to} data-transition={send.id} onClick={generating?()=>act('stop'):undefined}>{generating?<Square size={14}/>:<ArrowUp size={16}/>}</button>:<button className="mvp-send" disabled aria-label="发送消息"><ArrowUp size={16}/></button>}</div></form>
 return <SourceFaithfulEmptyChat mvp={{title:fresh?'新聊天':scopeName,transcript,badges:scene.family!=='files'&&readable?<Actions scene={scene} area="files"/>:null,notice:!['cut','stopped'].includes(scene.key)&&<>{!notices[scene.key]&&blockingText(scene.scope)&&<p role="status">{blockingText(scene.scope)}</p>}{notices[scene.key]&&<p role="status">{notices[scene.key]}</p>}<Actions scene={scene}/></>,composer}}/>
}
function SkillNavigator({scene}){
 if(scene.key==='empty-skills')return <div className="source-navigator__header"><strong>技能</strong></div>
 return <><div className="source-navigator__header"><strong>技能</strong></div><div className="mvp-list"><EntityRow icon={<SkillIcon emoji="📋"/>} title={scene.scope==='personal'?'资料研究':'销售周报'} selected badges={<ListBadge tint="accent">{scene.scope==='personal'?'晨星增长圈 · 晨星设计圈':'晨星科技共享'}</ListBadge>}/><EntityRow icon={<SkillIcon emoji="✨"/>} title="资料研究" badges={<ListBadge tint="project">Polo 内置</ListBadge>}/></div></>
}
function Skills({scene}){
 const title=scene.scope==='personal'?'资料研究':'销售周报',restricted=scene.authorization==='已失效',remove=scene.key==='restricted-remove'||scene.key==='remove'||scene.legacyView==='remove'
 if(scene.key==='empty-skills')return <SourceResourceEmptyPanel kind="skills" actions={false}/>
 return <div className="mvp-detail"><div className="source-navigator__header"><span className="source-navigator__header-title">{remove?'卸载本机副本':title}</span></div><InfoPageContent>
 <Hero avatar={<HeroSkillIcon emoji="📋"/>} title={title} tagline="整理材料与进展，形成可核对的报告草稿"/>
 <InfoSection title="来源与使用状态"><InfoTable rows={[
 ['来源',scene.scope==='personal'?'晨星增长圈 / 晨星设计圈':'晨星科技 · 企业共享'],['来源授权',scene.authorization],['本人启用',scene.enabled?'已启用':'未启用'],['本机准备',scene.device],['本机版本',scene.device==='未安装'?'—':scene.version],['内置资料研究',scene.builtin===false||scene.key==='builtinoff'?'已停用':'已启用']
 ]}/></InfoSection>
 {scene.key==='installing'&&<p role="status">正在下载并验证技能包…</p>}
 {scene.key==='installfailed'&&<p className="mvp-alert">下载失败，请检查网络后重试。本人的启用设置已保留。</p>}
 {scene.key==='updatefailed'&&<p className="mvp-alert">更新失败，仍使用已验证的 {scene.version} 版本。</p>}
 {restricted&&<p className="mvp-alert">最后一个有效来源已失效，当前不可调用。已保存的对话仍可查看。</p>}
 {scene.key==='denied'&&<p className="mvp-alert">你尚未获得此技能的使用授权。{scene.scope==='personal'?'请向提供该技能的圈子确认资格。':'请联系企业管理员。'}</p>}
 {scene.key==='fallback'&&scene.scope==='personal'&&<p>晨星增长圈已失效；晨星设计圈的授权仍然有效。</p>}
 {remove&&<p>将删除这台设备的技能副本。原对话及附件保留。</p>}
 <Actions scene={scene}/><InfoSection title="说明"><p className="mvp-description">使用当前空间中已授权的数据源整理资料。执行前请核对文件范围与输出内容。</p></InfoSection>
 </InfoPageContent></div>
}
function Sources({scene}){
 const [token,setToken]=useState(()=>getDraft(scene.scope,'source-auth'))
 if(scene.key==='automations'||scene.key==='empty-sources')return <SourceResourceEmptyPanel kind={scene.key==='automations'?'automations':'sources'} actions={false}/>
 if(scene.key==='browser')return <SourceBrowserEmptyState suggestions={false}/>
 return <div className="mvp-detail"><div className="source-navigator__header"><strong>{scene.key==='automations'?'自动化':scene.key==='browser'?'浏览器':'数据源与工具'}</strong></div><InfoPageContent><Hero avatar={<HeroSourceIcon type="mcp"/>} title={scene.key==='automations'?'暂无自动化':scene.key==='browser'?'尚未打开网页':'项目资料'} tagline={scene.scope==='personal'?'我的空间的数据源':'晨星科技的数据源'}/>
 {scene.key==='sourceauth'?<label>访问凭证<input type="password" aria-label="访问凭证" value={token} onChange={e=>{setToken(e.target.value);setDraft(scene.scope,e.target.value,"source-auth")}}/></label>:<InfoSection title="连接与权限"><InfoTable rows={[["类型","MCP"],["连接",({connected:'已连接',failed:'连接失败',denied:'未获得访问权限',disconnected:'未连接',connecting:'正在连接…',auth:'需要认证'}[getSourceStatus(scene.scope)])],['read_file','允许'],['write_file','询问'],['run_command','询问']]}/></InfoSection>}
 <div className="mvp-actions">{scene.transitions.filter(t=>t.area==='body').map(t=><button key={t.id} className="mvp-action" disabled={scene.key==='sourceauth'&&t.key==='connect'&&!token.trim()} data-go={t.to} data-transition={t.id} onClick={()=>act(t.key)}>{t.label}</button>)}</div></InfoPageContent></div>
}
function Navigator({scene}){
 if(scene.family==='skills')return <SkillNavigator scene={scene}/>
 if(scene.key==='empty-sources')return <div className="source-navigator__header"><strong>数据源</strong></div>
 if(scene.family==='sources')return <><div className="source-navigator__header"><strong>数据源</strong></div><div className="mvp-list"><EntityRow icon={<SourceIcon type="mcp"/>} title="项目资料" selected badges={<ListBadge tint="accent">{scene.scope==='personal'?'我的空间':'晨星科技'}</ListBadge>}/></div></>
 return <><div className="source-navigator__header"><span className="source-navigator__header-title">所有会话</span></div><div className="source-navigator__list"><div className="mvp-list">{scene.transitions.filter(t=>t.key==='sessions').map(t=><Action key={t.id} edge={t} scene={scene} className="mvp-session" before={()=>{}}>{scene.scope==='personal'?'个人资料整理':'企业周报'}</Action>)}</div></div></>
}
export function MvpAssistant(){
 const {scene,settings,resetVersion}=useSyncExternalStore(subscribe,getSnapshot,getSnapshot)
 useEffect(()=>{document.documentElement.dataset.theme=settings.theme;document.documentElement.lang=settings.language;document.body.dataset.currentScene=scene.id},[scene.id,settings])
 return <div data-product-surface className="mvp-root" key={resetVersion}><div data-prototype-scene={scene.id} className="mvp-scene">
 <SourcePoloShell mvp={{scope:scene.scope==='personal'?'我的空间':'晨星科技',navigation:<nav className="source-sidebar__nav">{scene.transitions.filter(t=>['nav','host'].includes(t.area)&&(t.key!=='sessions'||['skills','sources'].includes(scene.family))).map(t=><Action key={t.id} scene={scene} edge={t} className={'source-nav-item '+(t.key==='new'?'source-new-session':'')}><span>{t.key==='new'?<Plus size={14}/>:t.key==='skills'?<Zap size={14}/>:t.key==='sources'?<DatabaseZap size={14}/>:<Inbox size={14}/>}</span>{t.label}</Action>)}</nav>}} navigator={<Navigator scene={scene}/>}>{scene.family==='skills'?<Skills key={scene.id} scene={scene}/>:scene.family==='sources'?<Sources key={scene.id} scene={scene}/>:<Chat scene={scene}/>}</SourcePoloShell>
 </div></div>
}
