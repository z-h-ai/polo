import { describe, expect, it, mock } from 'bun:test'

// Review #2: keyboard focus must stay visible app-wide. These assertions read
// the real stylesheet source so a regression back to `*:focus-visible{outline:none}`
// fails in CI instead of only in manual Tab-walking.

mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const indexCss = (await import('../index.css?raw')).default
const base = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css?raw')).default
const review = (await import('../../../../../.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css?raw')).default
const { createClientWorkbenchStyle } = await import('../lib/client-workbench-style')
const { clientWorkbenchFocusClassName } = await import('../components/ui/client-workbench')

describe('global focus-visible baseline', () => {
  it('no longer clears the keyboard focus outline globally', () => {
    expect(indexCss).not.toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*none/)
  })

  it('keeps the accent focus-visible base rule from the workbench focus frame', () => {
    expect(indexCss).toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent\)[^}]*\}/)
  })

  it('still binds the tailwind ring variables on the focus-visible base rule', () => {
    const rule = indexCss.match(/\*:focus-visible\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('--tw-ring-color: var(--ring)')
    expect(rule).toContain('--tw-ring-width: var(--ring-width)')
  })

  it('top bar buttons no longer suppress the focus ring', async () => {
    const topBarButton = (await import('../components/ui/TopBarButton.tsx?raw')).default
    expect(topBarButton).not.toContain('focus-visible:ring-0')
    expect(topBarButton).not.toContain('focus:outline-none')
  })
})

describe('workbench token pipeline keeps the focus rules', () => {
  it('extracts the workbench focus outline into the adapter output', () => {
    const style = createClientWorkbenchStyle(base, review)
    expect(style['--client-workbench-focus-outline']).toBe('2px solid var(--accent)')
    expect(style['--client-workbench-focus-offset']).toBe('3px')
  })

  it('focus class name consumes exactly the extracted adapter variables', () => {
    const style = createClientWorkbenchStyle(base, review)
    for (const match of clientWorkbenchFocusClassName.matchAll(/var\((--[\w-]+)\)/g)) {
      expect(style).toHaveProperty(match[1]!)
    }
  })
})
