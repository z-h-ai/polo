import { useState } from 'react'
import {
  Building2,
  Keyboard,
  MessageSquare,
  MoreHorizontal,
  Palette,
  ShieldCheck,
  Tag,
  ToggleRight,
  UserCircle,
} from 'lucide-react'

// Settings route translated from SettingsNavigator.tsx + AppSettingsPage.tsx +
// the settings primitives (SettingsSection/SettingsCard/SettingsToggle/
// SettingsRow) and ui/switch.tsx. Root font-size is 15px, so Tailwind rem
// values are written verbatim. Visible items follow getVisibleSettingsItems
// for a fresh profile: no admin login (account-security hidden) and no
// embeddedServer flag (server filtered out of SETTINGS_ITEMS). Copy is
// zh-Hans from zh-Hans.json.
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

// PanelHeader title + SettingsNavigator list. No header actions: the filter
// and add buttons are sessions/resources branches only (AppShell.tsx:2538+).
export function SourceSettingsNavigator({ selectedSubpage = 'app' }) {
  const [selected, setSelected] = useState(selectedSubpage)
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <div className="source-navigator__header"><span className="source-navigator__header-title">设置</span></div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ paddingTop: 7.5 }}>
        {settingsItems.map((item, index) => <SourceSettingsRow key={item.id} item={item} selected={item.id === selected} isFirst={index === 0} onSelect={() => setSelected(item.id)} />)}
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
  const items = children.filter(Boolean)
  return <div style={{ overflow: 'hidden', borderRadius: 11.25, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>
    {items.map((child, index) => <div key={index}>{index > 0 && <div aria-hidden="true" style={{ height: 1, marginLeft: 15, marginRight: 15, background: border50 }} />}{child}</div>)}
  </div>
}

function SettingsSection({ title, children }) {
  // SettingsSection: space-y-3 with a pl-1 header row, h3 text-base
  // font-semibold.
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 11.25 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 15, paddingLeft: 3.75 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35, color: 'var(--foreground)' }}>{title}</h3>
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

function SettingsRow({ label, children }) {
  return <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left', padding: '13.125px 15px' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={labelStyle}>{label}</div>
    </div>
    {children && <div style={{ display: 'flex', alignItems: 'center', gap: 11.25, marginLeft: 15, flexShrink: 0 }}>{children}</div>}
  </div>
}

// AppSettingsPage initial state before IPC resolves: notifications on, keep
// awake off, browser tool on, proxy disabled (no inputs rendered), version
// still loading. Terminal-integration section stays hidden: its IPC gate
// (terminalError !== null || terminalStatus?.supported) is false.
export function SourceAppSettingsPage() {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)
  const [proxyEnabled, setProxyEnabled] = useState(false)
  // Button outline sm: h-8 px-3 text-xs border-foreground/15.
  const outlineSm = { display: 'inline-flex', height: 30, alignItems: 'center', padding: '0 11.25px', border: `1px solid ${fg15}`, borderRadius: 5.625, background: 'transparent', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500 }
  return <div style={{ display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' }}>
    <PageHeader title="应用" />
    <div style={{ flex: 1, minHeight: 0, maskImage: maskFadeY, WebkitMaskImage: maskFadeY, overflowY: 'auto' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26.25px 18.75px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
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
        </div>
      </div>
    </div>
  </div>
}

// index.css mask-fade-y.
const maskFadeY = 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
