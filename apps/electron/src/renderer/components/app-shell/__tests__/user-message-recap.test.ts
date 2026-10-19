import { describe, test, expect } from 'bun:test'
import type { Turn } from '@polo-ai/ui'
import type { Message, StoredAttachment } from '../../../../shared/types'
import {
  RECAP_SESSION_ATTRIBUTE,
  RECAP_TITLE_MAX_LENGTH,
  collapseRecapWhitespace,
  computeRecapScrollTop,
  createStickyBottomScrollGate,
  isElementInRecapScope,
  isRecapTargetScrolledOut,
  resolveRecapPreview,
  resolveVisibleUserText,
  selectLatestSentUserTurn,
  tailwindPaddingTopPx,
  truncateRecapTitle,
  type DeferredTimer,
} from '../user-message-recap'

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'u1',
    role: 'user',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  }
}

function userTurn(message: Message, timestamp = message.timestamp): Turn {
  return { type: 'user', message, timestamp }
}

function systemTurn(content: string, timestamp: number): Turn {
  return { type: 'system', message: { id: `sys-${timestamp}`, role: 'error', content, timestamp }, timestamp }
}

function badge(overrides: Partial<NonNullable<Message['badges']>[number]> & { start: number; end: number }): NonNullable<Message['badges']>[number] {
  return { type: 'source', label: 'Linear', rawText: '@linear', ...overrides }
}

function storedAttachment(name: string, id = name): StoredAttachment {
  return { id, type: 'image', name, mimeType: 'image/png', size: 1024, storedPath: `/tmp/attachments/${id}` }
}

describe('selectLatestSentUserTurn', () => {
  test('returns null for an empty turn list', () => {
    expect(selectLatestSentUserTurn([])).toBeNull()
  })

  test('returns null when only non-user turns exist', () => {
    expect(selectLatestSentUserTurn([systemTurn('boom', 1), systemTurn('again', 2)])).toBeNull()
  })

  test('picks the last user turn even when error/auth/assistant turns follow it', () => {
    // Regression shape for "user turns are not always in the last 20": the
    // scan must walk the whole list, not a bounded tail.
    const turns: Turn[] = [
      userTurn(userMessage({ id: 'u1', timestamp: 10 }), 10),
      ...Array.from({ length: 30 }, (_, i) => systemTurn(`noise-${i}`, 20 + i)),
    ]
    const target = selectLatestSentUserTurn(turns)
    expect(target?.turn.message.id).toBe('u1')
    expect(target?.index).toBe(0)
  })

  test('skips queued and pending user messages instead of replacing the sent one', () => {
    const turns: Turn[] = [
      userTurn(userMessage({ id: 'sent', timestamp: 10 }), 10),
      systemTurn('status noise', 11),
      userTurn(userMessage({ id: 'queued', timestamp: 12, isQueued: true }), 12),
      userTurn(userMessage({ id: 'pending', timestamp: 13, isPending: true }), 13),
    ]
    const target = selectLatestSentUserTurn(turns)
    expect(target?.turn.message.id).toBe('sent')
    expect(target?.index).toBe(0)
  })

  test('returns null when every user message is pending/queued', () => {
    const turns: Turn[] = [
      userTurn(userMessage({ id: 'queued', isQueued: true })),
      userTurn(userMessage({ id: 'pending', isPending: true })),
    ]
    expect(selectLatestSentUserTurn(turns)).toBeNull()
  })

  test('picks the latest sent message when a newer one has landed for real', () => {
    const turns: Turn[] = [
      userTurn(userMessage({ id: 'old', timestamp: 10 }), 10),
      userTurn(userMessage({ id: 'new', timestamp: 20 }), 20),
    ]
    const target = selectLatestSentUserTurn(turns)
    expect(target?.turn.message.id).toBe('new')
    expect(target?.index).toBe(1)
  })
})

describe('resolveVisibleUserText — badge semantics mirror UserMessageBubble', () => {
  // Kept labels are space-padded tokens; single-line assertions run through
  // collapseRecapWhitespace, which is what the Recap preview applies.
  const oneLine = (text: string, badges: NonNullable<Message['badges']>) =>
    collapseRecapWhitespace(resolveVisibleUserText(text, badges))

  test('passes plain content through untouched', () => {
    expect(resolveVisibleUserText('ship the recap feature', undefined)).toBe('ship the recap feature')
    expect(resolveVisibleUserText('ship the recap feature', [])).toBe('ship the recap feature')
  })

  test('replaces source/skill badges with their display label (raw mention hidden)', () => {
    expect(oneLine('check @linear please', [badge({ start: 6, end: 13, label: 'Linear' })]))
      .toBe('check Linear please')
  })

  test('context badges collapse the hidden range to collapsedLabel', () => {
    expect(oneLine('before <hidden-context> after', [
      badge({ type: 'context', start: 7, end: 23, label: 'ctx', collapsedLabel: 'Edit: Permissions' }),
    ])).toBe('before Edit: Permissions after')
  })

  test('context badges without collapsedLabel fall back to label', () => {
    expect(oneLine('a<ctx>b', [badge({ type: 'context', start: 1, end: 6, label: 'Context' })]))
      .toBe('a Context b')
  })

  test('edit_request context badges remove the wrapped range entirely', () => {
    // '<edit_request>' (14) + '{"x":1}' (7) + '</edit_request>' (15) = 36
    expect(oneLine('<edit_request>{"x":1}</edit_request>make it bold', [
      badge({ type: 'context', start: 0, end: 36, rawText: '<edit_request>{"x":1}</edit_request>' }),
    ])).toBe('make it bold')
  })

  test('keeps real user follow-up text around removed ranges', () => {
    // 'summary of request ' is 19 chars; '<edit_request>junk</edit_request>' is 33.
    expect(oneLine('summary of request <edit_request>junk</edit_request> plus follow-up', [
      badge({ type: 'context', start: 19, end: 52, rawText: '<edit_request>junk</edit_request>' }),
    ])).toBe('summary of request plus follow-up')
  })
})

describe('collapseRecapWhitespace', () => {
  test('folds multiline markdown into one trimmed line', () => {
    expect(collapseRecapWhitespace('first line\n\nsecond   line\n\tthird')).toBe('first line second line third')
  })

  test('collapses whitespace-only content to an empty string', () => {
    expect(collapseRecapWhitespace('  \n\t ')).toBe('')
  })
})

describe('resolveRecapPreview', () => {
  test('returns collapsed visible text for a normal message', () => {
    const preview = resolveRecapPreview(userMessage({ content: 'line one\nline two' }))
    expect(preview).toEqual({ kind: 'text', text: 'line one line two' })
  })

  test('hides context-wrapped content behind its badge label', () => {
    const preview = resolveRecapPreview(userMessage({
      content: '<system-note>do not leak</system-note>please fix the bug',
      badges: [badge({ type: 'context', start: 0, end: 38, label: 'note', collapsedLabel: 'Context' })],
    }))
    expect(preview).toEqual({ kind: 'text', text: 'Context please fix the bug' })
  })

  test('falls back to a single attachment name for attachment-only messages', () => {
    const preview = resolveRecapPreview(userMessage({
      content: '',
      attachments: [storedAttachment('screenshot.png', 'a')],
    }))
    expect(preview).toEqual({ kind: 'attachments', names: ['screenshot.png'] })
  })

  test('reports every attachment when several accompany an empty message', () => {
    const preview = resolveRecapPreview(userMessage({
      content: '   ',
      attachments: [storedAttachment('a.png', 'a'), storedAttachment('b.pdf', 'b')],
    }))
    expect(preview).toEqual({ kind: 'attachments', names: ['a.png', 'b.pdf'] })
  })

  test('prefers text over attachments when both exist', () => {
    const preview = resolveRecapPreview(userMessage({
      content: 'look at this',
      attachments: [storedAttachment('a.png', 'a')],
    }))
    expect(preview).toEqual({ kind: 'text', text: 'look at this' })
  })

  test('returns empty for a blank message without attachments', () => {
    expect(resolveRecapPreview(userMessage({ content: '' }))).toEqual({ kind: 'empty' })
  })
})

describe('recap geometry', () => {
  test('shows only once the whole message scrolled out above the viewport', () => {
    expect(isRecapTargetScrolledOut({ top: -200, bottom: -10 }, 0)).toBe(true)
    // Long message still partially visible → hidden (edge inclusive).
    expect(isRecapTargetScrolledOut({ top: -100, bottom: 0 }, 0)).toBe(true)
    expect(isRecapTargetScrolledOut({ top: -100, bottom: 1 }, 0)).toBe(false)
    // Target below the viewport top (user scrolled up) → hidden.
    expect(isRecapTargetScrolledOut({ top: 40, bottom: 300 }, 0)).toBe(false)
  })

  test('computes the reveal scrollTop relative to the real viewport and clamps at 0', () => {
    expect(computeRecapScrollTop({ targetTop: -50, viewportTop: 10, scrollTop: 260, offsetPx: 48 })).toBe(152)
    expect(computeRecapScrollTop({ targetTop: -400, viewportTop: 10, scrollTop: 5, offsetPx: 48 })).toBe(0)
  })

  test('derives the reveal offset from CHAT_LAYOUT spacing classes, not new constants', () => {
    expect(tailwindPaddingTopPx('py-8', 'pt-4 pb-2')).toBe(48) // normal: py-8 + pt-4
    expect(tailwindPaddingTopPx('py-4', 'pt-2 pb-1')).toBe(24) // compact: py-4 + pt-2
    expect(tailwindPaddingTopPx('px-5', 'space-y-2.5', undefined)).toBe(0)
  })
})

describe('isElementInRecapScope — AnimatePresence stale-node guard', () => {
  function fakeElement(scopeSessionId: string | null) {
    const attrs = new Map<string, string>()
    if (scopeSessionId !== null) attrs.set(RECAP_SESSION_ATTRIBUTE, scopeSessionId)
    return {
      closest: (selector: string) => {
        if (selector !== `[${RECAP_SESSION_ATTRIBUTE}]`) return null
        return attrs.has(RECAP_SESSION_ATTRIBUTE)
          ? { getAttribute: (name: string) => attrs.get(name) ?? null }
          : null
      },
    }
  }

  test('accepts the element inside the rendered session subtree', () => {
    const el = fakeElement('session-a') as unknown as Element
    expect(isElementInRecapScope(el, 'session-a')).toBe(true)
  })

  test('rejects exiting nodes of a previous session (shared/branched message ids)', () => {
    const el = fakeElement('session-old') as unknown as Element
    expect(isElementInRecapScope(el, 'session-new')).toBe(false)
    expect(isElementInRecapScope(fakeElement(null) as unknown as Element, 'session-new')).toBe(false)
  })
})

describe('createStickyBottomScrollGate — POO-111 debounce race regression', () => {
  interface TimerHarness {
    timer: DeferredTimer
    advance: (ms: number) => void
    hasPending: () => boolean
  }

  function createManualTimer(): TimerHarness {
    const jobs = new Map<number, { fn: () => void; at: number }>()
    let nextId = 1
    let now = 0
    const timer: DeferredTimer = {
      set(fn, ms) {
        const id = nextId++
        jobs.set(id, { fn, at: now + ms })
        return id
      },
      // `clear` receives the handle returned by `set`, so jobs stay keyed.
      clear(handle) {
        jobs.delete(handle as number)
      },
    }
    return {
      timer,
      advance(ms) {
        now += ms
        for (const [id, job] of [...jobs.entries()].sort(([, a], [, b]) => a.at - b.at)) {
          if (job.at > now) continue
          jobs.delete(id)
          job.fn()
        }
      },
      hasPending: () => jobs.size > 0,
    }
  }

  test('drops the pending bottom-scroll when stickiness was undone before it fires', () => {
    // This is the red test for the race: the debounce was scheduled while
    // stuck-to-bottom, then a Recap click unstuck and scrolled away. The old
    // inline timer still ran the callback and yanked the user back down.
    const harness = createManualTimer()
    let sticky = true
    const gate = createStickyBottomScrollGate({ isSticky: () => sticky, timer: harness.timer })
    let scrolled = 0
    gate.schedule(() => {
      scrolled++
    })

    sticky = false // Recap click stops bottom-following
    harness.advance(200)
    expect(scrolled).toBe(0)
  })

  test('still auto-scrolls when the user remained at the bottom', () => {
    const harness = createManualTimer()
    const gate = createStickyBottomScrollGate({ isSticky: () => true, timer: harness.timer })
    let scrolled = 0
    gate.schedule(() => {
      scrolled++
    })
    harness.advance(200)
    expect(scrolled).toBe(1)
    expect(harness.hasPending()).toBe(false)
  })

  test('reschedules replace the pending timer and cancel drops it', () => {
    const harness = createManualTimer()
    const gate = createStickyBottomScrollGate({ isSticky: () => true, timer: harness.timer })
    const runs: number[] = []
    gate.schedule(() => runs.push(1))
    gate.schedule(() => runs.push(2))
    expect(harness.hasPending()).toBe(true)
    harness.advance(200)
    expect(runs).toEqual([2])

    gate.schedule(() => runs.push(3))
    gate.cancel()
    expect(harness.hasPending()).toBe(false)
    harness.advance(500)
    expect(runs).toEqual([2])
  })
})

describe('truncateRecapTitle — native tooltip cap', () => {
  test('keeps short previews verbatim', () => {
    expect(truncateRecapTitle('short message')).toBe('short message')
  })

  test('caps very long previews at the follow-up-chip precedent length', () => {
    const long = 'x'.repeat(600)
    const truncated = truncateRecapTitle(long)
    expect(truncated.length).toBe(RECAP_TITLE_MAX_LENGTH)
    expect(truncated.endsWith('…')).toBe(true)
  })

  test('honors a custom limit', () => {
    expect(truncateRecapTitle('abcdefghij', 5)).toBe('abcd…')
  })
})
