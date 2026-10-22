import { useState } from 'react'
import { MoreHorizontal, Play, Tag, Webhook } from 'lucide-react'

// Automations scene populated with a named deterministic dataset (list +
// detail). Structure per AutomationsListPanel.tsx / entity-row.tsx and
// AutomationInfoPage.tsx / Info_Page + Info_Section + Info_Table. Event
// badges follow EVENT_DISPLAY_NAMES and MicroBadge styling; permission
// levels follow PERMISSION_DISPLAY_NAMES. Automation titles/taglines/prompts
// are fixture content — the real values come from IPC and cannot be derived
// from static source. Root font-size 15px.
const automations = [
  { id: 'weekly-report', title: '周报整理', tagline: '每周五汇总本周会话与提交', event: 'Scheduled', eventKind: 'scheduled', permission: 'Explore', status: 'active', prompt: '汇总本周会话记录与 polaris 仓库提交，生成周报草稿。', schedule: { timing: '每周五 18:00', repeats: '每周', next: '周五 18:00', timezone: 'Asia/Shanghai' } },
  { id: 'label-triage', title: '标签分诊', tagline: '粘贴 Linear 链接时自动打标', event: 'Label Added', eventKind: 'label', permission: 'Ask', status: 'active', prompt: '检测消息中的 Linear issue URL，按项目名与 issue ID 打标。', schedule: null },
  { id: 'nightly-backup', title: '夜间备份', tagline: '每晚导出会话归档', event: 'Scheduled', eventKind: 'scheduled', permission: 'Explore', status: 'disabled', prompt: '导出全部会话归档到本地备份目录。', schedule: { timing: '每天 02:00', repeats: '每天', next: '明天 02:00', timezone: 'Asia/Shanghai' } },
]

const detail = automations[0]

export function SourceAutomationsList() {
  const [selectedId, setSelectedId] = useState(detail.id)
  return <div data-route="resources/automations/list" style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', boxSizing: 'border-box', padding: 7.5, borderRadius: 7.5 }}>
    {automations.map(item => <EntityRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />)}
  </div>
}

// entity-row.tsx EntityRow: entity-row-btn flex w-full items-start gap-2 pl-2
// pr-4 py-3 text-left text-sm rounded-[8px], selected bg-foreground/3 else
// hover:bg-foreground/2. Title row keeps an invisible icon spacer so the
// badges column lines up; trailing lastExecutedAt is text-[11px]
// text-foreground/40.
function EntityRow({ item, selected, onSelect }) {
  const [hovered, setHovered] = useState(false)
  const background = selected ? 'color-mix(in srgb, var(--foreground) 3%, transparent)' : hovered ? 'color-mix(in srgb, var(--foreground) 2%, transparent)' : 'transparent'
  return <button type="button" onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ display: 'flex', width: '100%', alignItems: 'flex-start', gap: 7.5, paddingLeft: 7.5, paddingRight: 15, paddingTop: 11.25, paddingBottom: 11.25, border: 0, borderRadius: 8, background, color: item.status === 'disabled' ? 'color-mix(in srgb, var(--foreground) 50%, transparent)' : 'var(--foreground)', cursor: 'pointer', textAlign: 'left', transition: 'background-color 75ms' }}>
    <span style={{ display: 'inline-flex', width: 11.25, height: 11.25, flexShrink: 0, marginTop: 2.5 }} aria-hidden="true" />
    <span style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', gap: 2.5 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, fontSize: 13.125 }}>{item.title}</span>
      <span style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', color: 'color-mix(in srgb, var(--foreground) 55%, transparent)', fontSize: 12, lineHeight: 1.35, marginTop: -3.75 }}>{item.tagline}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 3.75, width: '100%', minWidth: 0, color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', fontSize: 12 }}>
        <MicroBadge kind={item.eventKind}>{item.event}</MicroBadge>
        <MicroBadge kind="prompt">{item.permission}</MicroBadge>
        <span style={{ flex: 1 }} />
        <span style={{ color: 'color-mix(in srgb, var(--foreground) 40%, transparent)', fontSize: 11 }}>上次: 周四 18:00</span>
      </span>
    </span>
  </button>
}

// MicroBadge: px-1.5 py-0.5 text-[10px] font-medium rounded; colors per
// AutomationsListPanel badge mapping (event bg-foreground/8 60%, prompt
// accent/10 accent, webhook orange-family).
function MicroBadge({ kind, children }) {
  const styles = {
    scheduled: { background: 'color-mix(in srgb, var(--foreground) 8%, transparent)', color: 'color-mix(in srgb, var(--foreground) 60%, transparent)' },
    label: { background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' },
    webhook: { background: 'color-mix(in srgb, #f97316 10%, transparent)', color: '#f97316' },
    prompt: { background: 'color-mix(in srgb, var(--foreground) 8%, transparent)', color: 'color-mix(in srgb, var(--foreground) 60%, transparent)' },
  }[kind]
  return <span style={{ flexShrink: 0, padding: '1.875px 5.625px', borderRadius: 4, fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap', ...styles }}>{children}</span>
}

// AutomationInfoPage: Info_Page.Header (title + AutomationMenu trigger) then
// Info_Page.Content — Hero (32px rounded-[4px] ring avatar, 16px semibold
// title, 14px/60% tagline), the paused Info_Alert (disabled fixture only),
// and 当/如果/则/设置 Info_Sections.
export function SourceAutomationDetail() {
  const item = detail
  return <div data-route="resources/automations/detail" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, flexDirection: 'column', background: 'var(--background)', color: 'var(--foreground)' }}>
    <div className="source-navigator__header" style={{ zIndex: 50 }}>
      <span className="source-navigator__header-title">{item.title}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 3.75 }}>
        <button type="button" className="source-navigator__header-button" aria-label="测试运行"><Play size={15} /></button>
        <button type="button" className="source-navigator__header-button" aria-label="更多选项"><MoreHorizontal size={15} /></button>
      </span>
    </div>
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitMaskImage: maskFadeY, maskImage: maskFadeY }}>
      <div style={{ maxWidth: 630, margin: '0 auto', boxSizing: 'border-box', padding: '22.5px 18.75px 37.5px', display: 'flex', flexDirection: 'column', gap: 22.5 }}>
        <Hero item={item} />
        <InfoSection title="当" description="触发此自动化的条件"><InfoTable rows={[['事件', item.event]]} /></InfoSection>
        <InfoSection title="如果" description="操作运行前必须通过的条件">
          <InfoCard><p style={{ margin: 0, padding: '11.25px 15px', fontSize: 13.125, lineHeight: 1.4286, color: 'color-mix(in srgb, var(--foreground) 65%, transparent)' }}>{item.prompt}</p></InfoCard>
        </InfoSection>
        <InfoSection title="则">
          <InfoCard><p style={{ margin: 0, padding: '11.25px 15px', fontSize: 13.125, lineHeight: 1.4286, color: 'var(--foreground)' }}>{item.prompt}</p></InfoCard>
        </InfoSection>
        {item.schedule && <InfoSection title="设置">
          <InfoTable rows={[
            ['时间', item.schedule.timing],
            ['重复', item.schedule.repeats],
            ['计划表达式', '0 18 * * 5'],
            ['下次运行', item.schedule.next],
            ['时区', item.schedule.timezone],
            ['访问级别', item.permission],
            ['状态', item.status === 'active' ? '活跃' : '已停用'],
          ]} />
        </InfoSection>}
      </div>
    </div>
  </div>
}

// Info_Page Hero: avatar h-[32px] w-[32px] rounded-[4px] ring-1 ring-border/30
// with a 16px glyph; title 16px semibold; tagline 14px at 60%.
function Hero({ item }) {
  const Icon = item.eventKind === 'label' ? Tag : Webhook
  return <div style={{ display: 'flex', alignItems: 'center', gap: 11.25 }}>
    <span style={{ display: 'flex', width: 32, height: 32, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 4, background: 'var(--fg-5)', color: 'color-mix(in srgb, var(--foreground) 70%, transparent)', boxShadow: `0 0 0 1px color-mix(in srgb, var(--border) 30%, transparent)` }}><Icon size={16} strokeWidth={1.5} /></span>
    <div style={{ minWidth: 0 }}>
      <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.35 }}>{item.title}</h1>
      <p style={{ margin: 0, color: 'color-mix(in srgb, var(--foreground) 60%, transparent)', fontSize: 14, lineHeight: 1.35 }}>{item.tagline}</p>
    </div>
  </div>
}

// Info_Section: space-y-3 pt-2; header row pl-1 justify-between with h3
// text-base font-semibold + text-sm muted description; card bg-background
// shadow-minimal rounded-[8px] overflow-hidden.
function InfoSection({ title, description, children }) {
  return <section style={{ display: 'flex', flexDirection: 'column', gap: 11.25, paddingTop: 7.5 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 15, paddingLeft: 3.75 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{title}</h3>
      {description && <span style={{ color: 'var(--fg-50)', fontSize: 13.125 }}>{description}</span>}
    </div>
    {children}
  </section>
}

function InfoCard({ children }) {
  return <div style={{ overflow: 'hidden', borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)' }}>{children}</div>
}

// Info_Table: py-2 wrapper, dl divide-y divide-border/30; row flex py-2.5
// px-4 text-sm, dt 120px text-muted-foreground.
function InfoTable({ rows }) {
  return <InfoCard>
    <div style={{ paddingTop: 7.5, paddingBottom: 7.5 }}>
      <dl style={{ margin: 0 }}>
        {rows.map(([label, value]) => <div key={label} style={{ display: 'flex', alignItems: 'baseline', padding: '9.375px 15px', fontSize: 13.125, borderTop: '1px solid color-mix(in srgb, var(--border) 30%, transparent)' }}>
          <dt style={{ width: 90, flexShrink: 0, color: 'var(--fg-50)' }}>{label}</dt>
          <dd style={{ margin: 0, minWidth: 0, color: 'var(--foreground)' }}>{value}</dd>
        </div>)}
      </dl>
    </div>
  </InfoCard>
}

const maskFadeY = 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
