import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import * as React from 'react'
import type { MentionInputElement } from '@/components/ui/mention-menu'
import type { AssetMentionHit, UseAssetMentionResult } from '../AssetMentionPopover'
import type { PcSearchResponse } from '@polo-ai/shared/protocol'

/**
 * POO-196 AssetMentionPopover (isolated happy-dom render): the `@` trigger
 * lifecycle over the composer contract — debounced search, keyboard
 * navigation (↑/↓/Enter/Esc), trigger-text stripping on pick, the empty face
 * that never steals Enter, and the degraded note.
 */

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor, act } = await import('@testing-library/react')
const { createElement, useCallback, useRef, useState } = React
const { AssetMentionPopover, useAssetMention } = await import('../AssetMentionPopover')

interface HarnessHandles {
  state: UseAssetMentionResult | null
}

function makeSearch(response: PcSearchResponse, calls: string[]) {
  return async (q: string): Promise<PcSearchResponse> => {
    calls.push(q)
    return response
  }
}

function Harness(props: {
  search: (q: string) => Promise<PcSearchResponse>
  onPick: (hit: AssetMentionHit) => void
  applied: Array<{ value: string; cursor: number }>
  handles: HarnessHandles
}) {
  const inputRef = useRef<MentionInputElement | null>(null)
  const [applied, setApplied] = useState({ value: '', cursor: 0 })
  const applyInputValue = useCallback((value: string, cursor: number) => {
    props.applied.push({ value, cursor })
    setApplied({ value, cursor })
  }, [props.applied])
  const state = useAssetMention({
    enabled: true,
    inputRef,
    search: props.search,
    onPick: props.onPick,
    applyInputValue,
  })
  props.handles.state = state
  return createElement(
    'div',
    null,
    createElement('input', {
      'data-testid': 'feed',
      value: applied.value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        const el = event.currentTarget
        // happy-dom types selectionStart as nullable; adapt to the hook's
        // MentionInputElement contract (caret rect stays on the fallback path).
        inputRef.current = {
          getBoundingClientRect: () => el.getBoundingClientRect(),
          getCaretRect: () => null,
          value: el.value,
          selectionStart: el.selectionStart ?? el.value.length,
        }
        state.handleInputChanged(el.value, el.selectionStart ?? el.value.length)
      },
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'key-down',
      onClick: () => state.handleKeyDown({ key: 'ArrowDown' }),
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'key-up',
      onClick: () => state.handleKeyDown({ key: 'ArrowUp' }),
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'key-enter',
      onClick: () => state.handleKeyDown({ key: 'Enter' }),
    }),
    createElement('button', {
      type: 'button',
      'data-testid': 'key-esc',
      onClick: () => state.handleKeyDown({ key: 'Escape' }),
    }),
    createElement('input', {
      'data-testid': 'applied-value',
      readOnly: true,
      value: applied.value,
    }),
    createElement(AssetMentionPopover, { state, onChoose: props.onPick }),
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SEARCH_RESPONSE: PcSearchResponse = {
  degraded: false,
  hits: [
    { assetId: 'asset-1', version: 3, name: 'Spec.md', tags: [{ id: 'requirement', label: 'requirement', preset: true }], snippet: 'the bounded spec', score: 0.9 },
    { assetId: 'asset-2', version: 1, name: 'Design.html', tags: [], snippet: null, score: 0.5 },
  ],
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

function mountHarness(options: {
  response?: PcSearchResponse
  onPick?: (hit: AssetMentionHit) => void
}) {
  const calls: string[] = []
  const applied: Array<{ value: string; cursor: number }> = []
  const picks: AssetMentionHit[] = []
  const handles: HarnessHandles = { state: null }
  const onPick = options.onPick ?? ((hit: AssetMentionHit) => picks.push(hit))
  const view = render(createElement(
    I18nextProvider,
    { i18n },
    createElement(Harness, {
      search: makeSearch(options.response ?? SEARCH_RESPONSE, calls),
      onPick,
      applied,
      handles,
    }),
  ))
  return { calls, applied, picks, handles, view }
}

function type(query: string) {
  const feed = screen.getByTestId('feed') as HTMLInputElement
  fireEvent.change(feed, { target: { value: query, selectionStart: query.length } })
}

describe('AssetMentionPopover (POO-196)', () => {
  it('opens on @, debounces the query onto one search, and lists the hits with versions', async () => {
    const { calls } = mountHarness({})

    // Bare `@` opens the popover without burning a search.
    type('@')
    expect(screen.getByTestId('pc-mention-popover')).toBeTruthy()
    await act(async () => { await sleep(340) })
    expect(calls).toEqual([])

    // Typing the query coalesces into ONE debounced call per quiet window.
    type('@sp')
    await act(async () => { await sleep(80) })
    type('@spec')
    await act(async () => { await sleep(340) })
    expect(calls).toEqual(['spec'])

    await waitFor(() => expect(screen.getByTestId('pc-mention-option-asset-1')).toBeTruthy())
    expect(screen.getByTestId('pc-mention-option-asset-1').textContent).toContain('Spec.md')
    expect(screen.getByTestId('pc-mention-option-asset-1').textContent).toContain('v3')
    expect(screen.getByTestId('pc-mention-option-asset-2').textContent).toContain('Design.html')
  })

  it('keyboard contract: ↓/↑ move the highlight, Enter picks and strips the @query token, Esc closes', async () => {
    const { picks, applied } = mountHarness({})
    type('@spec')
    await screen.findByTestId('pc-mention-option-asset-1')

    // First option highlighted by default.
    expect(screen.getByTestId('pc-mention-option-asset-1').getAttribute('data-highlighted')).toBe('true')
    fireEvent.click(screen.getByTestId('key-down'))
    expect(screen.getByTestId('pc-mention-option-asset-1').getAttribute('data-highlighted')).toBe('false')
    expect(screen.getByTestId('pc-mention-option-asset-2').getAttribute('data-highlighted')).toBe('true')
    // ↑ back to the first, then ↑ once more wraps around to the last.
    fireEvent.click(screen.getByTestId('key-up'))
    expect(screen.getByTestId('pc-mention-option-asset-1').getAttribute('data-highlighted')).toBe('true')
    fireEvent.click(screen.getByTestId('key-up'))
    expect(screen.getByTestId('pc-mention-option-asset-2').getAttribute('data-highlighted')).toBe('true')
    // One more ↑ returns to the first option for the pick below.
    fireEvent.click(screen.getByTestId('key-up'))
    expect(screen.getByTestId('pc-mention-option-asset-1').getAttribute('data-highlighted')).toBe('true')

    // Enter picks the highlighted option (identity fields; the option may carry
    // display extras like snippet/tags which the draft chip ignores)…
    fireEvent.click(screen.getByTestId('key-enter'))
    expect(picks).toHaveLength(1)
    expect(picks[0]).toMatchObject({ assetId: 'asset-1', version: 3, name: 'Spec.md' })
    // …and the @query token is stripped from the composer text (becomes a chip).
    expect(applied).toEqual([{ value: '', cursor: 0 }])
    // The popover closes after a pick.
    expect(screen.queryByTestId('pc-mention-popover')).toBeNull()
  })

  it('Esc closes without picking; Enter with zero hits does not steal the send', async () => {
    const { picks } = mountHarness({ response: { degraded: false, hits: [] } })
    type('@nothing')
    await act(async () => { await sleep(340) })
    await screen.findByTestId('pc-mention-empty')

    // Enter over an empty list returns false — the composer keeps its send key.
    expect(screen.queryByTestId('pc-mention-option-asset-1')).toBeNull()
    fireEvent.click(screen.getByTestId('key-enter'))
    expect(picks).toHaveLength(0)

    fireEvent.click(screen.getByTestId('key-esc'))
    expect(screen.queryByTestId('pc-mention-popover')).toBeNull()
  })

  it('a degraded index answer shows the name-and-tags-only note', async () => {
    mountHarness({ response: { degraded: true, hits: [{ assetId: 'asset-1', version: 1, name: 'Spec.md', tags: [], snippet: null, score: null }] } })
    type('@spec')
    await act(async () => { await sleep(340) })
    expect(await screen.findByTestId('pc-mention-degraded')).toBeTruthy()
  })

  it('a search failure never blocks the composer: the popover shows its empty face', async () => {
    const calls: string[] = []
    const applied: Array<{ value: string; cursor: number }> = []
    const picks: AssetMentionHit[] = []
    const handles: HarnessHandles = { state: null }
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(Harness, {
        search: async (q: string) => {
          calls.push(q)
          throw Object.assign(new Error('down'), { code: 'pc_service_unavailable' })
        },
        onPick: (hit: AssetMentionHit) => picks.push(hit),
        applied,
        handles,
      }),
    ))
    type('@boom')
    await act(async () => { await sleep(340) })
    expect(await screen.findByTestId('pc-mention-empty')).toBeTruthy()
    expect(picks).toHaveLength(0)
  })
})
