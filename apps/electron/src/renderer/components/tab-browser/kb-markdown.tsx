import type { ReactNode } from 'react'

/**
 * Safe Markdown subset renderer for the KB preview panes (POO-143 S3.2).
 *
 * The output is composed entirely of React elements — every text run stays a
 * `{string}` child, so the document content can never become markup (no
 * `dangerouslySetInnerHTML`, no raw injection). Links are deliberately
 * NON-navigable: the URL only surfaces as the title tooltip, because an
 * `<a href>` in the renderer window would otherwise replace the app shell.
 * Tables are not supported (acceptable per Spec S3.2).
 */

const FENCE_PATTERN = /^```(.*)$/
const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/
const HR_PATTERN = /^\s*(?:-{3,}|\*{3,})\s*$/
const LIST_ITEM_PATTERN = /^\s*[-*]\s+(.*)$/
const ORDERED_ITEM_PATTERN = /^\s*\d+[.)]\s+(.*)$/
const QUOTE_PATTERN = /^\s*>\s?(.*)$/

/**
 * One inline pass: `code`, **strong**, *em* and [text](url). Each branch
 * emits elements whose children are plain strings, so HTML inside the source
 * renders as text.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)\s]*)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const key = `${keyPrefix}-i${index++}`
    if (match[1] !== undefined) {
      nodes.push(
        <code key={key} className="rounded-[4px] bg-foreground/5 px-[4px] py-[1px] font-mono text-[90%]">
          {match[1].slice(1, -1)}
        </code>,
      )
    } else if (match[2] !== undefined) {
      nodes.push(<strong key={key} className="font-bold">{match[2].slice(2, -2)}</strong>)
    } else if (match[3] !== undefined) {
      nodes.push(<em key={key}>{match[3].slice(1, -1)}</em>)
    } else if (match[4] !== undefined) {
      // Non-navigable by contract: the href never reaches the DOM, the URL
      // survives as the tooltip so the reader can still see the target.
      nodes.push(
        <span key={key} className="text-accent underline underline-offset-2" title={match[6]}>
          {match[5]}
        </span>,
      )
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/**
 * Renders the Markdown subset (headings, lists, quotes, fenced code, rules,
 * paragraphs + inline styles) as React nodes. Blank-line separated blocks
 * only — no setext headings, no tables.
 */
export function renderKbMarkdown(source: string): ReactNode {
  const lines = String(source).split(/\r?\n/)
  const out: ReactNode[] = []
  let paragraph: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []
  let fence: { info: string; body: string[] } | null = null
  let key = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    out.push(<p key={`b${key++}`} className="my-[0.5em]">{renderInline(paragraph.join(' '), `p${key}`)}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item, i) => <li key={`li${i}`} className="my-[0.2em]">{renderInline(item, `l${key}-${i}`)}</li>)
    out.push(list.kind === 'ul'
      ? <ul key={`b${key++}`} className="my-[0.5em] list-disc pl-[1.4em]">{items}</ul>
      : <ol key={`b${key++}`} className="my-[0.5em] list-decimal pl-[1.4em]">{items}</ol>)
    list = null
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    out.push(
      <blockquote key={`b${key++}`} className="my-[0.6em] border-l-[3px] border-foreground/10 py-[2px] pl-[12px] text-foreground-60">
        {renderInline(quote.join(' '), `q${key}`)}
      </blockquote>,
    )
    quote = []
  }
  const flushAll = () => { flushParagraph(); flushList(); flushQuote() }

  for (const line of lines) {
    if (fence !== null) {
      const closing = line.match(FENCE_PATTERN)
      if (closing) {
        out.push(
          <pre key={`b${key++}`} className="my-[0.6em] overflow-auto rounded-[8px] bg-surface-strong px-[13px] py-[11px] font-mono text-[12px] leading-[1.6] text-foreground-80">
            <code>{fence.body.join('\n')}</code>
          </pre>,
        )
        fence = null
      } else {
        fence.body.push(line)
      }
      continue
    }
    const fenceOpen = line.match(FENCE_PATTERN)
    if (fenceOpen) {
      flushAll()
      fence = { info: fenceOpen[1], body: [] }
      continue
    }
    if (/^\s*$/.test(line)) {
      flushAll()
      continue
    }
    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      flushAll()
      const level = heading[1].length as 1 | 2 | 3
      const content = renderInline(heading[2], `h${key}`)
      const className = level === 1
        ? 'my-[0.9em] mb-[0.4em] mt-[0.1em] text-[1.35em] font-bold leading-[1.35]'
        : level === 2
          ? 'my-[0.9em] mb-[0.4em] mt-[0.1em] text-[1.18em] font-bold leading-[1.35]'
          : 'my-[0.9em] mb-[0.4em] mt-[0.1em] text-[1.05em] font-bold leading-[1.35]'
      out.push(level === 1
        ? <h1 key={`b${key++}`} className={className}>{content}</h1>
        : level === 2
          ? <h2 key={`b${key++}`} className={className}>{content}</h2>
          : <h3 key={`b${key++}`} className={className}>{content}</h3>)
      continue
    }
    if (HR_PATTERN.test(line)) {
      flushAll()
      out.push(<hr key={`b${key++}`} className="my-[1em] border-0 border-t border-border" />)
      continue
    }
    const quoted = line.match(QUOTE_PATTERN)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }
    const bullet = line.match(LIST_ITEM_PATTERN)
    if (bullet) {
      flushParagraph()
      if (list && list.kind !== 'ul') flushList()
      list = list ?? { kind: 'ul', items: [] }
      list.items.push(bullet[1])
      continue
    }
    const ordered = line.match(ORDERED_ITEM_PATTERN)
    if (ordered) {
      flushParagraph()
      if (list && list.kind !== 'ol') flushList()
      list = list ?? { kind: 'ol', items: [] }
      list.items.push(ordered[1])
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }
  if (fence !== null) {
    // An unclosed fence still renders its body — content beats formatting.
    out.push(
      <pre key={`b${key++}`} className="my-[0.6em] overflow-auto rounded-[8px] bg-surface-strong px-[13px] py-[11px] font-mono text-[12px] leading-[1.6] text-foreground-80">
        <code>{fence.body.join('\n')}</code>
      </pre>,
    )
  }
  flushAll()
  return <div className="text-[13px] leading-[1.7] text-foreground-80">{out}</div>
}
