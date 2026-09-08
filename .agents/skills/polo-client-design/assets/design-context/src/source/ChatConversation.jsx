import { useState } from 'react'
import { ArrowUp, ChevronDown, DatabaseZap, FileText, Info, Paperclip } from 'lucide-react'

// Conversation view translated from UserMessageBubble.tsx + ChatDisplay.tsx +
// lib/layout.ts, mounted in the SourceFaithfulEmptyChat chrome (its
// PanelHeader + badge row + composer stay identical). The transcript is a
// named deterministic fixture — real message content comes from IPC at
// runtime and cannot be derived from source. CHAT_LAYOUT: maxWidth
// max-w-[840px], containerPadding px-5 py-8, messageSpacing space-y-2.5,
// userMessagePadding pt-4 pb-2. Root font-size 15px.
export function SourceChatConversation() {
  return <ConversationFixture />
}

function ConversationFixture() {
  const [draft, setDraft] = useState('')
  const messages = [
    { role: 'user', text: '帮我把 polaris 仓库的 main 分支同步到最新，然后总结过去一周的提交。' },
    { role: 'assistant', text: '已将 polaris/main 同步到 origin/main (快进 14 个提交)。过去一周的提交集中在三块: 权限模式切换的状态机重构、自动化调度器的时区修复，以及设置页外观子页的图标表格。没有发现冲突标记。' },
    { role: 'user', text: '把时区修复单独整理成一条 changelog 条目。' },
    { role: 'assistant', text: 'changelog 草稿:\n- fix(automations): 调度器现在按 Workspace 时区解释计划表达式，修复了跨时区部署时定时任务提前/延后一小时的问题。' },
  ]
  return <section aria-label="会话" style={{height:'100%',minWidth:0,display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}>
    <header style={{height:42,minHeight:42,display:'flex',alignItems:'center',gap:6,paddingLeft:16,paddingRight:8,position:'relative',zIndex:1}}>
      <div style={{minWidth:0,flex:1,display:'flex',alignItems:'center',justifyContent:'center',userSelect:'none'}}><button type="button" style={{minWidth:0,display:'inline-flex',alignItems:'center',gap:4,padding:'4px 8px',border:0,borderRadius:6,color:'var(--foreground)',background:'transparent'}}><h1 style={{margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'var(--font-sans)',fontSize:14,fontWeight:600,lineHeight:1.25}}>polaris 周报</h1><ChevronDown size={14} style={{flexShrink:0,color:'var(--fg-50)',transform:'translateY(1px)'}}/></button></div>
    </header>
    <div style={{minHeight:0,minWidth:0,flex:1,display:'flex',flexDirection:'column',position:'relative'}}>
      {/* ChatDisplay: the masked scroll area hosts the CHAT_LAYOUT column. */}
      <main style={{minHeight:0,flex:1,overflowY:'auto',WebkitMaskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)',maskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)'}}>
        <div style={{width:'100%',maxWidth:840,boxSizing:'border-box',margin:'0 auto',padding:'30px 18.75px'}}>
          <div style={{display:'flex',flexDirection:'column',gap:9.375}}>
            {messages.map((message, index) => message.role === 'user'
              ? <UserMessageBubble key={index} text={message.text} />
              : <AssistantMessageBubble key={index} text={message.text} />)}
          </div>
        </div>
      </main>
      <div style={{width:'100%',maxWidth:840,boxSizing:'border-box',margin:'4px auto 0',padding:'1px 20px 16px'}}>
        <div style={{minHeight:33,display:'flex',alignItems:'flex-start',gap:8,marginBottom:8,padding:'1px 1px 2px'}}><AskBadge/><StateBadge/><span style={{flex:1}}/><InfoButton/></div>
        <form onSubmit={e => {e.preventDefault(); if(draft.trim()) setDraft('')}}><div style={{position:'relative',overflow:'hidden',borderRadius:12,background:'var(--background)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-middle)'}}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="想做什么?" style={{display:'block',width:'100%',minHeight:88,maxHeight:540,boxSizing:'border-box',resize:'none',padding:'15px 15px 11.25px 18.75px',border:0,outline:0,color:'var(--foreground)',background:'transparent',font:'inherit',fontSize:14,lineHeight:1.25}}/>
          <div style={{display:'flex',alignItems:'center',gap:4,padding:8,borderTop:'1px solid color-mix(in srgb,var(--border) 50%,transparent)'}}><div style={{minWidth:128,display:'flex',alignItems:'center',gap:4,overflow:'hidden'}}><InputBadge icon={<Paperclip size={16}/>} label="附加文件"/><InputBadge icon={<DatabaseZap size={16}/>} label="选择数据源" chevron/><InputBadge icon={<FileText size={16}/>} label="Work in Folder" chevron/></div><div style={{flex:1}}/><button type="submit" aria-label="发送消息" disabled={!draft.trim()} style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginLeft:8,padding:0,border:0,borderRadius:9999,color:'var(--background)',background:'var(--foreground)',opacity:draft.trim()?1:.5}}><ArrowUp size={16}/></button></div>
        </div></form>
      </div>
    </div>
  </section>
}

// UserMessageBubble: flex flex-col items-end gap-3 w-full; bubble max-w-[80%]
// bg-user-message-bubble rounded-[16px] px-5 py-3.5.
function UserMessageBubble({ text }) {
  return <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:11.25,width:'100%'}}>
    <div style={{maxWidth:'80%',boxSizing:'border-box',background:'var(--user-message-bubble)',borderRadius:16,padding:'13.125px 18.75px',color:'var(--foreground)',fontSize:14,lineHeight:1.4286,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{text}</div>
  </div>
}

// ChatDisplay assistant branch: flex justify-start; bubble max-w-[90%]
// bg-background shadow-minimal rounded-[8px] pl-6 pr-4 py-3.
function AssistantMessageBubble({ text }) {
  return <div style={{display:'flex',justifyContent:'flex-start',width:'100%'}}>
    <div style={{maxWidth:'90%',boxSizing:'border-box',background:'var(--background)',boxShadow:'var(--shadow-minimal)',borderRadius:8,padding:'11.25px 15px 11.25px 22.5px',color:'var(--foreground)',fontSize:14,lineHeight:1.4286,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{text}</div>
  </div>
}

// ActiveOptionBadges + EmptyStateHint primitives reused verbatim from
// EmptyChat.jsx (the badge row is identical in every session state).
function AskBadge() {
  return <button type="button" style={{height:30,padding:'0 7.5px 0 9.375px',display:'inline-flex',alignItems:'center',gap:5.625,border:0,borderRadius:8,background:'color-mix(in srgb,var(--info) 10%,transparent)',color:'var(--info)','--shadow-color':'var(--info-rgb)',boxShadow:'var(--shadow-tinted)',fontSize:12,fontWeight:500}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01" /></svg><span>询问</span><ChevronDown size={14} style={{opacity:.6}}/></button>
}
function StateBadge() {
  return <button type="button" style={{height:30,padding:'0 15px 0 11.25px',display:'inline-flex',alignItems:'center',gap:5.625,border:0,borderRadius:8,background:'color-mix(in srgb,var(--foreground) 4%,transparent)',color:'var(--foreground)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-tinted)',fontSize:12,fontWeight:500}}><span>待办</span><ChevronDown size={14} style={{opacity:.6}}/></button>
}
function InfoButton() {
  return <button type="button" style={{height:30,padding:'0 13.125px 0 11.25px',display:'inline-flex',alignItems:'center',gap:5.625,flexShrink:0,border:0,borderRadius:8,background:'color-mix(in srgb,var(--background) 97%,var(--foreground) 3%)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-minimal)',color:'color-mix(in srgb,var(--foreground) 80%,transparent)',fontSize:12,fontWeight:500}}><Info size={14}/><span>信息</span></button>
}
function InputBadge({ icon, label, chevron = false }) {
  return <button type="button" aria-label={label} style={{height:28,minWidth:0,display:'inline-flex',alignItems:'center',gap:6,padding:'0 8px',border:0,borderRadius:6,background:'transparent',color:'var(--foreground)',fontSize:13}}><span style={{display:'inline-flex',flexShrink:0}}>{icon}</span><span style={{maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',opacity:.5}}>{label}</span>{chevron && <ChevronDown size={12} style={{flexShrink:0,opacity:.5}}/>}</button>
}
