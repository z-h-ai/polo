import '@/playground/mock-utils'
import { installBaselineApiFixtures } from '../../source-baseline/entries/fixtures'
import { MOCK_SOURCES, MOCK_LLM_CONNECTIONS, MOCK_SESSION_STATUSES } from '@/playground/demos/mobile-webui/mock-mobile-data'
import type { Session } from '@polo-ai/shared/protocol'
import type { Message } from '@polo-ai/core/types'

export { MOCK_LLM_CONNECTIONS, MOCK_SESSION_STATUSES }
export const workspace = { id: 'playground-workspace', name: 'Polo 工作区', slug: 'playground', rootPath: '/mock/polo-sidebar', createdAt: 1793188800000 }
const now = 1793188800000
const names = ['季度经营分析与汇报', '整理本周客户会议纪要', '梳理下月内容选题', '检查销售数据异常', '准备客户沟通提纲', '制作产品演示材料', '团队知识库整理', '跟进项目交付清单']
const sections = ['收入与增长', '客户结构', '销售转化', '交付效率', '成本变化', '主要风险', '下季度重点', '行动与负责人', '汇报提纲']
export const messages: Message[] = [
  { id: 'm1', role: 'user', content: '请帮我分析这季度的经营情况，并整理一份可以在例会上汇报的提纲。', timestamp: now - 600000 },
  ...sections.map((section, index): Message => ({
    id: `a${index}`, role: 'assistant', turnId: `turn${index}`, timestamp: now - 500000 + index * 10000,
    content: `## ${index + 1}. ${section}\n\n${[
      '本季度整体收入保持增长，老客户的持续合作为业务提供了稳定基础。建议按客户类型和产品线拆开观察，以便区分短期波动与长期变化。',
      '重点关注高价值客户的复购情况，同时保留对新客户需求的持续记录。汇报时用事实说明进展，再写需要团队共同解决的问题。',
      '下一步把分析转成可执行的任务：明确负责人、完成时间和复查方式。保持当前阅读位置，先看清本节信息，再继续往下阅读。',
    ].join('\n\n')}`,
  })),
]
export const sessions: Session[] = names.map((name, index) => ({
  id: `read-${index + 1}`, name, workspaceId: workspace.id, workspaceName: workspace.name,
  createdAt: now - index * 3600000, lastMessageAt: now - index * 3600000, isProcessing: false,
  sessionStatus: index === 0 ? 'in-progress' : index === 1 ? 'needs-review' : index === 3 ? 'done' : 'todo',
  isFlagged: index === 0, hasUnread: index === 2, messages: index === 0 ? messages : [],
  permissionMode: 'ask', workingDirectory: '/mock/polo-sidebar', model: 'fixture-model',
  messageCount: index === 0 ? messages.length : 0, labels: [],
}))

// These APIs only provide isolated presentation data. No real account or service.
const api = window.electronAPI as unknown as Record<string, unknown>
installBaselineApiFixtures(api)
const sources = MOCK_SOURCES.map(source => ({ ...source, workspaceId: workspace.id, config: { ...source.config, icon: undefined } }))
Object.assign(api, {
  getSources: async () => sources, getSkills: async () => [], getSessions: async () => sessions,
  getSession: async (id: string) => sessions.find(session => session.id === id),
  // The production contract returns a whole Session, not a Message array.
  getSessionMessages: async (id: string) => sessions.find(session => session.id === id) ?? null,
  getWorkspaceSettings: async () => ({ permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'], localMcpEnabled: true }),
  listStatuses: async () => [
    { id: 'todo', label: '待办', color: 'foreground/50', icon: 'circle', category: 'open', isDefault: true, isFixed: true, order: 0 },
    { id: 'in-progress', label: '进行中', color: 'info', icon: 'circle-dashed', category: 'open', order: 1 },
    { id: 'needs-review', label: '待审查', color: 'warning', icon: 'eye', category: 'open', order: 2 },
    { id: 'done', label: '已完成', color: 'success', icon: 'check', category: 'closed', order: 3 },
  ],
  listLabels: async () => [], listViews: async () => [], getAutomations: async () => null, getAutomationLastExecuted: async () => ({}),
  getUnreadSummary: async () => ({ totalUnreadCount: 1, hasUnreadByWorkspace: { 'playground-workspace': true }, workspaces: [], sessions: [] }),
  getPreferences: async () => ({}), readPreferences: async () => ({ content: '{}' }), getWorkspaceRootPath: async () => workspace.rootPath,
  getSessionPath: async (id: string) => `/mock/polo-sidebar/sessions/${id}`,
  getPendingQuestions: async () => [], getPendingQuestion: async () => null,
  getDraftAttachments: async () => [], getSessionFiles: async () => [], getWindowFocusState: async () => true,
  getLlmConnections: async () => MOCK_LLM_CONNECTIONS, getWindowState: async () => ({ isMaximized: false, isFullScreen: false }),
  getUserTheme: async () => null, getBrowserToolEnabled: async () => true,
  getCreatorSkillSafetyVersions: async () => [], getCreatorSkillSafetyState: async () => null,
  getColorTheme: async () => null, getWorkspaceColorTheme: async () => null,
  circleReturn: { getPending: async () => ({ status: 'none' }), ack: async () => ({ success: true }), cancel: async () => ({ success: true }) },
  isDebugMode: async () => false,
})
const noSubscription = () => () => {}
Object.defineProperty(window, 'electronAPI', { configurable: true, value: new Proxy(api, {
  get(target, key) {
    if (key in target) return target[key as keyof typeof target]
    if (typeof key !== 'string') return undefined
    if (key.startsWith('on')) return noSubscription
    if (key.startsWith('get') || key.startsWith('list')) return async () => []
    if (key === 'sessionCommand') return async () => ({ success: true })
    return async () => undefined
  },
}) })
