import { AppWindow, ChevronRight, Eye, HelpCircle, LogOut, Pencil, Settings } from 'lucide-react'

// DesktopAppMenu.tsx's root, closed-submenu visual state, styled per
// packages/ui StyledDropdown.tsx: popover-styled content (radius 8, no border,
// shadow-modal-small, p-1 = 7.5px, flex flex-col gap-0.5 = 3.75px, text-xs),
// items px-2 py-1.5 pr-4 text-sm rounded-[4px] with h-3.5 w-3.5 icons,
// sub-triggers pr-1.5 with a size-4 chevron, separators bg-foreground/10
// -mx-1 my-1, and shortcuts text-muted-foreground text-xs tracking-widest
// (0.1em) pl-6 = 22.5px. Labels are zh-Hans from zh-Hans.json; shortcuts are
// the Mac column of menu-schema.ts. minWidth min-w-48 = 360px.
const items = [
  [SquarePenRounded, '新建聊天', '⌘N'], [AppWindow, '新建窗口', '⌘⇧N'], 'separator',
  [Pencil, '编辑'], [Eye, '视图'], [AppWindow, '窗口'], 'separator',
  [Settings, '设置'], [HelpCircle, '帮助'], 'separator', [LogOut, '退出 Polo AI', '⌘Q'],
]
export function SourceDesktopAppMenu(){return <div data-route="app-menu/desktop" style={{display:'grid',width:'100%',height:'100%',minHeight:0,placeItems:'start',padding:'44px 0 0 52px',boxSizing:'border-box',background:'var(--background)'}}><section role="menu" aria-label="Polo AI 菜单" style={{width:'fit-content',minWidth:360,padding:7.5,borderRadius:8,color:'var(--foreground)',background:'var(--background)',boxShadow:'var(--shadow-modal-small)',display:'flex',flexDirection:'column',gap:3.75,fontSize:11.25,whiteSpace:'nowrap'}}>{items.map((item,index)=>item==='separator'?<hr key={index} style={{height:1,margin:'3.75px -7.5px',border:0,background:'color-mix(in srgb,var(--foreground) 10%,transparent)'}}/>:<MenuRow key={item[1]} item={item}/>)}</section></div>}
function MenuRow({item}){const [Icon,label,shortcut]=item;const isSubmenu=['编辑','视图','窗口','设置','帮助'].includes(label);return <button role="menuitem" type="button" style={{position:'relative',display:'flex',width:'100%',alignItems:'center',gap:7.5,padding:'5.625px 15px 5.625px 7.5px',border:0,borderRadius:4,color:'var(--foreground)',background:'transparent',fontSize:13.125,textAlign:'left'}}><Icon size={13.125}/><span style={{flex:1}}>{label}</span>{isSubmenu?<ChevronRight size={15} style={{marginLeft:'auto'}}/>:shortcut&&<span style={{color:'var(--fg-50)',fontSize:11.25,letterSpacing:'.1em',paddingLeft:22.5}}>{shortcut}</span>}</button>}
function SquarePenRounded({ size = 13.125 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-5"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg> }
