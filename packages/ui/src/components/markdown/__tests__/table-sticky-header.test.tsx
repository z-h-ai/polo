import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// DOM/interaction regression only. Sticky geometry needs the real browser
// checks in TABLE-01/02; happy-dom does not implement layout or scrolling.
GlobalRegistrator.register()
// Vite resolves this asset URL in the renderer. Bun has no ?url loader; no
// PDF is rendered by these cases, so replace only that unrelated asset import.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.min.mjs' }))
const { Markdown } = await import('../Markdown')
const { MarkdownDatatableBlock } = await import('../MarkdownDatatableBlock')

const columns = Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, label: `Column ${i + 1}` }))
const rows = Array.from({ length: 100 }, (_, i) => Object.fromEntries(columns.map(c => [c.key, `Row ${i + 1}`])))
const markdown = (count: number) => [
  `| ${columns.map(c => c.label).join(' | ')} |`,
  `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows.slice(0, count).map(row => `| ${columns.map(c => row[c.key]).join(' | ')} |`),
].join('\n')

let host: HTMLDivElement
let root: Root
beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})
afterAll(async () => {
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

function render(content: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(content))
}

function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('message table scroll structure', () => {
  for (const mode of ['terminal', 'minimal', 'full'] as const) {
    it(`${mode}: gives a long table one bounded scroll host and one native header`, () => {
      render(<Markdown mode={mode}>{markdown(100)}</Markdown>)
      const table = host.querySelector('table')!
      const scroll = table.parentElement!
      expect(scroll.classList.contains('overflow-auto')).toBe(true)
      expect(scroll.classList.contains('max-h-[400px]')).toBe(true)
      expect(host.querySelectorAll('thead')).toHaveLength(1)
      expect(table.querySelectorAll('tbody tr')).toHaveLength(100)
      for (const header of table.querySelectorAll('th')) {
        expect(header.classList.contains('sticky')).toBe(true)
        expect(header.classList.contains('top-0')).toBe(true)
        expect(header.classList.contains('bg-background')).toBe(true)
      }
    })

    it(`${mode}: short tables keep natural height`, () => {
      render(<Markdown mode={mode}>{markdown(2)}</Markdown>)
      const table = host.querySelector('table')!
      expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
      const scroll = table.parentElement!
      expect(scroll.className).not.toMatch(/(?:^|\s)(?:h-|min-h-)/)
      expect(scroll.style.height).toBe('')
    })
  }

  it('datatable: keeps sorting, filters and row actions reachable under sticky headers', () => {
    const dispatched: string[] = []
    render(<MarkdownDatatableBlock
      code={JSON.stringify({ columns: [{ key: 'region', label: 'Region' }], rows: [{ region: 'EMEA' }, { region: 'APAC' }] })}
      enableColumnFilters
      renderRowAction={row => <button onClick={() => dispatched.push(String(row.region))}>Follow up</button>}
    />)
    const table = host.querySelector('table')!
    expect(table.parentElement!.classList.contains('max-h-[400px]')).toBe(true)
    for (const header of table.querySelectorAll('th')) {
      expect(header.classList.contains('sticky')).toBe(true)
      expect(header.classList.contains('bg-background')).toBe(true)
    }
    expect(table.querySelectorAll('th')).toHaveLength(2)
    click(table.querySelector('th'))
    expect(table.querySelector('tbody tr td')!.textContent).toBe('APAC')
    click([...table.querySelectorAll('th button')].find(b => b.textContent === 'EMEA')!)
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1)
    click(table.querySelector('tbody button'))
    expect(dispatched).toEqual(['EMEA'])
  })

  it('expanded datatable: lets the overlay scroll both axes without an intervening scroll host', () => {
    render(<MarkdownDatatableBlock code={JSON.stringify({ columns, rows })} />)
    // The native expand button is the only direct button outside the controls.
    click(host.querySelector('button:has(svg.lucide-maximize2)'))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    const table = dialog.querySelector('table')!
    let ancestor = table.parentElement!
    while (!(ancestor.classList.contains('h-full') && ancestor.classList.contains('overflow-y-auto'))) {
      expect(ancestor.className).not.toMatch(/overflow-(?:auto|hidden|scroll|x-auto)/)
      ancestor = ancestor.parentElement!
      expect(ancestor).not.toBeNull()
    }
    // The fullscreen overlay has a floating header and a fade inset. A sticky
    // table must clear those, rather than disappearing behind the header.
    const inset = (dialog.querySelector('[style*="--table-sticky-top"]') as HTMLElement)
      .style.getPropertyValue('--table-sticky-top')
    expect(inset).toBe(ancestor.style.scrollPaddingTop)
    expect(table.querySelectorAll('thead')).toHaveLength(1)
    expect(table.querySelectorAll('tbody tr')).toHaveLength(100)
  })
})
