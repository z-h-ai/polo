// POO-215 U1/U3 — the distillation checklist card, in isolation: nothing is
// written until the user ticks entries and confirms (Q5 — model suggests,
// user disposes), the checklist follows the POO-210 batch semantics (default
// all-selected, rows lock while submitting, outcomes stay listed), a failed
// row retries alone, and a host without an onConfirm handler renders the
// card inert instead of promising a deposit it cannot make.
import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()

const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react')
const {
  DistillSuggestionCard,
  parseDistillSuggestions,
  isDistillSuggestToolName,
} = await import('../DistillSuggestionCard')

const SUGGESTIONS = [
  { id: 's1', title: '部署 SOP', body: '# 部署 SOP\n\n1. 构建\n2. 发布', suggestedTags: ['tech'] },
  { id: 's2', title: '结论记录', body: '## 结论\n采用 B 计划', suggestedTags: [] },
  { id: 's3', title: '会议要点', body: '- A 提案通过', suggestedTags: ['meeting', 'custom-x'] },
]

function card(onConfirm?: (entries: typeof SUGGESTIONS) => Promise<Array<Record<string, unknown>>>) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(DistillSuggestionCard, { suggestions: SUGGESTIONS, onConfirm }),
  )
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(work: () => void): Promise<void> {
  await act(async () => { work(); await flush() })
}

afterEach(() => {
  cleanup()
  i18n.changeLanguage('en')
})

describe('DistillSuggestionCard (POO-215 U1/U3)', () => {
  it('defaults to all-selected and submits exactly the checked entries', async () => {
    const submitted: Array<string[]> = []
    render(card(async (entries) => {
      submitted.push(entries.map(e => e.id))
      return entries.map(e => ({ id: e.id, status: 'success' }))
    }))
    expect((screen.getByTestId('pc-distill-selection-count')).textContent).toBe('3 entries selected')
    const checkboxes = ['s1', 's2', 's3'].map(id => screen.getByTestId(`pc-distill-entry-check-${id}`) as HTMLInputElement)
    expect(checkboxes.every(box => box.checked)).toBe(true)

    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-entry-check-s2')))
    expect((screen.getByTestId('pc-distill-selection-count')).textContent).toBe('2 entries selected')

    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-confirm')))
    await act(async () => { await flush() })
    expect(submitted).toEqual([['s1', 's3']])
    // Settled rows stay listed with their outcome; the summary counts them.
    expect(screen.getByTestId('pc-distill-entry-s1').getAttribute('data-status')).toBe('success')
    expect(screen.getByTestId('pc-distill-entry-s3').getAttribute('data-status')).toBe('success')
    expect((screen.getByTestId('pc-distill-selection-count')).textContent).toBe('2 entries distilled')
    // Successful rows are locked — a settled deposit is never re-sent.
    expect((screen.getByTestId('pc-distill-entry-check-s1') as HTMLInputElement).disabled).toBe(true)
  })

  it('keeps a failed row listed with its mapped copy and retries ONLY the failures', async () => {
    const submitted: Array<string[]> = []
    let secondRoundSucceeds = false
    render(card(async (entries) => {
      submitted.push(entries.map(e => e.id))
      return entries.map(e => (e.id === 's2' && !secondRoundSucceeds)
        ? { id: e.id, status: 'failed', errorKey: 'projectContext.errors.uploadFailed' }
        : { id: e.id, status: 'success' })
    }))
    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-confirm')))
    await act(async () => { await flush() })
    expect(submitted).toEqual([['s1', 's2', 's3']])
    expect(screen.getByTestId('pc-distill-entry-s2').getAttribute('data-status')).toBe('failed')
    expect(screen.getByTestId('pc-distill-entry-error-s2').textContent).toBe('The upload failed. Please try again.')
    expect(screen.getByTestId('pc-distill-selection-count').textContent).toBe('2 entries distilled')

    // The retry re-runs the failed row alone and it settles as distilled.
    await settle(() => { secondRoundSucceeds = true })
    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-retry')))
    await act(async () => { await flush() })
    expect(submitted).toEqual([['s1', 's2', 's3'], ['s2']])
    expect(screen.getByTestId('pc-distill-entry-s2').getAttribute('data-status')).toBe('success')
    expect(screen.queryByTestId('pc-distill-retry')).toBeNull()
  })

  it('expands the per-entry body preview and hides everything on dismiss', async () => {
    render(card())
    expect(screen.queryByText('# 部署 SOP')).toBeNull()
    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-entry-toggle-s1')))
    const preview = screen.getByTestId('pc-distill-entry-s1').querySelector('pre')
    expect(preview?.textContent).toContain('1. 构建')
    expect(preview?.textContent).toContain('2. 发布')

    await settle(() => fireEvent.click(screen.getByTestId('pc-distill-dismiss')))
    expect(screen.queryByTestId('pc-distill-card')).toBeNull()
  })

  it('renders inert without an onConfirm handler — no deposit is promised', () => {
    render(card())
    expect(screen.getByTestId('pc-distill-card')).toBeTruthy()
    expect(screen.queryByTestId('pc-distill-confirm')).toBeNull()
    // The rows are listed (the model's work is still visible) but checkable
    // rows keep their default selection and nothing can submit.
    expect(screen.getByTestId('pc-distill-entry-s1')).toBeTruthy()
  })
})

describe('parseDistillSuggestions + tool-name predicate', () => {
  const envelope = JSON.stringify({
    marker: 'PC_DISTILL_SUGGESTIONS_V1',
    accepted: 2,
    message: '已向用户展示 2 条沉淀建议',
    suggestions: SUGGESTIONS.slice(0, 2),
  })

  it('parses the marker-tagged envelope into card data', () => {
    expect(parseDistillSuggestions(envelope)).toEqual(SUGGESTIONS.slice(0, 2))
  })

  it('rejects anything that is not the envelope instead of rendering a broken card', () => {
    expect(parseDistillSuggestions(undefined)).toBeNull()
    expect(parseDistillSuggestions('')).toBeNull()
    expect(parseDistillSuggestions('plain model prose')).toBeNull()
    expect(parseDistillSuggestions('{"marker":"OTHER_V1","suggestions":[]}')).toBeNull()
    expect(parseDistillSuggestions('{"marker":"PC_DISTILL_SUGGESTIONS_V1","suggestions":"no"}')).toBeNull()
    expect(parseDistillSuggestions('{"marker":"PC_DISTILL_SUGGESTIONS_V1","suggestions":[{"id":"","title":"x","body":"y"}]}')).toBeNull()
    expect(parseDistillSuggestions('{"marker":"PC_DISTILL_SUGGESTIONS_V1","suggestions":[]}')).toBeNull()
    expect(parseDistillSuggestions('{oops')).toBeNull()
  })

  it('matches the bare name and the session MCP prefix, nothing else', () => {
    expect(isDistillSuggestToolName('project_context_suggest')).toBe(true)
    expect(isDistillSuggestToolName('mcp__session__project_context_suggest')).toBe(true)
    expect(isDistillSuggestToolName('project_context_search')).toBe(false)
    expect(isDistillSuggestToolName(undefined)).toBe(false)
  })
})
