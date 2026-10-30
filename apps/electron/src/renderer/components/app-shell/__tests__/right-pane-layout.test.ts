import { expect, it } from 'bun:test'
import { shouldAutoHideNavigation } from '../right-pane-layout'
it('920px retains chat and resource by collapsing navigation before single-panel mode', () => {
  expect(shouldAutoHideNavigation(920, 520, .45)).toBe(true)
  expect(920 * (1 - .45)).toBeGreaterThanOrEqual(360)
})
it('keeps expanded navigation when chat has room and does not compact an unmeasured shell', () => {
  expect(shouldAutoHideNavigation(1600, 520, .45)).toBe(false)
  expect(shouldAutoHideNavigation(920, 520, 0)).toBe(false)
  expect(shouldAutoHideNavigation(0, 520, .45)).toBe(false)
})
