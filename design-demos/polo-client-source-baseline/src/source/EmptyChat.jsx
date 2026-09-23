import * as React from 'react'
import { ArrowUp, Check, ChevronDown, DatabaseZap, FileText, Info, Paperclip, RefreshCw, ShieldAlert, X } from 'lucide-react'

// EntityBadge (EmptyStateHint.tsx:150): shadow-minimal, 40% label.
const entityBadgeStyle = { display:'inline-flex', padding:'2px 10px 2px 8px', margin:'0 2px', borderRadius:8, background:'color-mix(in srgb, var(--foreground) 5%, transparent)', boxShadow:'var(--shadow-minimal)', color:'color-mix(in srgb, var(--foreground) 40%, transparent)' }

function ShareGlyph() {
  // Exact ChatPage.tsx share SVG path.
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" /></svg>
}

// AskBadge (ActiveOptionBadges.tsx): h-[30px] pl-2.5 pr-2 rounded-[8px]
// bg-info/10 text-info text-xs font-medium, shadow-tinted with --shadow-color
// set to --info-rgb (index.css shadow-tinted).
function AskBadge() {
  return <button type="button" style={{height:30,padding:'0 7.5px 0 9.375px',display:'inline-flex',alignItems:'center',gap:5.625,border:0,borderRadius:8,background:'color-mix(in srgb,var(--info) 10%,transparent)',color:'var(--info)','--shadow-color':'var(--info-rgb)',boxShadow:'var(--shadow-tinted)',fontSize:12,fontWeight:500}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01" /></svg><span>询问</span><ChevronDown size={14} style={{opacity:.6}}/></button>
}

// StateBadge (ActiveOptionBadges.tsx StateBadge): MetadataBadge h-[30px]
// pl-3 pr-4 rounded-[8px] with a chevron.
function StateBadge() {
  return <button type="button" style={{height:30,padding:'0 15px 0 11.25px',display:'inline-flex',alignItems:'center',gap:5.625,border:0,borderRadius:8,background:'color-mix(in srgb,var(--foreground) 4%,transparent)',color:'var(--foreground)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-tinted)',fontSize:12,fontWeight:500}}><span>待办</span><ChevronDown size={14} style={{opacity:.6}}/></button>
}

// FilesPopoverButton (ActiveOptionBadges.tsx:393-419): Info button on the
// badge row's right edge.
function InfoButton() {
  return <button type="button" style={{height:30,padding:'0 13.125px 0 11.25px',display:'inline-flex',alignItems:'center',gap:5.625,flexShrink:0,border:0,borderRadius:8,background:'color-mix(in srgb,var(--background) 97%,var(--foreground) 3%)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-minimal)',color:'color-mix(in srgb,var(--foreground) 80%,transparent)',fontSize:12,fontWeight:500}}><Info size={14}/><span>信息</span></button>
}

function InputBadge({ icon, label, chevron = false }) {
  return <button type="button" aria-label={label} style={{height:28,minWidth:0,display:'inline-flex',alignItems:'center',gap:6,padding:'0 8px',border:0,borderRadius:6,background:'transparent',color:'var(--foreground)',fontSize:13}}><span style={{display:'inline-flex',flexShrink:0}}>{icon}</span><span style={{maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',opacity:.5}}>{label}</span>{chevron && <ChevronDown size={12} style={{flexShrink:0,opacity:.5}}/>}</button>
}

// PermissionRequest.tsx structured input, rendered in place of the free-form
// composer for the chat-permission scene.
function PermissionRequestCard() {
  return <div style={{ overflow:'hidden', flex:1, display:'flex', flexDirection:'column', minHeight:0, borderRadius:8, border:'1px solid color-mix(in srgb,var(--info) 30%,transparent)', background:'color-mix(in srgb,var(--info) 5%,transparent)', boxShadow:'var(--shadow-middle)'}}>
    <div style={{ padding:16, display:'flex', flexDirection:'column', gap:11.25, flex:1, minHeight:0, overflowY:'auto' }}>
      <div style={{ display:'grid', gap:7.5, paddingBottom:4 }}>
        <div style={{ display:'flex', alignItems:'center', gap:5.625, fontSize:14, fontWeight:500, color:'var(--foreground)' }}><ShieldAlert style={{width:13.125,height:13.125,color:'var(--info)'}}/><span>需要权限</span></div>
        <div style={{ fontSize:12, lineHeight:'18px', color:'var(--fg-50)' }}><span style={{ fontWeight:500, color:'var(--foreground)' }}>Tool:</span> bash<br/>git push origin main</div>
      </div>
      <div style={{ background:'color-mix(in srgb,var(--foreground) 5%,transparent)', borderRadius:5.625, padding:11.25, fontFamily:'var(--font-mono)', fontSize:12, color:'color-mix(in srgb,var(--foreground) 90%,transparent)', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:90, overflowY:'auto' }}>git push origin main</div>
    </div>
    <div style={{ flexShrink:0, display:'flex', flexWrap:'wrap', alignItems:'center', gap:7.5, padding:'7.5px 11.25px', borderTop:'1px solid color-mix(in srgb,var(--border) 50%,transparent)' }}>
      <button type="button" style={{ display:'inline-flex', height:28, alignItems:'center', gap:5.625, padding:'0 11.25px', borderRadius:5.625, background:'var(--foreground)', color:'var(--background)', fontSize:12, fontWeight:500 }}><Check size={13.125}/>Allow</button>
      <button type="button" style={{ display:'inline-flex', height:28, alignItems:'center', gap:5.625, padding:'0 11.25px', borderRadius:5.625, border:'1px solid color-mix(in srgb,var(--foreground) 10%,transparent)', color:'var(--foreground)', fontSize:12, fontWeight:500 }}><RefreshCw size={13.125}/>Always Allow</button>
      <button type="button" style={{ display:'inline-flex', height:28, alignItems:'center', gap:5.625, padding:'0 11.25px', borderRadius:5.625, border:'1px dashed color-mix(in srgb,var(--destructive) 50%,transparent)', color:'var(--destructive)', fontSize:12, fontWeight:500 }}><X size={13.125}/>Deny</button>
      <span style={{ minWidth:0, flex:1, color:'var(--fg-50)', fontSize:10, textAlign:'right' }}>"Always Allow" remembers this command for the session</span>
    </div>
  </div>
}

// Source: ChatPage.tsx, PanelHeader.tsx, ChatDisplay.tsx, ChatInputZone.tsx,
// InputContainer.tsx and FreeFormInput.tsx. Fixture is the no-message session:
// the desktop message area renders an empty masked ScrollArea with no content.
export function SourceFaithfulEmptyChat({ permission = false }) {
  const [draft, setDraft] = React.useState('')
  return <section aria-label="会话" style={{height:'100%',minWidth:0,display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}>
    <header style={{height:42,minHeight:42,display:'flex',alignItems:'center',gap:6,paddingLeft:16,paddingRight:8,position:'relative',zIndex:1}}>
      {/* PanelHeader centers its title block (mx-auto) when there is no
          leading action; title is session.defaultTitle. */}
      <div style={{minWidth:0,flex:1,display:'flex',alignItems:'center',justifyContent:'center',userSelect:'none'}}><button type="button" style={{minWidth:0,display:'inline-flex',alignItems:'center',gap:4,padding:'4px 8px',border:0,borderRadius:6,color:'var(--foreground)',background:'transparent'}}><h1 style={{margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'var(--font-sans)',fontSize:14,fontWeight:600,lineHeight:1.25}}>新聊天</h1><ChevronDown size={14} style={{flexShrink:0,color:'var(--fg-50)',transform:'translateY(1px)'}}/></button></div>
      <button type="button" aria-label="共享会话" style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,padding:6,border:0,borderRadius:6,color:'color-mix(in srgb,var(--foreground) 70%,transparent)',background:'var(--background)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-minimal)',opacity:.7}}><ShareGlyph/></button>
    </header>
    <div style={{minHeight:0,minWidth:0,flex:1,display:'flex',flexDirection:'column',position:'relative'}}>
      {/* ChatDisplay empty session: an empty masked scroll area, no content. */}
      <main style={{minHeight:0,flex:1,overflowY:'auto',WebkitMaskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)',maskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)'}}/>
      <div style={{width:'100%',maxWidth:840,boxSizing:'border-box',margin:'4px auto 0',padding:'1px 20px 16px'}}>
        <div style={{minHeight:33,display:'flex',alignItems:'flex-start',gap:8,marginBottom:8,padding:'1px 1px 2px'}}><AskBadge/><StateBadge/><span style={{flex:1}}/><InfoButton/></div>
        {permission
          ? <PermissionRequestCard/>
          : <form onSubmit={e => {e.preventDefault(); if(draft.trim()) setDraft('')}}><div style={{position:'relative',overflow:'hidden',borderRadius:12,background:'var(--background)','--shadow-color':'var(--foreground-rgb)',boxShadow:'var(--shadow-middle)'}}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="想做什么?" style={{display:'block',width:'100%',minHeight:88,maxHeight:540,boxSizing:'border-box',resize:'none',padding:'15px 15px 11.25px 18.75px',border:0,outline:0,color:'var(--foreground)',background:'transparent',font:'inherit',fontSize:14,lineHeight:1.25}}/>
          <div style={{display:'flex',alignItems:'center',gap:4,padding:8,borderTop:'1px solid color-mix(in srgb,var(--border) 50%,transparent)'}}><div style={{minWidth:128,display:'flex',alignItems:'center',gap:4,overflow:'hidden'}}><InputBadge icon={<Paperclip size={16}/>} label="附加文件"/><InputBadge icon={<DatabaseZap size={16}/>} label="选择数据源" chevron/><InputBadge icon={<FileText size={16}/>} label="Work in Folder" chevron/></div><div style={{flex:1}}/><button type="submit" aria-label="发送消息" disabled={!draft.trim()} style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginLeft:8,padding:0,border:0,borderRadius:9999,color:'var(--background)',background:'var(--foreground)',opacity:draft.trim()?1:.5}}><ArrowUp size={16}/></button></div>
        </div></form>}
      </div>
    </div>
  </section>
}
