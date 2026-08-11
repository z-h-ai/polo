import { AppWindow, ChevronRight, Eye, HelpCircle, LogOut, Pencil, Settings } from 'lucide-react'

// DesktopAppMenu.tsx's root, closed-submenu visual state. Labels, ordering,
// shortcuts and icon sources are from shared/menu-schema.ts / en.json.
const items = [
  [SquarePenRounded, 'New Chat', '⌘N'], [AppWindow, 'New Window', '⌘⇧N'], 'separator',
  [Pencil, 'Edit'], [Eye, 'View'], [AppWindow, 'Window'], 'separator',
  [Settings, 'Settings'], [HelpCircle, 'Help'], 'separator', [LogOut, 'Quit Polo AI', '⌘Q'],
]
export function SourceDesktopAppMenu(){return <div data-route="app-menu/desktop" style={{display:'grid',width:'100%',height:'100%',minHeight:0,placeItems:'start',padding:'44px 0 0 52px',boxSizing:'border-box',background:'var(--background)'}}><section role="menu" aria-label="Polo AI menu" style={{width:192,padding:4,border:'1px solid color-mix(in srgb,var(--border) 80%,transparent)',borderRadius:8,color:'var(--foreground)',background:'var(--background)',boxShadow:'var(--shadow-modal-small,0 8px 30px rgba(0,0,0,.12))'}}>{items.map((item,index)=>item==='separator'?<hr key={index} style={{height:1,margin:'4px 0',border:0,background:'color-mix(in srgb,var(--border) 65%,transparent)'}}/>:<MenuRow key={item[1]} item={item}/>)}</section></div>}
function MenuRow({item}){const [Icon,label,shortcut]=item;const isSubmenu=['Edit','View','Window','Settings','Help'].includes(label);return <button role="menuitem" type="button" style={{display:'flex',width:'100%',height:30,alignItems:'center',gap:8,padding:'0 8px',border:0,borderRadius:5,color:'var(--foreground)',background:'transparent',fontSize:13,textAlign:'left'}}><Icon size={14} strokeWidth={1.8}/><span style={{flex:1}}>{label}</span>{isSubmenu?<ChevronRight size={14}/>:shortcut&&<span style={{color:'var(--muted-foreground)',fontSize:12}}>{shortcut}</span>}</button>}
function SquarePenRounded({ size = 14 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg> }
