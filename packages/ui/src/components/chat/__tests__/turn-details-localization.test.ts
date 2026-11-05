import { describe, it, expect, beforeAll } from 'bun:test'
import { formatTurnAsMarkdown, getActivitySummary } from '../turn-utils'
import type { AssistantTurn } from '../turn-utils'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'
import type { ActivityItem } from '../TurnCard'

function makeActivity(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'act-1',
    type: 'tool',
    status: 'completed',
    timestamp: Date.now(),
    toolName: 'Bash',
    toolInput: { command: 'ls -la /tmp/λ-dir' },
    content: 'total 0',
    ...overrides,
  }
}

function makeTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    isComplete: true,
    activities: [
      makeActivity({}),
      makeActivity({ id: 'act-2', type: 'intermediate', status: 'completed', toolName: undefined, content: 'Looking at the directory' }),
    ],
    response: { messageId: 'm-1', text: 'Here is the listing.' },
    ...overrides,
  } as AssistantTurn
}

// The turn-details markdown is a temporary display copy resolved at call
// time, so the formatter is asserted against two live locales.
beforeAll(() => {
  setupI18n().changeLanguage('en')
})

describe('formatTurnAsMarkdown', () => {
  it('uses localized chrome labels in English and keeps tool payload bytes verbatim', () => {
    const turn = makeTurn()
    const md = formatTurnAsMarkdown(turn)

    expect(md).toContain('# Turn Details')
    expect(md).toContain('**Status:** Complete · 2 completed')
    expect(md).toContain('## Activities')
    expect(md).toContain('### 💭 Commentary')
    expect(md).toContain('**Input:**')
    expect(md).toContain('**Result:**')
    expect(md).toContain('## Response')

    // Payload invariance: tool names, raw inputs and results stay untouched.
    expect(md).toContain('### ✅ Bash')
    expect(md).toContain('ls -la /tmp/λ-dir')
    expect(md).toContain('total 0')
    expect(md).toContain('Here is the listing.')
    expect(md).toContain('Looking at the directory')
  })

  it('keeps a turn intent as the verbatim heading even in another locale', () => {
    const turn = makeTurn({ intent: 'Inspect temp directory' } as Partial<AssistantTurn>)
    i18n.changeLanguage('zh-Hans')
    const md = formatTurnAsMarkdown(turn)
    expect(md).toContain('# Inspect temp directory')
    expect(md).toContain('## 活动列表')
    expect(md).toContain('**状态：**已完成')
    // tool payload stays byte-identical
    expect(md).toContain('ls -la /tmp/λ-dir')
    i18n.changeLanguage('en')
  })

  it('localizes the in-progress status and per-status counts', () => {
    const turn = makeTurn({
      isComplete: false,
      activities: [
        makeActivity({ id: 'a1', status: 'running' }),
        makeActivity({ id: 'a2', status: 'completed' }),
        makeActivity({ id: 'a3', status: 'error', content: '', error: 'boom' }),
      ],
    } as Partial<AssistantTurn>)
    const md = formatTurnAsMarkdown(turn)
    expect(md).toContain('**Status:** In Progress · 1 running, 1 completed, 1 failed')
    expect(md).toContain('**Error:**')
    expect(md).toContain('boom')
  })

  it('re-resolves the fallback heading after a language switch without remounting anything', () => {
    const turn = makeTurn()
    i18n.changeLanguage('en')
    expect(formatTurnAsMarkdown(turn)).toContain('# Turn Details')
    i18n.changeLanguage('zh-Hans')
    expect(formatTurnAsMarkdown(turn)).toContain('# 轮次详情')
    i18n.changeLanguage('en')
  })
})

describe('getActivitySummary', () => {
  it('joins localized counts and falls back to the localized empty label', () => {
    const turn = makeTurn()
    expect(getActivitySummary(turn)).toBe('2 completed')

    const empty = makeTurn({ activities: [] } as Partial<AssistantTurn>)
    expect(getActivitySummary(empty)).toBe('No activities')
  })

  it('updates counts copy on language switch while numbers stay raw', () => {
    const turn = makeTurn()
    i18n.changeLanguage('zh-Hans')
    expect(getActivitySummary(turn)).toBe('2 个已完成')
    i18n.changeLanguage('en')
  })
})
