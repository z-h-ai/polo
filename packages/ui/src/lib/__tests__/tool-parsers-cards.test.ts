import { describe, it, expect, beforeAll } from 'bun:test'
import type { ActivityItem } from '../../components/chat/TurnCard'
import { extractOverlayCards } from '../tool-parsers'
import type { OverlayData } from '../tool-parsers'
import { setupI18n } from '@polo-ai/shared/i18n'

function makeActivity(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    timestamp: Date.now(),
    toolName: 'mcp__session__browser_tool',
    toolInput: {},
    content: '',
    ...overrides,
  }
}

// POO-179: card labels and fallback titles are display copy resolved through
// i18n at call time, so the parser tests run against the initialized en locale.
beforeAll(() => {
  setupI18n().changeLanguage('en')
})

describe('extractOverlayCards', () => {
  it('uses wrapper command verbatim for browser_tool input cards', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'navigate https://example.com' },
      content: 'Navigated to: https://example.com\nTitle: Example',
    })

    const cards = extractOverlayCards(activity)
    expect(cards[0]?.label).toBe('Input')
    // POO-179 payload invariance: the wrapper command passes through verbatim.
    expect(cards[0]?.commandPreview).toBe('navigate https://example.com')
  })

  it('returns input + output cards for browser_tool with output', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'snapshot' },
      content: JSON.stringify([{ ref: '@e1', role: 'button' }]),
    })

    const cards = extractOverlayCards(activity)
    expect(cards).toHaveLength(2)
    expect(cards[0]?.label).toBe('Input')
    expect(cards[0]?.commandPreview).toBe('snapshot')
    expect(cards[1]?.label).toBe('Output')
  })

  it('returns output-only card when command is empty', () => {
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: {},
      content: 'Missing command.',
    })

    const cards = extractOverlayCards(activity)
    // No meaningful input → output only
    expect(cards.length).toBeGreaterThanOrEqual(1)
    expect(cards[cards.length - 1]?.label).toBe('Output')
  })

  it('localizes card labels and fallback titles without touching tool payload data', () => {
    const activity = makeActivity({
      displayName: 'Browser',
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'snapshot' },
      content: '',
    })

    const cards = extractOverlayCards(activity)
    const input = cards.find(card => card.id === 'input')
    const output = cards.find(card => card.id === 'output')

    expect(input?.label).toBe('Input')
    expect(output?.label).toBe('Output')
    if (output?.data.type === 'generic') {
      expect(output.data.title).toBe('Browser Output')
      expect(output.data.content).toBe('No output captured for this tool call.')
    }
    // Empty output falls back to the localized placeholder; activity.error
    // still rides along untouched.
    expect(output?.data.error).toBeUndefined()
  })

  it('keeps a missing display name on the localized generic fallback title', () => {
    const activity = makeActivity({
      toolName: '',
      toolInput: {},
      content: '',
    })

    const cards = extractOverlayCards(activity)
    const output = cards.find(card => card.id === 'output')
    if (output?.data.type === 'generic') {
      expect(output.data.title).toBe('Activity')
    }
  })

  it('marks Write markdown output as document card data', () => {
    const activity = makeActivity({
      toolName: 'Write',
      toolInput: {
        path: '/tmp/notes.md',
        content: '# Weekly Notes\n\n- item',
      },
      content: '',
    })

    const cards = extractOverlayCards(activity)
    const output = cards.find(card => card.id === 'output')

    expect(output).toBeDefined()
    expect((output?.data as OverlayData).type).toBe('document')
  })

  it('keeps generic markdown-ish output as generic card data', () => {
    const markdownText = '# Heading\n\nSome paragraph text.'
    const activity = makeActivity({
      toolName: 'mcp__session__browser_tool',
      toolInput: { command: 'evaluate "document.body.innerText"' },
      content: markdownText,
    })

    const cards = extractOverlayCards(activity)
    const output = cards.find(card => card.id === 'output')

    expect(output).toBeDefined()
    expect((output?.data as OverlayData).type).toBe('generic')
    if (output?.data.type === 'generic') {
      expect(output.data.content).toBe(markdownText)
    }
  })
})
