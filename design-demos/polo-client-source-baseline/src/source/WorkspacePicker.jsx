import { useState } from 'react'
import { Cloud, FolderOpen, FolderPlus, Plus } from 'lucide-react'

// Renderer WorkspacePicker loading/empty fixtures and the source's first
// WorkspaceCreationScreen choice step. There are deliberately no fabricated
// remote workspaces: the list is IPC-owned runtime data.
export function SourceWorkspacePicker({ state }) {
  if (state === 'loading') return <PickerLoading />
  if (['create', 'open-folder', 'connect-remote'].includes(state)) return <CreationChoice />
  return <PickerEmpty />
}

function Shell({ children }) { return <div data-route="workspace-picker" style={{ display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', padding: 16, boxSizing: 'border-box', background: 'var(--sidebar, var(--foreground-2, var(--background)))' }}>{children}</div> }
function Container({ children }) { return <section style={{ display: 'flex', width: '100%', maxWidth: 448, flexDirection: 'column', alignItems: 'center', boxSizing: 'border-box' }}>{children}</section> }
function Spinner() {
  return <span aria-label="Loading" style={{ width: 24, height: 24, border: '2px solid color-mix(in srgb, var(--foreground) 18%, transparent)', borderTopColor: 'var(--foreground)', borderRadius: 9999 }}/>
}
function PickerLoading(){ return <Shell><Container><Spinner/><p style={{ margin: '12px 0 0', color: 'var(--muted-foreground)', fontSize: 14 }}>Loading workspaces...</p></Container></Shell> }
function PickerEmpty(){ const [name,setName]=useState('');return <Shell><Container><Header title="Select Workspace" description="Choose a workspace on this server, or create a new one."/><div style={{ width:'100%', margin:'20px 0 16px', borderTop:'1px solid var(--border)' }}/><div style={{ display:'grid', width:'100%', gap:8 }}><input value={name} onChange={e=>setName(e.target.value)} placeholder="New workspace name" style={{ height:38, boxSizing:'border-box', padding:'0 12px', border:'1px solid var(--border)', borderRadius:6, outline:0, color:'var(--foreground)', background:'transparent', fontSize:14 }}/><button type="button" disabled={!name.trim()} style={{ display:'inline-flex', height:36, alignItems:'center', justifyContent:'center', gap:6, border:0, borderRadius:6, color:'#fff', background:'var(--accent)', opacity:name.trim()?1:.5, fontSize:14, fontWeight:500 }}><Plus size={16}/>Create workspace</button></div></Container></Shell> }
function CreationChoice(){ return <div data-route="workspace-creation/choice" style={{ display:'grid', width:'100%', height:'100%', minHeight:0, placeItems:'center', padding:32, boxSizing:'border-box', background:'var(--background)' }}><Container><Header title="Add Workspace…" description="Where your ideas meet the tools to make them happen."/><div style={{ width:'100%', marginTop:32, display:'grid', gap:12 }}><Choice icon={FolderPlus} title="Create new" description="Start fresh with an empty workspace." accent/><Choice icon={FolderOpen} title="Open folder" description="Choose an existing folder as workspace."/><Choice icon={Cloud} title="Connect to remote server" description="Use a remote Polo AI Server."/></div></Container></div> }
function Header({title,description}){return <div style={{ width:'100%', textAlign:'center' }}><h1 style={{ margin:0, color:'var(--foreground)', fontSize:18, fontWeight:600, letterSpacing:'-.025em' }}>{title}</h1><p style={{ maxWidth:384, margin:'8px auto 0', color:'var(--muted-foreground)', fontSize:14,lineHeight:1.5 }}>{description}</p></div>}
function Choice({icon:Icon,title,description,accent=false}){return <button type="button" style={{ display:'flex', width:'100%', alignItems:'center', gap:16, padding:16, border:0, borderRadius:8, color:'var(--foreground)', background:'var(--background)', boxShadow:'var(--shadow-minimal)', textAlign:'left' }}><span style={{ display:'grid', width:40,height:40,flexShrink:0,placeItems:'center',borderRadius:8,color:accent?'var(--accent)':'color-mix(in srgb,var(--foreground) 70%,transparent)',background:accent?'color-mix(in srgb,var(--accent) 10%,transparent)':'color-mix(in srgb,var(--foreground) 5%,transparent)' }}><Icon size={20}/></span><span><strong style={{ display:'block',fontSize:15,fontWeight:500 }}>{title}</strong><small style={{ display:'block',marginTop:-1,color:'var(--muted-foreground)',fontSize:12 }}>{description}</small></span></button>}
