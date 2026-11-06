/**
 * POO-173/FILELINK-01/02 — right-click context menu on file links in rendered
 * markdown.
 *
 * Covered here, walking the REAL user path (HappyDOM + testing-library, like
 * calendar.interaction.isolated.ts):
 * - both menu actions dispatch the right callback with the resolved
 *   (file:-stripped) path — reveal via onRevealInFinder, copy via the explicit
 *   onCopyToClipboard or the renderer clipboard fallback;
 * - relative and space-bearing paths pass through untouched;
 * - URL links and plain text keep their native right-click (no menu hijack)
 *   while text selection/copy affordances stay untouched (FILELINK-02);
 * - capability gating: missing platform hooks hide their item, no hooks at all
 *   means no menu at all;
 * - copy failure surfaces inline (menu stays open, error label) instead of
 *   faking success;
 * - left-click / middle-click / keyboard activation of the wrapped anchor are
 *   all preserved.
 */

import { describe, it, expect, afterEach, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
HTMLElement.prototype.scrollIntoView ??= () => {}

// Same stubs as markdown-link-routing.test.ts: the full Markdown tree pulls
// pdf.js via Vite's `?url` suffix, which bun cannot resolve.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'data:application/pdf' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}))

const React = await import('react')
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react')
const { I18nextProvider } = await import('react-i18next')
const i18next = (await import('i18next')).default
const { renderToStaticMarkup } = await import('react-dom/server')

const { Markdown } = await import('../Markdown')
const {
  executeFileLinkMenuAction,
  resolveFileLinkMenuAvailability,
} = await import('../FileLinkContextMenu')
const { PlatformProvider } = await import('../../../context/PlatformContext')
const { resolveMarkdownLinkTarget } = await import('../link-target')

afterEach(cleanup)

const REVEAL_LABEL = '在 Finder 中显示' // sessionMenu.showInFileManager + fileManagerName default
const COPY_LABEL = '复制路径' // sessionMenu.copyPath
const COPY_FAILED_LABEL = '复制失败' // toast.copyFailed

interface Harness {
  i18n: unknown
  revealed: string[]
  copied: string[]
  fileClicked: string[]
  urlClicked: string[]
}

interface HarnessOverrides {
  /** PlatformActions overrides (undefined values hide the capability). */
  actions?: Record<string, unknown>
}

async function renderMarkdownDoc(markdown: string, overrides: HarnessOverrides = {}) {
  const harness: Harness = {
    i18n: await makeI18n(),
    revealed: [],
    copied: [],
    fileClicked: [],
    urlClicked: [],
  }

  const renderTree = () => {
    const actions = {
      onRevealInFinder: (path: string) => harness.revealed.push(path),
      onCopyToClipboard: (text: string) => {
        harness.copied.push(text)
        return Promise.resolve()
      },
      fileManagerName: 'Finder',
      ...(overrides.actions ?? {}),
    }
    render(React.createElement(
      I18nextProvider,
      { i18n: harness.i18n },
      React.createElement(
        PlatformProvider,
        { actions },
        React.createElement(
          Markdown,
          {
            mode: 'minimal',
            onFileClick: (path: string) => harness.fileClicked.push(path),
            onUrlClick: (url: string) => harness.urlClicked.push(url),
          },
          markdown,
        ),
      ),
    ))
  }

  renderTree()
  return harness
}

async function makeI18n() {
  const i18n = i18next.createInstance()
  await i18n.init({
    lng: 'zh-Hans',
    resources: {
      'zh-Hans': {
        translation: {
          'sessionMenu.showInFileManager': '在 {{fileManager}} 中显示',
          'sessionMenu.copyPath': '复制路径',
          'toast.copyFailed': '复制失败',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
  return i18n
}

/** Swap the global clipboard (undefined in bun) for a controllable stub.
 *  Async-safe: the stub stays installed until `fn` (and its promise) settles. */
async function withNavigatorClipboard<T>(
  stub: { writeText: (text: string) => Promise<void> } | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: stub, configurable: true })
  try {
    return await fn()
  } finally {
    delete (globalThis.navigator as { clipboard?: unknown }).clipboard
  }
}

async function openMenuOn(triggerText: string | RegExp) {
  fireEvent.contextMenu(screen.getByText(triggerText))
  return screen.findByRole('menu')
}

// ============================================================================
// FILELINK-01: both actions, real dispatch, resolved path
// ============================================================================

describe('file-link context menu actions (FILELINK-01)', () => {
  const FILE_DOC = '[报告](file:///Users/tester/report.pdf)'

  it('right-click opens a menu with both items and reveal dispatches the file:-stripped path', async () => {
    const harness = await renderMarkdownDoc(FILE_DOC)

    await openMenuOn('报告')

    expect(screen.getByText(REVEAL_LABEL)).toBeTruthy()
    expect(screen.getByText(COPY_LABEL)).toBeTruthy()

    fireEvent.click(screen.getByText(REVEAL_LABEL))
    expect(harness.revealed).toEqual(['/Users/tester/report.pdf'])
    expect(harness.fileClicked).toEqual([]) // right-click must not fire the left-click callback
  })

  it('copy dispatches the explicit onCopyToClipboard with the same resolved path', async () => {
    const harness = await renderMarkdownDoc(FILE_DOC)

    await openMenuOn('报告')
    fireEvent.click(screen.getByText(COPY_LABEL))
    // flush the async copy so the item's outcome state settles inside act
    await act(async () => {})

    expect(harness.copied).toEqual(['/Users/tester/report.pdf'])
    expect(harness.revealed).toEqual([])
  })

  it('passes relative and space-bearing paths through untouched', async () => {
    const harness = await renderMarkdownDoc(
      '[相对](apps/notes/readme.md) 和 [带空格](file:///Users/tester/my%20notes.md)',
    )

    await openMenuOn('相对')
    fireEvent.click(screen.getByText(REVEAL_LABEL))
    await openMenuOn('带空格')
    fireEvent.click(screen.getByText(REVEAL_LABEL))

    // relative path stays literal; file: URL keeps its percent-decoded space
    expect(harness.revealed).toEqual(['apps/notes/readme.md', '/Users/tester/my notes.md'])
  })

  it('a percent-encoded relative href is NOT a file target — no menu, native right-click', async () => {
    await renderMarkdownDoc('[相对](apps/notes/read%20me.md)')

    fireEvent.contextMenu(screen.getByText('相对'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renderer clipboard fallback backs the copy item when no explicit hook is provided', async () => {
    const written: string[] = []
    // The stub must cover render (gating) AND the click (action reads it).
    const harness = await withNavigatorClipboard(
      { writeText: async (t: string) => { written.push(t) } },
      async () => {
        const h = await renderMarkdownDoc(FILE_DOC, { actions: { onCopyToClipboard: undefined } })
        await openMenuOn('报告')
        expect(screen.getByText(COPY_LABEL)).toBeTruthy()
        fireEvent.click(screen.getByText(COPY_LABEL))
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        return h
      },
    )
    expect(written).toEqual(['/Users/tester/report.pdf'])
    expect(harness.revealed).toEqual([])
  })
})

// ============================================================================
// FILELINK-02: unrelated targets keep native behavior; anchor paths preserved
// ============================================================================

describe('native context menu is preserved for non-file targets (FILELINK-02)', () => {
  const MIXED_DOC = [
    '普通文字与 [站点](https://example.com/source) 链接。',
    '再加一个 [本地文件](file:///Users/tester/report.pdf)。',
  ].join('')

  it('right-clicking a URL link or plain text opens no app menu', async () => {
    await renderMarkdownDoc(MIXED_DOC)

    fireEvent.contextMenu(screen.getByText('站点'))
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(screen.getByText(/普通文字与/))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('only the file link gets the app menu in a mixed document', async () => {
    await renderMarkdownDoc(MIXED_DOC)

    await openMenuOn('本地文件')
    expect(screen.getByText(REVEAL_LABEL)).toBeTruthy()
    // exactly one menu portal opened
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  it('URL link left-click still routes through onUrlClick', async () => {
    const harness = await renderMarkdownDoc(MIXED_DOC)

    fireEvent.click(screen.getByText('站点'))
    expect(harness.urlClicked).toEqual(['https://example.com/source'])
  })

  it('wrapped anchor keeps left-click, middle-click and keyboard activation', async () => {
    const harness = await renderMarkdownDoc('[报告](file:///Users/tester/report.pdf)')
    const link = screen.getByText('报告')

    fireEvent.click(link)
    expect(harness.fileClicked).toEqual(['/Users/tester/report.pdf'])

    harness.fileClicked.length = 0
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(harness.fileClicked).toEqual(['/Users/tester/report.pdf'])

    harness.fileClicked.length = 0
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(harness.fileClicked).toEqual(['/Users/tester/report.pdf'])
  })
})

// ============================================================================
// Capability gating
// ============================================================================

describe('capability gating', () => {
  const FILE_DOC = '[报告](file:///Users/tester/report.pdf)'

  it('hides the reveal item when onRevealInFinder is missing', async () => {
    await renderMarkdownDoc(FILE_DOC, { actions: { onRevealInFinder: undefined } })

    await openMenuOn('报告')
    expect(screen.getByText(COPY_LABEL)).toBeTruthy()
    expect(screen.queryByText(REVEAL_LABEL)).toBeNull()
  })

  it('hides the copy item when neither explicit hook nor renderer clipboard exists', async () => {
    await withNavigatorClipboard(undefined, async () => {
      await renderMarkdownDoc(FILE_DOC, { actions: { onCopyToClipboard: undefined } })

      await openMenuOn('报告')
      expect(screen.getByText(REVEAL_LABEL)).toBeTruthy()
      expect(screen.queryByText(COPY_LABEL)).toBeNull()
    })
  })

  it('renders no menu at all when the platform offers neither action', async () => {
    await withNavigatorClipboard(undefined, async () => {
      await renderMarkdownDoc(FILE_DOC, {
        actions: { onRevealInFinder: undefined, onCopyToClipboard: undefined },
      })

      fireEvent.contextMenu(screen.getByText('报告'))
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  it('availability gate matches the rendered behavior', async () => {
    await withNavigatorClipboard(undefined, () => {
      expect(resolveFileLinkMenuAvailability({})).toEqual({ canReveal: false, canCopy: false })
      expect(resolveFileLinkMenuAvailability({ onRevealInFinder: () => {} }))
        .toEqual({ canReveal: true, canCopy: false })
      expect(resolveFileLinkMenuAvailability({ onCopyToClipboard: async () => {} }))
        .toEqual({ canReveal: false, canCopy: true })
    })
    await withNavigatorClipboard({ writeText: async () => {} }, () => {
      expect(resolveFileLinkMenuAvailability({}).canCopy).toBe(true)
    })
  })
})

// ============================================================================
// Honest failure feedback
// ============================================================================

describe('copy failure feedback', () => {
  it('keeps the menu open, shows the inline error and does not report success', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const harness = await renderMarkdownDoc('[报告](file:///Users/tester/report.pdf)', {
        actions: {
          onCopyToClipboard: () => Promise.reject(new Error('clipboard blocked')),
        },
      })

      await openMenuOn('报告')
      fireEvent.click(screen.getByText(COPY_LABEL))

      // failure feedback swaps the label in place; the menu stays open for retry
      const errorItem = await screen.findByText(COPY_FAILED_LABEL)
      expect(errorItem.className).toContain('text-destructive')
      expect(screen.queryByText(COPY_LABEL)).toBeNull()
      expect(screen.getByRole('menu')).toBeTruthy()
      expect(harness.copied).toEqual([])
      expect(consoleSpy).toHaveBeenCalled()
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

// ============================================================================
// Logic layer: executeFileLinkMenuAction (dispatch parity + failure result)
// ============================================================================

describe('executeFileLinkMenuAction', () => {
  it('reveal forwards the path to onRevealInFinder only', async () => {
    const revealed: string[] = []
    const copied: string[] = []
    const result = await executeFileLinkMenuAction('reveal', '/tmp/a b.md', {
      onRevealInFinder: (p: string) => { revealed.push(p) },
      onCopyToClipboard: async (t: string) => { copied.push(t) },
    })
    expect(result).toEqual({ ok: true })
    expect(revealed).toEqual(['/tmp/a b.md'])
    expect(copied).toEqual([])
  })

  it('copy forwards the path to onCopyToClipboard only', async () => {
    const revealed: string[] = []
    const copied: string[] = []
    const result = await executeFileLinkMenuAction('copy', '/tmp/x.md', {
      onRevealInFinder: (p: string) => { revealed.push(p) },
      onCopyToClipboard: async (t: string) => { copied.push(t) },
    })
    expect(result).toEqual({ ok: true })
    expect(copied).toEqual(['/tmp/x.md'])
    expect(revealed).toEqual([])
  })

  it('copy falls back to the renderer clipboard when no explicit hook exists', async () => {
    const written: string[] = []
    await withNavigatorClipboard({ writeText: async (t: string) => { written.push(t) } }, async () => {
      const result = await executeFileLinkMenuAction('copy', '/tmp/fallback.md', {})
      expect(result).toEqual({ ok: true })
      expect(written).toEqual(['/tmp/fallback.md'])
    })
  })

  it('copy reports ok:false on rejection instead of faking success', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withNavigatorClipboard(undefined, async () => {
        const result = await executeFileLinkMenuAction('copy', '/tmp/y.md', {
          onCopyToClipboard: () => Promise.reject(new Error('denied')),
        })
        expect(result.ok).toBe(false)
      })
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('path pass-through is byte-identical for empty, relative and space-bearing values', async () => {
    const seen: string[] = []
    const capture = (p: string) => { seen.push(p) }
    for (const path of ['', 'apps/rel.md', 'my notes.md', 'file-with-%20percent.md']) {
      await executeFileLinkMenuAction('reveal', path, { onRevealInFinder: capture })
      await executeFileLinkMenuAction('copy', path, { onCopyToClipboard: async (t: string) => { capture(t) } })
    }
    // reveal+copy interleave per path, in loop order
    expect(seen).toEqual([
      '', '', 'apps/rel.md', 'apps/rel.md',
      'my notes.md', 'my notes.md', 'file-with-%20percent.md', 'file-with-%20percent.md',
    ])
  })
})

// ============================================================================
// Static structure: wrapping is scoped to file targets only (SSR evidence)
// ============================================================================

describe('static markdown structure', () => {
  function makeI18nSync() {
    const instance = i18next.createInstance({ initImmediate: false })
    instance.init({ lng: 'zh-Hans', resources: {}, interpolation: { escapeValue: false } })
    return instance
  }

  function staticRender(markdown: string, actions?: Record<string, unknown>): string {
    return renderToStaticMarkup(React.createElement(
      I18nextProvider,
      { i18n: makeI18nSync() },
      React.createElement(
        PlatformProvider,
        { actions: actions ?? {} },
        React.createElement(Markdown, { mode: 'minimal' }, markdown),
      ),
    ))
  }

  it('wraps only the file anchor with radix trigger markers; url anchors stay bare', async () => {
    await withNavigatorClipboard(undefined, () => {
      const html = staticRender(
        '[站点](https://example.com/a) 与 [文件](file:///tmp/doc.md)',
        { onRevealInFinder: () => {}, onCopyToClipboard: async () => {} },
      )
      // file: hrefs are stripped from the DOM by defaultUrlTransform — the
      // radix-merged anchor is identified by data-state (attribute order is
      // Radix's), the url anchor must not carry it.
      const urlAnchor = html.match(/<a[^>]*href="https:\/\/example\.com\/a"[^>]*>/)?.[0] ?? ''
      expect(urlAnchor).not.toContain('data-state')
      expect(/<a [^>]*data-state="closed"/.test(html)).toBe(true)
      // exactly one radix-wrapped anchor in the document
      expect(html.split('data-state="closed"').length - 1).toBe(1)
    })
  })

  it('renders the bare anchor when the platform has no menu capability', async () => {
    await withNavigatorClipboard(undefined, () => {
      const html = staticRender('[文件](file:///tmp/doc.md)')
      expect(html).toContain('<a')
      expect(html).not.toContain('data-state')
    })
  })

  it('empty anchor text stays a non-link (resolver routes it to url, no menu)', async () => {
    await withNavigatorClipboard(undefined, () => {
      // '' resolves to {kind:'url'} — never to a file target — so even with
      // full capabilities no context-menu wrapping can appear for it.
      expect(resolveMarkdownLinkTarget('').kind).toBe('url')
      const html = staticRender('见 [Source 1]() 参考。', {
        onRevealInFinder: () => {},
        onCopyToClipboard: async () => {},
      })
      expect(html).not.toContain('<a')
      expect(html).not.toContain('data-state')
    })
  })
})
