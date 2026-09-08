import { DatabaseZap, Webhook, Zap } from 'lucide-react'

// EntityListEmptyScreen.tsx (empty.tsx primitives) as instantiated by
// SourcesListPanel.tsx, SkillsListPanel.tsx and AutomationsListPanel.tsx with
// a real empty dataset. Copy is zh-Hans from zh-Hans.json. The second action
// (添加数据源/添加技能/添加自动化) is the EditPopover trigger child that only
// renders when workspaceRootPath exists — the fixture keeps a workspace root,
// so it renders.
const copy = {
  sources: { Icon: DatabaseZap, title: '未配置数据源。', description: '数据源将智能体连接到外部数据——MCP 服务器、REST API 和本地文件夹。', action: '添加数据源' },
  skills: { Icon: Zap, title: '未配置技能', description: '技能是可复用的说明，教智能体学习专门的行为。', action: '添加技能' },
  automations: { Icon: Webhook, title: '未配置自动化', description: '自动化在事件发生时执行操作——按计划运行命令、响应标签变更或自动触发提示。', action: '添加自动化' },
}
export function SourceResourceEmptyPanel({ kind }) {
  const { Icon, title, description, action } = copy[kind]
  return <div data-route={'resources/' + kind + '/empty'} style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 11.25, boxSizing: 'border-box', padding: '22.5px 22.5px 20%', borderRadius: 7.5, textAlign: 'center' }}>
    <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'center', marginBottom: 7.5, color: 'var(--fg-50)' }}><Icon size={40} strokeWidth={1.5}/></div>
    <div style={{ display: 'flex', maxWidth: 360, flexDirection: 'column', alignItems: 'center', gap: 7.5, textAlign: 'center' }}>
      <div style={{ fontSize: 13.125, fontWeight: 500, letterSpacing: '-.025em' }}>{title}</div>
      <div style={{ color: 'var(--fg-50)', fontSize: 11.25, lineHeight: 1.375 }}>{description}</div>
    </div>
    <div style={{ display: 'flex', width: '100%', maxWidth: 360, minWidth: 0, alignItems: 'center', justifyContent: 'center', gap: 11.25, marginTop: 11.25, fontSize: 13.125 }}>
      <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: 0, borderRadius: 8, background: 'color-mix(in srgb, var(--foreground) 2%, transparent)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, transition: 'background-color 150ms' }}>了解更多</button>
      <button type="button" style={{ display: 'inline-flex', height: 26.25, alignItems: 'center', padding: '0 11.25px', border: 0, borderRadius: 8, background: 'var(--background)', boxShadow: 'var(--shadow-minimal)', color: 'var(--foreground)', fontSize: 11.25, fontWeight: 500, transition: 'background-color 150ms' }}>{action}</button>
    </div>
  </div>
}
// Detail panel placeholder: PanelSlot renders an unselected detail surface with
// a centered muted message when no entity is selected.
export function SourceUnselectedResourceDetail({ kind }) {
  const label = { sources: '未配置数据源。', skills: '未配置技能', automations: '未配置自动化' }[kind] ?? '未配置数据源。'
  return <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: 'var(--background)', borderRadius: '10px 14px 14px 10px' }}>
    <span style={{ color: 'var(--fg-50)', fontSize: 13.125 }}>{label}</span>
  </div>
}
