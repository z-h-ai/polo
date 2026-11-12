import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * POO-207 — the enterprise project tab's sidebar collapse default, as a
 * pure hook contract:
 *
 * - entering an enterprise project tab flips the override to `false`
 *   (collapsed) — on mount with the tab already active too (session restore);
 * - the override NEVER leaves `null` while no project tab is active, so the
 *   persisted workspace preference rules every other surface;
 * - re-entering a project (another project tab's id included) collapses
 *   again — a manual open on project A must not leak into project B;
 * - leaving to a non-project tab clears the override (pre-entry visibility
 *   returns), and the caller's manual toggle rides the override.
 */

GlobalRegistrator.register()

const { cleanup, renderHook, act } = await import('@testing-library/react')
const { useProjectTabSidebarCollapse } = await import('../useProjectTabSidebarCollapse')

/** The hook's prop shape, named so every renderHook call pins the same
 * generic (inference from initialProps alone narrows `id` too far). */
interface HookProps { tab: boolean; id: string | null }
const underTest = ({ tab, id }: HookProps) => useProjectTabSidebarCollapse(tab, id)

afterEach(cleanup)

describe('useProjectTabSidebarCollapse (POO-207)', () => {
  it('a non-project tab keeps the override at null — the persisted preference rules', () => {
    const { result } = renderHook(() => useProjectTabSidebarCollapse(false, null))
    expect(result.current[0]).toBeNull()
  })

  it('entering a project tab collapses (mount-active included, session restore)', () => {
    const mountedActive = renderHook(() => useProjectTabSidebarCollapse(true, 'pj-1'))
    expect(mountedActive.result.current[0]).toBe(false)
    cleanup()

    const enteredLater = renderHook(underTest, { initialProps: { tab: false, id: null } as HookProps })
    expect(enteredLater.result.current[0]).toBeNull()
    enteredLater.rerender({ tab: true, id: 'pj-1' })
    expect(enteredLater.result.current[0]).toBe(false)
  })

  it('project → project collapses again: a manual open on A never leaks into B', () => {
    const { result, rerender } = renderHook(underTest, {
      initialProps: { tab: true, id: 'pj-1' },
    })
    // The user re-opened the sidebar on project A — the override carries it.
    act(() => { result.current[1](true) })
    expect(result.current[0]).toBe(true)
    // Entering project B defaults collapsed again.
    rerender({ tab: true, id: 'pj-2' })
    expect(result.current[0]).toBe(false)
  })

  it('same-tab re-renders keep the user\'s in-visit choice; leaving clears the override', () => {
    const { result, rerender } = renderHook(underTest, {
      initialProps: { tab: true, id: 'pj-1' } as HookProps,
    })
    act(() => { result.current[1](true) })
    // Parent re-renders (roster refresh, store updates) must not reset it.
    rerender({ tab: true, id: 'pj-1' })
    expect(result.current[0]).toBe(true)
    // Back to the home tab: null — the pre-entry persisted preference rules.
    rerender({ tab: false, id: null })
    expect(result.current[0]).toBeNull()
  })
})
