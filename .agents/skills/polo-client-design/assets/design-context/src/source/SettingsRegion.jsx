import { Children, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  Copy,
  Eye,
  Keyboard,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  Plus,
  ShieldCheck,
  Sun,
  Tag,
  ToggleRight,
  UserCircle,
} from 'lucide-react'
import { navigate } from '../runtime/state.js'
import telegramIcon from '../../assets/messaging-icons/telegram.svg'
import whatsappIcon from '../../assets/messaging-icons/whatsapp.svg'
import larkIcon from '../../assets/messaging-icons/lark.svg'

// Settings route translated from SettingsNavigator.tsx + every
// pages/settings/*.tsx page + the settings primitives (SettingsSection/
// SettingsCard/SettingsRow/SettingsToggle/SettingsSegmentedControl/
// SettingsMenuSelect[Row]/SettingsInput/SettingsTextarea) and ui/switch.tsx.
// Root font-size is 15px, so Tailwind rem values are written verbatim in px.
// The navigator follows getVisibleSettingsItems for a fresh profile: no admin
// login (account-security hidden) and no embeddedServer flag (server filtered
// out of SETTINGS_ITEMS); the server page still exists behind its own scene
// state for review. Copy is zh-Hans from zh-Hans.json.
const settingsItems = [
  { id: 'app', label: '应用', description: '通知和更新', Icon: ToggleRight },
  { id: 'appearance', label: '外观', description: '主题、字体、工具图标', Icon: Palette },
  { id: 'input', label: '输入', description: '发送键、拼写检查', Icon: Keyboard },
  { id: 'workspace', label: 'Workspace', description: '名称、图标、工作目录', Icon: Building2 },
  { id: 'permissions', label: '权限', description: '探索模式规则', Icon: ShieldCheck },
  { id: 'labels', label: '标签', description: '管理会话标签', Icon: Tag },
  { id: 'messaging', label: 'Messaging', description: '连接 Telegram、WhatsApp、飞书 / Lark', Icon: MessageSquare },
  { id: 'shortcuts', label: '快捷键', description: '键盘快捷键', Icon: Keyboard },
  { id: 'preferences', label: '偏好', description: '用户偏好', Icon: UserCircle },
]

const border50 = 'color-mix(in srgb, var(--border) 50%, transparent)'
const fg15 = 'color-mix(in srgb, var(--foreground) 15%, transparent)'
const fg2 = 'color-mix(in srgb, var(--foreground) 2%, transparent)'
const fg5 = 'color-mix(in srgb, var(--foreground) 5%, transparent)'
const muted = 'var(--fg-50)'

// PanelHeader title + SettingsNavigator list. Selecting a row navigates the
// scene state to the subpage id, so ?scene=settings&state=appearance renders
// that page inside the same shell.
export function SourceSettingsNavigator({ selectedSubpage = 'app' }) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div className="source-navigator__header"><span className="source-navigator__header-title">设置</span></div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ paddingTop: 7.5 }}>
        {settingsItems.map((item, index) => <SourceSettingsRow key={item.id} item={item} selected={item.id === selectedSubpage} isFirst={index === 0} onSelect={() => navigate({ state: item.id })} />)}
      </div>
    </div>
  </div>
}

function SourceSettingsRow({ item, selected, isFirst, onSelect }) {
  const [hovered, setHovered] = useState(false)
  const Icon = item.Icon
  return <div>
    {/* Separator: pl-12 pr-4 wrapper around a 1px bg-border line. */}
    {!isFirst && <div aria-hidden="true" style={{ paddingLeft: 45, paddingRight: 22.5 }}><div style={{ height: 1, background: 'var(--border)' }} /></div>}
    <div style={{ position: 'relative', paddingLeft: 7.5, marginRight: 7.5 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ pointerEvents: 'none', position: 'absolute', zIndex: 1, top: 14, left: 20, color: selected ? 'var(--foreground)' : muted }}><Icon size={15} /></div>
      <button
        type="button"
        onClick={onSelect}
        style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 7.5, padding: '11.25px 22.5px 11.25px 7.5px', border: 0, borderRadius: 8, outline: 'none', background: selected ? fg5 : hovered ? fg2 : 'transparent', color: 'var(--foreground)', cursor: 'pointer', textAlign: 'left', transition: 'background-color 75ms' }}
      >
        <div style={{ flexShrink: 0, width: 22.5, height: 18.75 }} />
        <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column' }}>
          <span style={{ fontWeight: 500, fontSize: 13.125, lineHeight: 1.25, color: selected ? 'var(--foreground)' : 'color-mix(in srgb, var(--foreground) 80%, transparent)' }}>{item.label}</span>
          <span style={{ overflow: 'hidden', color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', fontSize: 11.25, lineHeight: 1.35, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.description}</span>
        </div>
      </button>
      {/* Row menu: opacity-0 until hover, p-1.5 trigger inside a rounded-[8px]
          border-transparent hover:border wrapper (SettingsNavigator.tsx:123-147). */}
      <div style={{ position: 'absolute', zIndex: 1, right: 7.5, top: 7.5, opacity: hovered ? 1 : 0, transition: 'opacity 150ms' }}>
        <div style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', borderRadius: 8, border: `1px solid ${hovered ? border50 : 'transparent'}` }}>
          <div style={{ padding: 5.625, cursor: 'pointer', color: muted }}><MoreHorizontal size={15} /></div>
        </div>
      </div>
    </div>
  </div>
}

// PanelHeader + HeaderMenu trigger (HeaderIconButton + MoreHorizontal h-4 w-4).
function PageHeader({ title }) {
  return <div className="source-navigator__header" style={{ zIndex: 50 }}>
    <span className="source-navigator__header-title">{title}</span>
    <button type="button" aria-label="更多选项" className="source-navigator__header-button"><MoreHorizontal size={15} /></button>
  </div>
}

// settingsUI constants: label text-sm font-medium, description text-sm muted.
const labelStyle = { fontSize: 13.125, fontWeight: 500, lineHeight: 1.35 }
const descriptionStyle = { fontSize: 13.125, lineHeight: 1.35, color: muted }

function SourceSwitch({ checked, onChange }) {
  // ui/switch.tsx: track w-8 h-[1.15rem], unchecked bg-foreground/15, checked
  // bg-foreground, shadow-xs; thumb size-4 bg-background, checked
  // translate-x-[calc(100%-2px)] = 14px at a 16px thumb.
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, width: 30, height: 17.25, alignItems: 'center', border: '1px solid transparent', borderRadius: 9999, background: checked ? 'var(--foreground)' : fg15, boxShadow: '0 1px 2px 0 rgba(0,0,0,.05)', outline: 'none', transition: 'all 150ms' }}>
    <span style={{ display: 'block', width: 16, height: 16, borderRadius: 9999, background: 'var(--background)', transform: checked ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 150ms' }} />
  </button>
}

function SettingsCard({ children }) {
  // SettingsCard: rounded-xl bg-background shadow-minimal, children separated
  // by h-px bg-border/50 mx-4 dividers.
  const items = Children.toArray(children).filter(Boolean)
  return <div style={{ overflow: 'hidden', borderRadius: 11.25, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>
    {items.map((child, index) => <div key={index}>{index > 0 && <div aria-hidden="true" style={{ height: 1, marginLeft: 15, marginRight: 15, background: border50 }} />}{child}</div>)}
  </div>
}

function SettingsSection({ title, description, action, children }) {
  // SettingsSection: space-y-3 with a pl-1 header row (title + optional
  // description at text-sm muted, optional action right), h3 text-base
  // font-semibold.
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 11.25 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 15, paddingLeft: 3.75 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1.875 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35, color: 'var(--foreground)' }}>{title}</h3>
        {description && <p style={{ margin: 0, fontSize: 13.125, lineHeight: 1.35, color: muted }}>{description}</p>}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
    {children}
  </section>
}

function SettingsToggle({ label, description, checked, onChange }) {
  // SettingsToggle: px-4 py-3.5 row, settingsUI label/description, Switch ml-4.
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13.125px 15px' }}>
    <label style={{ flex: 1, minWidth: 0, cursor: 'pointer', userSelect: 'none' }}>
      <div style={labelStyle}>{label}</div>
      <div style={descriptionStyle}>{description}</div>
    </label>
    <div style={{ marginLeft: 15, flexShrink: 0 }}><SourceSwitch checked={checked} onChange={onChange} /></div>
  </div>
}

function SettingsRow({ label, description, children, action }) {
  // SettingsRow: px-4 py-3.5, flex-1 label block, control cluster ml-4 gap-3
  // (children then action).
  return <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left', padding: '13.125px 15px' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
      {description && <div style={descriptionStyle}>{description}</div>}
    </div>
    {(children || action) && <div style={{ display: 'flex', alignItems: 'center', gap: 11.25, marginLeft: 15, flexShrink: 0 }}>{children}{action}</div>}
  </div>
}

// SettingsMenuSelectRow: label/description block + SettingsMenuSelect trigger
// (h-8 px-3 gap-1 text-sm rounded-lg bg-background shadow-minimal with a
// size-3.5 ChevronDown at opacity-50). The open popover is an interaction
// state, not part of the static fixture.
function SettingsMenuSelectRow({ label, description, value }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13.125px 15px' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
      {description && <div style={descriptionStyle}>{description}</div>}
    </div>
    <div style={{ marginLeft: 15, flexShrink: 0 }}>
      <button type="button" style={{ display: 'inline-flex', height: 30, alignItems: 'center', gap: 3.75, padding: '0 11.25px', border: 0, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 13.125 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
        <ChevronDown size={13.125} style={{ opacity: .5, flexShrink: 0 }} />
      </button>
    </div>
  </div>
}

// SettingsSegmentedControl: inline-flex gap-1; selected item
// bg-background shadow-minimal, unselected bg-transparent hover:bg-foreground/5;
// px-3 py-1.5 text-sm with an optional size-4 icon.
function SettingsSegmentedControl({ value, options, onChange }) {
  return <div role="radiogroup" style={{ display: 'inline-flex', gap: 3.75 }}>
    {options.map(option => {
      const selected = option.value === value
      const Icon = option.Icon
      return <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => onChange(option.value)} style={{ display: 'flex', alignItems: 'center', gap: 5.625, padding: '5.625px 11.25px', border: 0, borderRadius: 8, background: selected ? 'var(--background)' : 'transparent', boxShadow: selected ? 'var(--shadow-minimal)' : 'none', color: selected ? 'var(--foreground)' : muted, fontSize: 13.125, cursor: 'pointer', transition: 'all 150ms' }}>
        {Icon && <span style={{ width: 15, height: 15, display: 'inline-flex' }}><Icon size={15} /></span>}
        <span>{option.label}</span>
      </button>
    })}
  </div>
}

// SettingsInput: inCard px-4 py-3.5 wrapper; value sits in a relative
// rounded-md shadow-minimal shell whose input is bg-muted/50 border-0.
function SettingsInput({ label, description, value, placeholder, onChange }) {
  return <div style={{ padding: '13.125px 15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15 }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
      {description && <div style={descriptionStyle}>{description}</div>}
    </div>
    <div style={{ display: 'flex', gap: 7.5, marginLeft: 15, flexShrink: 0, flex: 1, maxWidth: 260 }}>
      <div style={{ position: 'relative', flex: 1, borderRadius: 5.625, boxShadow: 'var(--shadow-minimal)', background: 'var(--fg-2)' }}>
        <input value={value} placeholder={placeholder} onChange={event => onChange?.(event.target.value)} style={{ width: '100%', height: 33.75, boxSizing: 'border-box', padding: '0 11.25px', border: 0, outline: 0, borderRadius: 5.625, color: 'var(--foreground)', background: 'transparent', font: 'inherit', fontSize: 13.125 }} />
      </div>
    </div>
  </div>
}

// SettingsTextarea: inCard px-4 py-3.5 wrapper over a rounded-md
// shadow-minimal shell; textarea bg-muted/50 border-0 min-h-[120px].
function SettingsTextarea({ value, placeholder, rows = 4, onChange }) {
  return <div style={{ padding: '13.125px 15px' }}>
    <div style={{ position: 'relative', borderRadius: 5.625, boxShadow: 'var(--shadow-minimal)', background: 'var(--fg-2)' }}>
      <textarea value={value} rows={rows} placeholder={placeholder} onChange={event => onChange?.(event.target.value)} style={{ display: 'block', width: '100%', minHeight: 90, boxSizing: 'border-box', padding: '8.4375px 11.25px', border: 0, outline: 0, borderRadius: 5.625, resize: 'vertical', color: 'var(--foreground)', background: 'transparent', font: 'inherit', fontSize: 13.125, lineHeight: 1.4286 }} />
    </div>
  </div>
}

// Shared page frame: PanelHeader + mask-fade-y scroll + px-5 py-7 max-w-3xl
// content column with space-y-8.
function SettingsPageFrame({ title, children, contentGap = 30 }) {
  return <div style={{ display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' }}>
    <PageHeader title={title} />
    <div style={{ flex: 1, minHeight: 0, maskImage: maskFadeY, WebkitMaskImage: maskFadeY, overflowY: 'auto' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26.25px 18.75px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: contentGap }}>{children}</div>
      </div>
    </div>
  </div>
}

// AppSettingsPage initial state before IPC resolves: notifications on, keep
// awake off, browser tool on, proxy disabled (no inputs rendered), version
// still loading. Terminal-integration section stays hidden: its IPC gate
// (terminalError !== null || terminalStatus?.supported) is false.
function SourceAppSettingsPage() {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)
  const [proxyEnabled, setProxyEnabled] = useState(false)
  // Button outline sm: h-8 px-3 text-xs border-foreground/15.
  const outlineSm = { display: 'inline-flex', height: 30, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'transparent', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }
  return <SettingsPageFrame title="应用">
    <SettingsSection title="通知">
      <SettingsCard>
        <SettingsToggle label="桌面通知" description="AI 在聊天中完成工作时发送通知。" checked={notificationsEnabled} onChange={setNotificationsEnabled} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="电源">
      <SettingsCard>
        <SettingsToggle label="保持屏幕常亮" description="会话运行时防止屏幕关闭。" checked={keepAwakeEnabled} onChange={setKeepAwakeEnabled} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="工具">
      <SettingsCard>
        <SettingsToggle label="内置浏览器" description="如果使用外部浏览器工具 (如 Playwright、Puppeteer 或浏览器 MCP 服务器) 则禁用。" checked={browserToolEnabled} onChange={setBrowserToolEnabled} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="网络">
      <SettingsCard>
        <SettingsToggle label="HTTP 代理" description="通过代理服务器路由网络流量。" checked={proxyEnabled} onChange={setProxyEnabled} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="关于">
      <SettingsCard>
        {/* Version span carries no size class → inherited 15px. */}
        <SettingsRow label="版本"><span style={{ color: muted, fontSize: 15 }}>加载中…</span></SettingsRow>
        <SettingsRow label="检查更新"><button type="button" style={outlineSm}>立即检查</button></SettingsRow>
      </SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// AppearanceSettingsPage: 默认主题 (mode segmented system/light/dark with
// icons, colorTheme menu, font segmented, language menu), 界面 toggles, and
// the 工具图标 table (empty for the fresh profile → emptyContent copy).
function SourceAppearanceSettingsPage() {
  const [mode, setMode] = useState('system')
  const [font, setFont] = useState('inter')
  const [showConnectionIcons, setShowConnectionIcons] = useState(true)
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)
  const editButton = <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }}>编辑</button>
  return <SettingsPageFrame title="外观">
    <SettingsSection title="默认主题">
      <SettingsCard>
        <SettingsRow label="模式">
          <SettingsSegmentedControl value={mode} onChange={setMode} options={[
            { value: 'system', label: '系统', Icon: Monitor },
            { value: 'light', label: '浅色', Icon: Sun },
            { value: 'dark', label: '深色', Icon: Moon },
          ]} />
        </SettingsRow>
        <SettingsMenuSelectRow label="颜色主题" value="使用默认" />
        <SettingsRow label="字体">
          <SettingsSegmentedControl value={font} onChange={setFont} options={[
            { value: 'inter', label: 'Inter' },
            { value: 'system', label: '系统' },
          ]} />
        </SettingsRow>
        <SettingsMenuSelectRow label="语言" value="简体中文" />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="界面">
      <SettingsCard>
        <SettingsToggle label="连接图标" description="在会话列表和模型选择器中显示提供商图标" checked={showConnectionIcons} onChange={setShowConnectionIcons} />
        <SettingsToggle label="丰富的工具描述" description="为所有工具调用添加操作名称和意图描述。为会话提供更丰富的活动上下文。" checked={richToolDescriptions} onChange={setRichToolDescriptions} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="工具图标" description="聊天活动中 CLI 命令旁显示的图标。存储在 ~/.polo-ai/tool-icons/。" action={editButton}>
      <SettingsCard>
        {/* Info_DataTable empty branch: p-8 centered emptyContent copy. */}
        <div style={{ padding: 30, textAlign: 'center', color: muted }}>
          <p style={{ margin: 0, fontSize: 13.125 }}>未找到工具图标映射</p>
        </div>
      </SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// InputSettingsPage: 输入 toggles (auto-capitalisation on, spell check off)
// + 发送 menu select (Enter default).
function SourceInputSettingsPage() {
  const [autoCapitalisation, setAutoCapitalisation] = useState(true)
  const [spellCheck, setSpellCheck] = useState(false)
  return <SettingsPageFrame title="输入">
    <SettingsSection title="输入" description="控制聊天输入框的文本输入方式。">
      <SettingsCard>
        <SettingsToggle label="自动大写" description="输入消息时自动大写首字母。" checked={autoCapitalisation} onChange={setAutoCapitalisation} />
        <SettingsToggle label="拼写检查" description="输入时为拼写错误的单词添加下划线。" checked={spellCheck} onChange={setSpellCheck} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="发送" description="选择消息发送方式。">
      <SettingsCard>
        <SettingsMenuSelectRow label="发送消息方式" description="发送消息的键盘快捷键" value="Enter" />
      </SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// WorkspaceSettingsPage with the no-workspace guard lifted: the fixture keeps
// the active workspace branch so the page body renders. Rows show the fresh
// IPC defaults (name untitled, icon initial, no working directory, no
// sources, no backups).
function SourceWorkspaceSettingsPage() {
  const outlineSm = { display: 'inline-flex', height: 30, alignItems: 'center', padding: '0 11.25px', border: 0, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 13.125, fontWeight: 400 }
  return <SettingsPageFrame title="Workspace 设置">
    <SettingsSection title="Workspace 信息">
      <SettingsCard>
        <SettingsRow label="名称" description="无标题"><button type="button" style={outlineSm}>编辑</button></SettingsRow>
        <SettingsRow label="图标">
          <div style={{ display: 'flex', width: 22.5, height: 22.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 9999, background: fg5, boxShadow: `0 0 0 1px ${border50}` }}>
            <span style={{ color: muted, fontSize: 11.25, fontWeight: 500 }}>W</span>
          </div>
          <button type="button" style={outlineSm}>更改...</button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="权限">
      <SettingsCard>
        <SettingsMenuSelectRow label="默认模式" description="控制 AI 可执行的操作" value="探索" />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="模式切换" description="选择使用 Shift+Tab 循环切换的模式">
      <SettingsCard>
        <ModeToggle label="探索" description="只读探索。阻止写入，无需确认。" defaultOn />
        <ModeToggle label="编辑前确认" description="编辑前先确认。" defaultOn />
        <ModeToggle label="执行" description="自动执行，无需确认。" defaultOn={false} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="默认数据源" description="新会话自动启用的数据源">
      <p style={{ margin: 0, color: muted, fontSize: 13.125 }}>此 Workspace 未配置数据源。</p>
    </SettingsSection>
    <SettingsSection title="创作者 Skill 备份" description="更新或卸载 Creator Skill 时保留、由用户管理的安全快照。">
      <p style={{ margin: 0, color: muted, fontSize: 13.125 }}>暂无创作者 Skill 备份</p>
    </SettingsSection>
    <SettingsSection title="高级">
      <SettingsCard>
        <SettingsRow label="默认工作目录" description="未设置 (使用会话文件夹)"><button type="button" style={outlineSm}>更改...</button></SettingsRow>
        <SettingsToggle label="本地 MCP 服务器" description="启用 stdio 子进程服务器" checked={false} onChange={() => {}} />
      </SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

function ModeToggle({ label, description, defaultOn }) {
  const [on, setOn] = useState(defaultOn)
  return <SettingsToggle label={label} description={description} checked={on} onChange={setOn} />
}

// PermissionsSettingsPage: 关于权限 (two paragraphs + 了解更多 link), 默认权限
// and Workspace 自定义 both in their empty IPC branches with EditPopover
// "编辑" actions.
function SourcePermissionsSettingsPage() {
  const editButton = <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }}>编辑</button>
  const emptyState = (title, hint) => <div style={{ padding: 30, textAlign: 'center', color: muted }}>
    <p style={{ margin: 0, fontSize: 13.125 }}>{title}</p>
    <p style={{ margin: '3.75px 0 0', color: 'color-mix(in srgb, var(--foreground) 40%, transparent)', fontSize: 12 }}>{hint}</p>
  </div>
  return <SettingsPageFrame title="权限">
    <SettingsSection title="关于权限">
      {/* SettingsCard className="px-4 py-3.5" with text-sm muted leading-relaxed. */}
      <div style={{ padding: '13.125px 15px' }}>
        <div style={{ display: 'grid', gap: 5.625, color: muted, fontSize: 13.125, lineHeight: 1.625 }}>
          <p style={{ margin: 0 }}>权限控制智能体的自主程度。在探索模式下，智能体只能读取和研究——非常适合在提交更改前理解问题。准备好后，切换到执行模式让智能体自主实施方案。</p>
          <p style={{ margin: 0 }}>推荐工作流: 先在探索模式下让智能体调查，审查建议的方案，然后放心执行。</p>
          <p style={{ margin: 0 }}><button type="button" style={{ border: 0, padding: 0, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', textDecoration: 'underline', textUnderlineOffset: 2, fontSize: 13.125, cursor: 'pointer' }}>了解更多</button></p>
        </div>
      </div>
    </SettingsSection>
    <SettingsSection title="默认权限" description="应用级别的探索模式允许模式。不在此列表中的命令将被阻止。" action={editButton}>
      <SettingsCard>{emptyState('未找到默认权限。', '默认权限应位于 ~/.polo-ai/permissions/default.json')}</SettingsCard>
    </SettingsSection>
    <SettingsSection title="Workspace 自定义" description="Workspace 级别的模式，扩展上述应用默认值。" action={editButton}>
      <SettingsCard>{emptyState('未配置自定义权限。', '在 Workspace 中创建 permissions.json 文件以添加自定义规则。')}</SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// LabelsSettingsPage: 关于标签 (three paragraphs + link), 标签层级 and 自动
// 应用规则 empty branches.
function SourceLabelsSettingsPage() {
  const editButton = <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }}>编辑</button>
  const emptyState = (title, hint) => <div style={{ padding: 30, textAlign: 'center', color: muted }}>
    <p style={{ margin: 0, fontSize: 13.125 }}>{title}</p>
    <p style={{ margin: '3.75px 0 0', color: 'color-mix(in srgb, var(--foreground) 40%, transparent)', fontSize: 12 }}>{hint}</p>
  </div>
  return <SettingsPageFrame title="标签">
    <SettingsSection title="关于标签">
      <div style={{ padding: '13.125px 15px' }}>
        <div style={{ display: 'grid', gap: 5.625, color: muted, fontSize: 13.125, lineHeight: 1.625 }}>
          <p style={{ margin: 0 }}>标签帮助你用彩色标记整理会话。按项目、主题或优先级分类对话，方便之后筛选和查找相关会话。</p>
          <p style={{ margin: 0 }}>每个标签可以附带特定类型的值 (文本、数字或日期)。这使标签成为结构化元数据——例如，值为 3 的"优先级"标签，或带有日期的"截止"标签。</p>
          <p style={{ margin: 0 }}>自动应用规则在消息匹配正则表达式模式时自动分配标签。例如，粘贴 Linear issue URL 可以自动用项目名称和 issue ID 标记会话——无需手动标记。</p>
          <p style={{ margin: 0 }}><button type="button" style={{ border: 0, padding: 0, background: 'transparent', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', textDecoration: 'underline', textUnderlineOffset: 2, fontSize: 13.125, cursor: 'pointer' }}>了解更多</button></p>
        </div>
      </div>
    </SettingsSection>
    <SettingsSection title="标签层级" description="此 Workspace 配置的所有标签。标签可嵌套形成分组。" action={editButton}>
      <SettingsCard>{emptyState('未配置标签。', '标签可由智能体创建或通过编辑 Workspace 中的 labels/config.json 创建。')}</SettingsCard>
    </SettingsSection>
    <SettingsSection title="自动应用规则" description="在用户消息中匹配时自动应用标签的正则模式。例如，粘贴 Linear issue URL 即可自动用项目名和 issue ID 标记会话。" action={editButton}>
      <SettingsCard>{emptyState('未配置自动应用规则', '')}</SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// MessagingSettingsPage: one SettingsCard per platform, each a PlatformRow in
// its disconnected branch — 22px brand icon, 13.125px medium label,
// apiType · Not connected (zh defines notConfigured for the platform title
// slot; the disconnected description falls back to the source's English
// 'Not connected' default) and an outline sm Connect button with a Plus icon.
function SourceMessagingSettingsPage() {
  const connectButton = { display: 'inline-flex', height: 26.25, alignItems: 'center', gap: 5.625, padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'transparent', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }
  const platforms = [
    { key: 'telegram', label: 'Telegram', apiType: 'Bot API', icon: telegramIcon },
    { key: 'whatsapp', label: 'WhatsApp', apiType: '非官方 Web API', icon: whatsappIcon },
    { key: 'lark', label: 'Lark / 飞书', apiType: 'Open Platform API', icon: larkIcon },
  ]
  return <SettingsPageFrame title="Messaging" contentGap={22.5}>
    <SettingsSection title="Messaging">
      {platforms.map(platform => <div key={platform.key} style={{ marginBottom: 11.25 }}>
        <SettingsCard>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11.25, padding: '13.125px 15px' }}>
            <img src={platform.icon} alt="" style={{ width: 22, height: 22, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.125, fontWeight: 500 }}>{platform.label}</div>
              <div style={{ marginTop: 1.875, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted, fontSize: 12 }}>{platform.apiType} · Not connected</div>
            </div>
            <button type="button" style={connectButton}><Plus size={13.125} />连接</button>
          </div>
        </SettingsCard>
      </div>)}
    </SettingsSection>
  </SettingsPageFrame>
}

// ServerSettingsPage: 远程访问 toggle + 连接 section. showServerDetails is
// gated on form.enabled || savedForm.enabled; the fixture enables server mode
// so the port/url/token/certificate rows render with their defaults.
function SourceServerSettingsPage() {
  const [enabled, setEnabled] = useState(true)
  const outlineSm = { display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 7.5px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'transparent', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, flexShrink: 0 }
  const iconButton = { display: 'inline-flex', width: 22.5, height: 22.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: 0, borderRadius: 5.625, background: 'transparent', color: muted }
  return <SettingsPageFrame title="服务器" contentGap={18.75}>
    <SettingsSection title="远程访问">
      <SettingsCard>
        <SettingsToggle label="启用服务器模式" description="允许网络上其他设备的连接。" checked={enabled} onChange={setEnabled} />
      </SettingsCard>
    </SettingsSection>
    {enabled && <SettingsSection title="连接">
      <SettingsCard>
        <SettingsInput label="端口" value="9100" onChange={() => {}} />
        <SettingsRow label="URL">
          <code style={{ padding: '1.875px 7.5px', borderRadius: 5.625, background: 'var(--fg-5)', color: muted, fontFamily: 'var(--font-mono)', fontSize: 12 }}>http://localhost:9100</code>
          <button type="button" aria-label="复制 URL" style={iconButton}><Copy size={11.25} /></button>
        </SettingsRow>
        <SettingsRow label="令牌">
          <code style={{ padding: '1.875px 7.5px', borderRadius: 5.625, background: 'var(--fg-5)', color: muted, fontFamily: 'var(--font-mono)', fontSize: 12, maxWidth: 135, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>••••••••••••••••</code>
          <button type="button" aria-label="显示令牌" style={iconButton}><Eye size={11.25} /></button>
          <button type="button" aria-label="复制令牌" style={iconButton}><Copy size={11.25} /></button>
        </SettingsRow>
        <SettingsRow label="证书">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150, color: muted, fontSize: 12 }}>Not configured</span>
          <button type="button" style={outlineSm}>Browse</button>
        </SettingsRow>
        <SettingsRow label="私钥">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150, color: muted, fontSize: 12 }}>Not configured</span>
          <button type="button" style={outlineSm}>Browse</button>
        </SettingsRow>
      </SettingsCard>
      {/* form.enabled && !hasTls warning banner. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7.5, padding: '7.5px 11.25px', borderRadius: 8, background: 'color-mix(in srgb, var(--amber-strong) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--amber-strong) 20%, transparent)', color: 'var(--amber-strong)', fontSize: 12 }}>
        <AlertTriangle size={13.125} style={{ flexShrink: 0, marginTop: 1.875 }} />
        <span>未启用 TLS，连接将不加密。</span>
      </div>
    </SettingsSection>}
  </SettingsPageFrame>
}

// PreferencesPage: 基本信息 (name/timezone), 位置 (city/country), 备注
// (textarea) with the fresh empty form values.
function SourcePreferencesSettingsPage() {
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('')
  const [notes, setNotes] = useState('')
  const editButton = <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'var(--background)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }}>编辑</button>
  return <SettingsPageFrame title="偏好">
    <SettingsSection title="基本信息" description="帮助 Polo AI 为你提供个性化回复。">
      <SettingsCard>
        <SettingsInput label="名称" description="Polo AI 如何称呼你。" value={name} placeholder="你的名字" onChange={setName} />
        <SettingsInput label="时区" description='用于"明天"或"下周"等相对日期。' value={timezone} placeholder="如: Asia/Shanghai" onChange={setTimezone} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="位置" description="启用位置感知回复，如天气、本地时间和区域上下文。">
      <SettingsCard>
        <SettingsInput label="城市" description="用于本地信息和上下文。" value={city} placeholder="如: 上海" onChange={setCity} />
        <SettingsInput label="国家" description="用于区域格式和上下文。" value={country} placeholder="如: 中国" onChange={setCountry} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="备注" description="帮助 Polo AI 了解偏好的自由文本。" action={editButton}>
      <SettingsCard>
        <SettingsTextarea value={notes} placeholder="任何想与 AI 助手分享的额外信息..." rows={5} onChange={setNotes} />
      </SettingsCard>
    </SettingsSection>
  </SettingsPageFrame>
}

// ShortcutsPage: registry-driven sections (actionId → hotkey from
// actions/definitions.ts, Mac symbol join) followed by the component-specific
// sections. Kbd: min-w-[20px] h-5 px-1.5 text-[11px] bg-muted border
// border-border rounded.
function Kbd({ children }) {
  return <kbd style={{ display: 'inline-flex', minWidth: 15, height: 18.75, alignItems: 'center', justifyContent: 'center', padding: '0 5.625px', border: '1px solid var(--border)', borderRadius: 5.625, background: 'var(--fg-5)', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 11.25, fontWeight: 500 }}>{children}</kbd>
}
const shortcutSections = [
  {
    title: '通用',
    rows: [
      ['新建聊天', ['⌘', 'N']],
      ['在面板中新建聊天', ['⌘', 'T']],
      ['设置', ['⌘', ',']],
      ['切换主题', ['⌘', '⇧', 'A']],
      ['搜索', ['⌘', 'F']],
      ['键盘快捷键', ['⌘', '/']],
      ['新建窗口', ['⌘', '⇧', 'N']],
      ['退出', ['⌘', 'Q']],
    ],
  },
  {
    title: '导航',
    rows: [
      ['聚焦侧栏', ['⌘', '1']],
      ['聚焦导航器', ['⌘', '2']],
      ['聚焦聊天', ['⌘', '3']],
      ['聚焦下一区域', ['Tab']],
      ['后退', ['⌘', '[', '←']],
      ['前进', ['⌘', ']', '→']],
      ['聚焦下一面板', ['⌘', '⇧', ']']],
      ['聚焦上一面板', ['⌘', '⇧', '[']],
    ],
  },
  {
    title: '视图',
    rows: [
      ['切换侧栏', ['⌘', 'B']],
      ['切换专注模式', ['⌘', '.']],
    ],
  },
  {
    title: '导航器',
    rows: [
      ['全选', ['⌘', 'A']],
      ['清除选择', ['Esc']],
    ],
  },
  {
    title: '聊天',
    rows: [
      ['停止处理', ['Esc']],
      ['切换权限模式', ['⇧', 'Tab']],
      ['下一个搜索匹配', ['⌘', 'G']],
      ['上一个搜索匹配', ['⌘', '⇧', 'G']],
    ],
  },
  {
    title: '列表导航',
    rows: [
      ['在列表中导航', ['↑', '↓']],
      ['跳到第一项', ['Home']],
      ['跳到最后一项', ['End']],
    ],
  },
  {
    title: '会话列表',
    rows: [
      ['聚焦聊天输入框', ['Enter']],
      ['打开上下文菜单', ['Right-click']],
      ['添加为排除筛选', ['⌥', 'Click']],
    ],
  },
  {
    title: '聊天输入',
    rows: [
      ['发送消息', ['Enter']],
      ['换行', ['⇧', 'Enter']],
      ['关闭对话框 / 取消聚焦', ['Esc']],
    ],
  },
]
function SourceShortcutsPage() {
  return <SettingsPageFrame title="快捷键">
    {shortcutSections.map(section => <SettingsSection key={section.title} title={section.title}>
      <SettingsCard>
        {section.rows.map(([label, keys]) => <SettingsRow key={label} label={label}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3.75 }}>{keys.map(key => <Kbd key={key}>{key}</Kbd>)}</div>
        </SettingsRow>)}
      </SettingsCard>
    </SettingsSection>)}
  </SettingsPageFrame>
}

// AccountSecuritySettingsPage not-logged-in branch: the page body is a single
// muted line (the password form renders only for a logged-in admin).
function SourceAccountSecurityPage() {
  return <SettingsPageFrame title="账号安全">
    <p style={{ margin: 0, color: muted, fontSize: 13.125 }}>请先登录管理员账号，再管理密码。</p>
  </SettingsPageFrame>
}

const subpages = {
  app: SourceAppSettingsPage,
  appearance: SourceAppearanceSettingsPage,
  input: SourceInputSettingsPage,
  workspace: SourceWorkspaceSettingsPage,
  permissions: SourcePermissionsSettingsPage,
  labels: SourceLabelsSettingsPage,
  messaging: SourceMessagingSettingsPage,
  server: SourceServerSettingsPage,
  shortcuts: SourceShortcutsPage,
  preferences: SourcePreferencesSettingsPage,
  'account-security': SourceAccountSecurityPage,
}

// Detail-pane dispatcher: the scene state selects the visible settings page.
export function SourceSettingsDetail({ subpage = 'app' }) {
  const Page = subpages[subpage] ?? SourceAppSettingsPage
  return <Page />
}

// index.css mask-fade-y.
const maskFadeY = 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
