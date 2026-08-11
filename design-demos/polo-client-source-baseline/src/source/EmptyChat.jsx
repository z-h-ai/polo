import * as React from 'react'
import { ArrowUp, ChevronDown, DatabaseZap, Paperclip } from 'lucide-react'

const entityBadgeStyle = { display:'inline-flex', padding:'2px 10px 2px 8px', margin:'0 2px', borderRadius:8, background:'color-mix(in srgb, var(--foreground) 5%, transparent)', boxShadow:'0 1px 2px rgba(0,0,0,.05)', color:'color-mix(in srgb, var(--foreground) 40%, transparent)' }

function ShareGlyph() {
  // Exact ChatPage.tsx share SVG path.
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" /></svg>
}

function AskBadge() {
  return <button type="button" style={{height:30,padding:'0 8px 0 10px',display:'inline-flex',alignItems:'center',gap:6,border:0,borderRadius:8,background:'color-mix(in srgb,var(--info) 10%,transparent)',color:'var(--info)',boxShadow:'0 1px 2px color-mix(in srgb,var(--info) 18%,transparent)',fontSize:12,fontWeight:500}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01" /></svg><span>Ask</span><ChevronDown size={14} style={{opacity:.6}}/></button>
}

function InputBadge({ icon, label, chevron = false }) {
  return <button type="button" aria-label={label} style={{height:28,minWidth:0,display:'inline-flex',alignItems:'center',gap:6,padding:'0 8px',border:0,borderRadius:6,background:'transparent',color:'var(--foreground)',fontSize:13}}><span style={{display:'inline-flex',flexShrink:0}}>{icon}</span><span style={{maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',opacity:.6}}>{label}</span>{chevron && <ChevronDown size={12} style={{flexShrink:0,opacity:.5}}/>}</button>
}

// Source: ChatPage.tsx, PanelHeader.tsx, ChatDisplay.tsx, ChatInputZone.tsx,
// InputContainer.tsx and FreeFormInput.tsx. Fixture is the no-message session.
export function SourceFaithfulEmptyChat() {
  const [draft, setDraft] = React.useState('')
  return <section aria-label="Session" style={{height:'100%',minWidth:0,display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}>
    <header style={{height:42,minHeight:42,display:'flex',alignItems:'center',gap:6,paddingLeft:16,paddingRight:8,position:'relative',zIndex:1}}>
      <div style={{minWidth:0,flex:1,display:'flex',alignItems:'center',userSelect:'none'}}><button type="button" style={{minWidth:0,display:'inline-flex',alignItems:'center',gap:4,padding:'4px 8px',border:0,borderRadius:6,color:'var(--foreground)',background:'transparent'}}><h1 style={{margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontFamily:'var(--font-sans)',fontSize:14,fontWeight:600,lineHeight:1.25}}>Session</h1><ChevronDown size={14} style={{flexShrink:0,color:'color-mix(in srgb,var(--foreground) 55%,transparent)',transform:'translateY(1px)'}}/></button></div>
      <button type="button" aria-label="Share session" style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,padding:6,border:0,borderRadius:6,color:'color-mix(in srgb,var(--foreground) 70%,transparent)',background:'var(--background)',boxShadow:'0 1px 2px rgba(0,0,0,.08)',opacity:.7}}><ShareGlyph/></button>
    </header>
    <div style={{minHeight:0,minWidth:0,flex:1,display:'flex',flexDirection:'column',position:'relative'}}>
      <main style={{minHeight:0,flex:1,overflowY:'auto',WebkitMaskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)',maskImage:'linear-gradient(to bottom,transparent 0%,black 32px,black calc(100% - 32px),transparent 100%)'}}>
        <div style={{width:'100%',maxWidth:840,boxSizing:'border-box',minHeight:'100%',margin:'0 auto',padding:'32px 20px',display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{maxWidth:448,userSelect:'none',color:'var(--foreground)',textAlign:'center',fontSize:20,fontWeight:700,lineHeight:1.625,letterSpacing:'-.025em'}}>Summarize your <span style={entityBadgeStyle}>Gmail</span> inbox, draft replies, and save notes to <span style={entityBadgeStyle}>Polo AI</span></div></div>
      </main>
      <div style={{width:'100%',maxWidth:840,boxSizing:'border-box',margin:'4px auto 0',padding:'1px 16px 16px'}}>
        <div style={{minHeight:33,display:'flex',alignItems:'flex-start',gap:8,marginBottom:8,padding:'1px 1px 2px'}}><AskBadge/></div>
        <form onSubmit={e => {e.preventDefault(); if(draft.trim()) setDraft('')}}><div style={{position:'relative',overflow:'hidden',borderRadius:12,background:'var(--background)',boxShadow:'0 1px 2px rgba(0,0,0,.08)'}}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="What would you like to work on?" spellCheck style={{display:'block',width:'100%',minHeight:88,maxHeight:300,boxSizing:'border-box',resize:'none',padding:'16px 16px 12px 20px',border:0,outline:0,color:'var(--foreground)',background:'transparent',font:'inherit',lineHeight:1.5}}/>
          <div style={{display:'flex',alignItems:'center',gap:4,padding:8,borderTop:'1px solid color-mix(in srgb,var(--border) 50%,transparent)'}}><div style={{minWidth:128,display:'flex',alignItems:'center',gap:4,overflow:'hidden'}}><InputBadge icon={<Paperclip size={16}/>} label="Attach Files"/><InputBadge icon={<DatabaseZap size={16}/>} label="Choose Sources" chevron/></div><div style={{flex:1}}/><button type="submit" aria-label="Send message" disabled={!draft.trim()} style={{width:28,height:28,display:'inline-flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginLeft:8,padding:0,border:0,borderRadius:9999,color:'var(--background)',background:draft.trim()?'var(--foreground)':'color-mix(in srgb,var(--foreground) 12%,transparent)',opacity:draft.trim()?1:.5}}><ArrowUp size={16}/></button></div>
        </div></form>
      </div>
    </div>
  </section>
}
