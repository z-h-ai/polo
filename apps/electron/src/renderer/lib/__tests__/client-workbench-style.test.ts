import { describe, expect, it, mock } from 'bun:test'

// The Vite-only theme loader is outside this CSS adapter contract.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const { createClientWorkbenchStyle } = await import('../client-workbench-style')
const base = (await import('../../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css?raw')).default
const review = (await import('../../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw')).default

describe('canonical workbench CSS consumption', () => {
  it('loads actual raw source strings and retains the final review declaration without a semicolon', () => {
    expect(typeof base).toBe('string')
    expect(typeof review).toBe('string')
    const style = createClientWorkbenchStyle(base, review)
    expect(style['--wb-line']).toBe('var(--border)')
    expect(style['--background']).toBe('#fbfbfa')
    expect(style.fontFamily).toStartWith('system-ui,')
    expect(style['--font-sans']).toBe(String(style.fontFamily))
    expect(style['--client-workbench-focus-outline']).toBe('2px solid var(--accent)')
    expect(style['--client-workbench-focus-offset']).toBe('3px')
  })

  it('follows base then review cascade and rebinds derived aliases in the consumer scope', () => {
    const style = createClientWorkbenchStyle(base, review + '\n:root{--accent:#123456;--surface:#eeeeee;--final:inherit}')
    expect(style['--accent']).toBe('#123456')
    expect(style['--surface']).toBe('#eeeeee')
    expect(style['--final']).toBe('inherit')
    expect(style['--popover']).toBe('var(--surface)')
    expect(style['--primary']).toBe('var(--accent)')
    expect(style['--ring']).toBe('var(--accent)')
    expect(style['--muted-foreground']).toBe('var(--fg-50)')
    expect(style['--foreground-50']).toBe('var(--fg-50)')
    expect(style['--shadow-xs']).toBe('var(--shadow-minimal)')
    expect(style['--shadow-modal-small']).toBe('var(--shadow-panel)')
  })

  it('fails visibly if the owned source contract loses required font or surface declarations', () => {
    expect(() => createClientWorkbenchStyle(base.replace('font-family:', 'removed-font:'), review)).toThrow('font-family')
    expect(() => createClientWorkbenchStyle(base.replace('--surface: #ffffff;', ''), review)).toThrow('Incomplete')
  })
})
