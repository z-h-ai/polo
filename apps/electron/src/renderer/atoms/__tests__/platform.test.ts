/**
 * Tests for the platformModeAtom.
 *
 * AC3: platformMode flag is propagated through React context or global state
 * - TEST: Components conditionally render based on this flag
 */
import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  platformModeAtom,
  setPlatformModeAtom,
} from '../platform'

describe('platformModeAtom', () => {
  it('defaults to false (hidden during loading — safe default)', () => {
    const store = createStore()
    expect(store.get(platformModeAtom)).toBe(false)
  })

  it('can be set to true via setPlatformModeAtom', () => {
    const store = createStore()
    store.set(setPlatformModeAtom, true)
    expect(store.get(platformModeAtom)).toBe(true)
  })

  it('can be set to false via setPlatformModeAtom', () => {
    const store = createStore()
    store.set(setPlatformModeAtom, true)
    store.set(setPlatformModeAtom, false)
    expect(store.get(platformModeAtom)).toBe(false)
  })

  it('is isolated across stores (no global state leakage)', () => {
    const store1 = createStore()
    const store2 = createStore()

    store1.set(setPlatformModeAtom, true)

    // store2 should not be affected
    expect(store2.get(platformModeAtom)).toBe(false)
  })
})
