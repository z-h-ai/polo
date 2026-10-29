import { describe, it, expect, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { classifyMarkdownLinkTarget, isOpenableMarkdownLinkText, resolveMarkdownLinkTarget } from '../link-target'
import { markdownUrlTransform } from '../url-transform'

// The full Markdown tree pulls pdf.js via Vite's `?url` suffix, which bun
// cannot resolve — stub the viewer modules before importing the component.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'data:application/pdf' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
}))
const { Markdown } = await import('../Markdown')

describe('resolveMarkdownLinkTarget', () => {
  it('resolves absolute unix file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('/Users/balintorosz/.polo-ai/sessions/abc/image.jpg')).toEqual({
      kind: 'file',
      path: '/Users/balintorosz/.polo-ai/sessions/abc/image.jpg',
    })
  })

  it('resolves parent-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('../downloads/assets/screenshot.png')).toEqual({
      kind: 'file',
      path: '../downloads/assets/screenshot.png',
    })
  })

  it('resolves repo-relative file paths as file targets', () => {
    expect(resolveMarkdownLinkTarget('apps/electron/resources/docs/browser-tools.md')).toEqual({
      kind: 'file',
      path: 'apps/electron/resources/docs/browser-tools.md',
    })
  })

  it('resolves unix file URLs as file targets', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toEqual({
      kind: 'file',
      path: '/Users/tester/report.xlsx',
    })
  })

  it('decodes percent-encoded unix file URLs', () => {
    expect(resolveMarkdownLinkTarget('file:///Users/tester/report%20final.pdf')).toEqual({
      kind: 'file',
      path: '/Users/tester/report final.pdf',
    })
  })

  it('normalizes windows drive-letter file URLs to local paths', () => {
    expect(resolveMarkdownLinkTarget('file:///C:/Users/Tester/Deck.pptx')).toEqual({
      kind: 'file',
      path: 'C:/Users/Tester/Deck.pptx',
    })
  })

  it('resolves https links as url targets', () => {
    expect(resolveMarkdownLinkTarget('https://example.com/image.jpg')).toEqual({
      kind: 'url',
      url: 'https://example.com/image.jpg',
    })
  })

  it('resolves mailto links as url targets', () => {
    expect(resolveMarkdownLinkTarget('mailto:test@example.com')).toEqual({
      kind: 'url',
      url: 'mailto:test@example.com',
    })
  })
})

describe('markdownUrlTransform', () => {
  it('preserves dangerous anchor hrefs for custom click routing', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('file:///tmp/test.md', 'href', anchorNode as never)).toBe('file:///tmp/test.md')
    expect(markdownUrlTransform('javascript:alert(1)', 'href', anchorNode as never)).toBe('javascript:alert(1)')
  })

  it('still sanitizes dangerous non-anchor URL attributes', () => {
    const imageNode = { tagName: 'img' }
    expect(markdownUrlTransform('javascript:alert(1)', 'src', imageNode as never)).toBe('')
  })

  it('keeps safe anchor hrefs unchanged', () => {
    const anchorNode = { tagName: 'a' }
    expect(markdownUrlTransform('https://example.com', 'href', anchorNode as never)).toBe('https://example.com')
  })
})

describe('ReactMarkdown anchor rendering with markdownUrlTransform', () => {
  function render(markdown: string): string {
    return renderToStaticMarkup(React.createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: {
        a: ({ href, children }) => React.createElement('a', {
          href: href ? defaultUrlTransform(href) || undefined : undefined,
          'data-raw-href': href,
        }, children),
      },
      children: markdown,
    }))
  }

  it('lets file links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[report](file:///Users/tester/report.pdf)')
    expect(html).toContain('data-raw-href="file:///Users/tester/report.pdf"')
    expect(html).not.toContain('<a href="file:///Users/tester/report.pdf"')
  })

  it('lets javascript links reach the custom anchor while keeping the DOM href sanitized', () => {
    const html = render('[boom](javascript:alert(1))')
    expect(html).toContain('data-raw-href="javascript:alert(1)"')
    expect(html).not.toContain('<a href="javascript:alert')
  })

  it('keeps safe web links in the DOM href for normal browser affordances', () => {
    const html = render('[site](https://example.com/path)')
    expect(html).toContain('href="https://example.com/path"')
  })
})

describe('classifyMarkdownLinkTarget', () => {
  it('classifies absolute unix file paths as file', () => {
    expect(classifyMarkdownLinkTarget('/Users/balintorosz/.polo-ai/sessions/abc/image.jpg')).toBe('file')
  })

  it('classifies file URLs as file', () => {
    expect(classifyMarkdownLinkTarget('file:///Users/tester/report.xlsx')).toBe('file')
  })

  it('classifies https links as url', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/image.jpg')).toBe('url')
  })

  it('classifies mailto links as url', () => {
    expect(classifyMarkdownLinkTarget('mailto:test@example.com')).toBe('url')
  })
})

describe('isOpenableMarkdownLinkText (POO-172 CITE-02)', () => {
  it('accepts filesystem paths and URLs with an explicit scheme', () => {
    expect(isOpenableMarkdownLinkText('/Users/tester/report.pdf')).toBe(true)
    expect(isOpenableMarkdownLinkText('file:///Users/tester/report.pdf')).toBe(true)
    expect(isOpenableMarkdownLinkText('https://example.com/source')).toBe(true)
    expect(isOpenableMarkdownLinkText('mailto:test@example.com')).toBe(true)
  })

  it('rejects plain-text citation references, schemeless domains and dangerous schemes', () => {
    expect(isOpenableMarkdownLinkText('')).toBe(false)
    expect(isOpenableMarkdownLinkText('Source 1')).toBe(false)
    expect(isOpenableMarkdownLinkText('见来源 A')).toBe(false)
    expect(isOpenableMarkdownLinkText('example.com')).toBe(false)
    expect(isOpenableMarkdownLinkText('javascript:alert(1)')).toBe(false)
    expect(isOpenableMarkdownLinkText('data:text/html,<b>x</b>')).toBe(false)
  })
})

describe('Markdown empty-href anchors render as non-links (POO-172 CITE-02)', () => {
  function renderWithCallbacks(markdown: string): string {
    return renderToStaticMarkup(React.createElement(Markdown, { mode: 'minimal' }, markdown))
  }

  it('renders a plain-text citation reference as non-interactive text', () => {
    const html = renderWithCallbacks('See [Source 1]() for details.')
    expect(html).not.toContain('<a')
    expect(html).toContain('Source 1')
  })

  it('renders a schemeless domain fallback as non-interactive text', () => {
    const html = renderWithCallbacks('Read [example.com]() next.')
    expect(html).not.toContain('<a')
  })

  it('keeps an anchor-text URL fallback clickable without a DOM href', () => {
    const html = renderWithCallbacks('Read [https://example.com/source]() next.')
    expect(html).toContain('<a')
  })

  it('keeps normal markdown links clickable', () => {
    const html = renderWithCallbacks('Read [site](https://example.com/path) next.')
    expect(html).toContain('href="https://example.com/path"')
  })
})
