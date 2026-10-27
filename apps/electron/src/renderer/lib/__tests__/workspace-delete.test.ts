import { describe, expect, test } from 'bun:test'
import { presentWorkspaceRemoval } from '../workspace-delete'

// U1 (product-closure 2026-10-27) — the removal AFTER speaks honestly in all
// three worlds: clean success, another window won the race, and the partial
// failure where the config entry is gone but the on-disk data survived.

describe('presentWorkspaceRemoval (U1 honesty matrix)', () => {
  test('clean success toasts the existing removed copy', () => {
    const p = presentWorkspaceRemoval('Acme', { removed: true })
    expect(p.toast).toBe('success')
    expect(p.messageKey).toBe('toast.removedWorkspace')
    expect(p.params).toEqual({ name: 'Acme' })
    expect(p.refreshList).toBe(true)
  })

  test('already-gone (another window) is an ERROR, never success-shaped, and refreshes the list', () => {
    const p = presentWorkspaceRemoval('Acme', { removed: false })
    expect(p.toast).toBe('error')
    expect(p.messageKey).toBe('workspaceDelete.alreadyGone')
    expect(p.refreshList).toBe(true)
  })

  test('data cleanup failure is an ERROR naming the surviving path', () => {
    const p = presentWorkspaceRemoval('Acme', {
      removed: true,
      dataCleanupFailure: { path: '/data/Acme', message: 'EBUSY: resource busy' },
    })
    expect(p.toast).toBe('error')
    expect(p.messageKey).toBe('workspaceDelete.dataCleanupFailed')
    expect(p.params).toEqual({ path: '/data/Acme' })
    // The config entry IS gone — the stale row must leave the list either way.
    expect(p.refreshList).toBe(true)
  })
})
