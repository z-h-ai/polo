import { X } from 'lucide-react'
import { navigate } from '../runtime/state.js'

// KeyboardShortcutsDialog.tsx: DialogContent (popover-styled, radius 8, no
// border, shadow-modal-small, gap-4 p-6) at sm:max-w-[500px] max-h-[80vh]
// overflow-y-auto, DialogTitle text-lg font-semibold, close button
// top-4 right-4 rounded-xs opacity-70 with a size-4 X. Sections mirror
// actions/definitions.ts categories (General/Navigation/View/Navigator/Chat)
// plus the four component-specific sections. Registry rows come from
// useActionLabel; zh-Hans labels from zh-Hans.json shortcuts.action.* /
// shortcuts.category.* / shortcuts.*. Mac hotkey display.
const registry = [
  ['通用', [['新建聊天','⌘N'],['在面板中新建聊天','⌘T'],['设置','⌘,'],['切换主题','⌘⇧A'],['搜索','⌘F'],['键盘快捷键','⌘/'],['新建窗口','⌘⇧N'],['退出','⌘Q']]],
  ['导航', [['聚焦侧栏','⌘1'],['聚焦导航器','⌘2'],['聚焦聊天','⌘3'],['聚焦下一区域','Tab'],['后退','⌘['],['前进','⌘]'],['后退','⌘←'],['前进','⌘→'],['聚焦下一面板','⌘⇧]'],['聚焦上一面板','⌘⇧[']]],
  ['视图', [['切换侧栏','⌘B'],['切换专注模式','⌘.']]],
  ['导航器', [['全选','⌘A'],['清除选择','Esc']]],
  ['聊天', [['停止处理','Esc'],['切换权限模式','⇧Tab'],['下一个搜索匹配','⌘G'],['上一个搜索匹配','⌘⇧G']]],
]
const contextual = [
  ['列表导航', [['在列表中导航','↑','↓'],['跳到第一项','Home'],['跳到最后一项','End']]],
  ['会话列表', [['聚焦聊天输入框','Enter'],['删除会话','Delete'],['重命名会话','R'],['打开上下文菜单','Right-click'],['添加为排除筛选','⌥','Click']]],
  ['智能体树', [['折叠文件夹','←'],['展开文件夹','→']]],
  ['聊天输入', [['发送消息','Enter'],['换行','⇧','Enter'],['关闭对话框 / 取消聚焦','Esc']]],
]

// The registry body wraps in space-y-6 py-2; DialogContent contributes the
// p-6 frame and gap-4 between header and body.
export function SourceKeyboardShortcutsDialog() {
  const close = () => navigate({ scene: 'home' })
  return <div data-route="dialog/keyboard-shortcuts" style={{ display: 'grid', width: '100%', height: '100%', minHeight: 0, placeItems: 'center', background: 'rgba(0,0,0,.5)' }}>
    <section role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" style={{ position: 'relative', width: 'calc(100% - 32px)', maxWidth: 500, maxHeight: '80vh', boxSizing: 'border-box', overflowY: 'auto', padding: 22.5, borderRadius: 8, color: 'var(--foreground)', background: 'var(--background)', boxShadow: 'var(--shadow-modal-small)' }}>
      <button type="button" onClick={close} aria-label="Close" style={{ position: 'absolute', top: 15, right: 15, display: 'grid', width: 15, height: 15, padding: 0, placeItems: 'center', border: 0, borderRadius: 2, color: 'var(--foreground)', background: 'transparent', opacity: .7 }}><X size={15}/></button>
      <h1 id="shortcuts-title" style={{ margin: 0, fontSize: 16.875, fontWeight: 600, lineHeight: 1 }}>键盘快捷键</h1>
      <div style={{ display: 'grid', gap: 22.5, padding: '7.5px 0' }}>{[...registry, ...contextual].map(([title, rows]) => <ShortcutSection key={title} title={title} rows={rows}/>)}</div>
    </section>
  </div>
}
// Section heading: text-xs font-semibold text-muted-foreground uppercase
// tracking-wide mb-2; rows space-y-1.5 with py-1 text-sm labels and a Kbd
// cluster (min-w-[20px] h-5 px-1.5 text-[11px] bg-muted border rounded
// shadow-sm — the min-width is an exact 20px arbitrary value).
function ShortcutSection({ title, rows }) { return <section><h3 style={{ margin: '0 0 7.5px', color: 'var(--fg-50)', fontSize: 11.25, fontWeight: 600, letterSpacing: '.025em', textTransform: 'uppercase' }}>{title}</h3><div style={{ display: 'grid', gap: 5.625 }}>{rows.map(([label, ...keys], i) => <div key={title + i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3.75px 0' }}><span style={{ fontSize: 13.125 }}>{label}</span><span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 3.75 }}>{keys.map((key, index) => <kbd key={index} style={{ display: 'inline-flex', minWidth: 20, height: 18.75, boxSizing: 'border-box', alignItems: 'center', justifyContent: 'center', padding: '0 5.625px', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--foreground)', background: 'var(--fg-5)', boxShadow: '0 1px 2px 0 rgba(0,0,0,.05)', fontFamily: 'inherit', fontSize: 11, fontWeight: 500 }}>{key}</kbd>)}</span></div>)}</div></section> }
