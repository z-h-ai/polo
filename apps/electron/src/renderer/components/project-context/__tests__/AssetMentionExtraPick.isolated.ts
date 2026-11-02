import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import * as React from 'react'
import type { MentionInputElement, MentionItem } from '@/components/ui/mention-menu'
import type { AssetMentionHit, AssetMentionExtraSection, UseAssetMentionResult } from '../AssetMentionPopover'
import type { PcSearchResponse } from '@polo-ai/shared/protocol'

/**
 * POO-196 review R-1 regression: the unified `@` popover's extra skill/source
 * rows are picked while the ASSET trigger owns the caret, so the generic
 * mention hook never saw those keystrokes and its committed trigger snapshot
 * was stale — the old select path returned an empty value that wiped the whole
 * composer. The pick must insert the mention into the LIVE text instead, over
 * both the pointer and the keyboard (Enter) path.
 */

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { createElement, useCallback, useMemo, useRef } = React
// mention-menu's avatar/dropdown imports chain into Vite-only asset URLs —
// stub them the same way the composer input tests do (see ChatInputZone.*.isolated).
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, { get: () => () => {} }))
const { AssetMentionPopover, useAssetMention } = await import('../AssetMentionPopover')
const { useInlineMention } = await import('@/components/ui/mention-menu')

interface HarnessHandles {
  state: UseAssetMentionResult | null
}

/** Minimal LoadedSkill / LoadedSource stand-ins: only what the sections read. */
function fakeSkill(slug: string, name: string) {
  return { slug, source: 'global', metadata: { name, description: `${name} description` } }
}
function fakeSource(slug: string, name: string) {
  return { config: { slug, name, tagline: `${name} tagline` } }
}

function Harness(props: {
  search: (q: string) => Promise<PcSearchResponse>
  onPick: (hit: AssetMentionHit) => void
  skills: ReturnType<typeof fakeSkill>[]
  sources: ReturnType<typeof fakeSource>[]
  applied: Array<{ value: string; cursor: number }>
  handles: HarnessHandles
}) {
  const inputRef = useRef<MentionInputElement | null>(null)
  const [applied, setApplied] = React.useState({ value: '', cursor: 0 })

  // Same contract as the composer: both hooks track every change, but the
  // generic hook is fed ONLY while the asset trigger is NOT active (that is
  // exactly the condition that made its snapshot stale).
  const inlineMention = useInlineMention({
    inputRef,
    skills: props.skills as never,
    sources: props.sources as never,
    onSelect: useCallback(() => {}, []),
    workspaceId: 'ws',
  })
  const applyValue = useCallback((value: string, cursor: number) => {
    props.applied.push({ value, cursor })
    setApplied({ value, cursor })
    // Mirror the composer: the element's value/caret move with the applied text.
    if (inputRef.current) {
      inputRef.current.value = value
      inputRef.current.selectionStart = cursor
    }
  }, [props.applied])

  // Same wiring as FreeFormInput's assetMentionExtraSections: the generic
  // hook's skill/source sections ride the asset popover, and the pick closes
  // the popover before handing the row to the select holder (built before the
  // select handler exists, hence the ref-holder indirection).
  const closeRef = useRef<() => void>(() => {})
  const selectAtRef = useRef<(item: MentionItem) => void>(() => {})
  const extraSections = useMemo<AssetMentionExtraSection[]>(() => {
    const byType = new Map<string, MentionItem[]>()
    for (const section of inlineMention.sections) {
      for (const item of section.items) {
        if (item.type !== 'skill' && item.type !== 'source') continue
        const bucket = byType.get(item.type)
        if (bucket) bucket.push(item)
        else byType.set(item.type, [item])
      }
    }
    return (['skill', 'source'] as const)
      .filter((type) => (byType.get(type)?.length ?? 0) > 0)
      .map((type) => ({
        id: type === 'skill' ? 'skills' : 'sources',
        label: type === 'skill' ? 'Skills' : 'Sources',
        items: (byType.get(type) ?? []).map((item) => ({
          id: `${type}:${item.id}`,
          label: item.label,
          description: item.description ?? null,
          pick: () => {
            closeRef.current()
            selectAtRef.current(item)
          },
        })),
      }))
  }, [inlineMention.sections])

  const state = useAssetMention({
    enabled: true,
    inputRef,
    search: props.search,
    onPick: props.onPick,
    applyInputValue: applyValue,
    extraSections,
  })
  closeRef.current = state.close

  // The fixed composer path: read the LIVE element value/caret at pick time
  // and hand them to inlineMention.handleSelectAt.
  selectAtRef.current = (item: MentionItem) => {
    const element = inputRef.current
    const liveValue = element?.value ?? ''
    const liveCursor = element ? element.selectionStart : liveValue.length
    const inserted = inlineMention.handleSelectAt(liveValue, liveCursor, item)
    applyValue(inserted.value, inserted.cursorPosition)
  }

  props.handles.state = state
  return createElement(
    'div',
    null,
    createElement('textarea', {
      'data-testid': 'feed',
      value: applied.value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const el = event.currentTarget
        // happy-dom types selectionStart as nullable; adapt to the hook's
        // MentionInputElement contract (caret rect stays on the fallback path).
        inputRef.current = {
          getBoundingClientRect: () => el.getBoundingClientRect(),
          getCaretRect: () => null,
          value: el.value,
          selectionStart: el.selectionStart ?? el.value.length,
        }
        const assetActive = state.handleInputChanged(el.value, el.selectionStart ?? el.value.length)
        if (!assetActive) inlineMention.handleInputChange(el.value, el.selectionStart ?? el.value.length)
      },
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'key-enter',
      onClick: () => state.handleKeyDown({ key: 'Enter' }),
    }),
    createElement('input', {
      'data-testid': 'applied-value',
      readOnly: true,
      value: applied.value,
    }),
    createElement(AssetMentionPopover, {
      state,
      onChoose: props.onPick,
      onChooseExtra: (item) => item.pick(),
    }),
  )
}

const SKILLS = [fakeSkill('reviewer', 'Reviewer'), fakeSkill('architect', 'Architect')]
const SOURCES = [fakeSource('ga', 'Google Analytics')]

beforeEach(async () => {
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

function mountHarness() {
  const applied: Array<{ value: string; cursor: number }> = []
  const picks: AssetMentionHit[] = []
  const handles: HarnessHandles = { state: null }
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(Harness, {
      search: async () => ({ degraded: false, hits: [] }) as PcSearchResponse,
      onPick: (hit: AssetMentionHit) => picks.push(hit),
      skills: SKILLS,
      sources: SOURCES,
      applied,
      handles,
    }),
  ))
  return { applied, picks }
}

function type(text: string) {
  const feed = screen.getByTestId('feed') as HTMLTextAreaElement
  fireEvent.change(feed, { target: { value: text, selectionStart: text.length } })
}

describe('unified @ popover extra-row pick keeps the composer text (POO-196 R-1)', () => {
  it('pointer pick of a skill row inserts into the existing draft instead of clearing it', async () => {
    const { applied, picks } = mountHarness()

    // A draft already on the table, then the asset trigger with a query —
    // exactly the "project session with existing text" setup.
    type('请审阅这份方案 @rev')
    expect(screen.getByTestId('pc-mention-popover')).toBeTruthy()
    await screen.findByTestId('pc-mention-extra-skill:reviewer')

    fireEvent.mouseDown(screen.getByTestId('pc-mention-extra-skill:reviewer'))

    // The draft survives and the mention lands where the `@query` was.
    expect((screen.getByTestId('applied-value') as HTMLInputElement).value)
      .toBe('请审阅这份方案 [skill:.agents:reviewer] ')
    expect(applied).toHaveLength(1)
    expect(applied[0]!.cursor).toBe('请审阅这份方案 [skill:.agents:reviewer] '.length)
    // The pick went to the mention insertion, not to an asset chip.
    expect(picks).toHaveLength(0)
    // The popover closed after the pick.
    expect(screen.queryByTestId('pc-mention-popover')).toBeNull()
  })

  it('keyboard Enter over a skill row inserts the same way (chooseActive path)', async () => {
    const { applied, picks } = mountHarness()

    type('先写结论 @rev')
    await screen.findByTestId('pc-mention-extra-skill:reviewer')

    // With zero asset hits the first selectable row is the skill (index 0).
    fireEvent.click(screen.getByTestId('key-enter'))

    expect((screen.getByTestId('applied-value') as HTMLInputElement).value)
      .toBe('先写结论 [skill:.agents:reviewer] ')
    expect(applied).toHaveLength(1)
    expect(picks).toHaveLength(0)
    expect(screen.queryByTestId('pc-mention-popover')).toBeNull()
  })

  it('pointer pick of a source row keeps the draft and inserts the source mention', async () => {
    const { applied } = mountHarness()

    type('看下数据 @ga')
    await screen.findByTestId('pc-mention-extra-source:ga')

    fireEvent.mouseDown(screen.getByTestId('pc-mention-extra-source:ga'))

    expect((screen.getByTestId('applied-value') as HTMLInputElement).value)
      .toBe('看下数据 [source:ga] ')
    expect(applied).toHaveLength(1)
    expect(screen.queryByTestId('pc-mention-popover')).toBeNull()
  })

  it('a pick never resets the composer to an empty value (the R-1 regression shape)', async () => {
    const { applied } = mountHarness()

    type('长一点的正文，不能被清掉 @architect')
    await screen.findByTestId('pc-mention-extra-skill:architect')
    fireEvent.click(screen.getByTestId('key-enter'))

    expect(applied.some((entry) => entry.value === '' && entry.cursor === 0)).toBe(false)
  })
})
