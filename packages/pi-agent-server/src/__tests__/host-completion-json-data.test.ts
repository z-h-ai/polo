import { describe, expect, it } from 'bun:test'
import { compareJsonData, createComparisonBudget, forEachOwnEnumerableDataProperty, isInertJsonDataArray, isInertJsonDataObject, readArrayElement, readArrayLength, readOwnDescriptor } from '../host-completion-json-data.ts'

function countingProxy(target: object, counters: Record<string, number>): object {
  return new Proxy(target, {
    get: (t, key) => { counters.get += 1; return Reflect.get(t, key) },
    has: (t, key) => { counters.has += 1; return Reflect.has(t, key) },
    getPrototypeOf: (t) => { counters.getPrototypeOf += 1; return Object.getPrototypeOf(t) },
    ownKeys: (t) => { counters.ownKeys += 1; return Reflect.ownKeys(t) },
    getOwnPropertyDescriptor: (t, key) => { counters.getOwnPropertyDescriptor += 1; return Reflect.getOwnPropertyDescriptor(t, key) },
  })
}
describe('inert JSON-data gates', () => {
  it('accepts plain and null-prototype objects and rejects Proxies before any trap', () => {
    const counters: Record<string, number> = { get: 0, has: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 }
    expect(isInertJsonDataObject({ a: 1 })).toBe(true)
    expect(isInertJsonDataObject(Object.create(null))).toBe(true)
    expect(isInertJsonDataObject(class Foo {})).toBe(false)
    expect(isInertJsonDataObject([])).toBe(false)
    const proxy = countingProxy({ a: 1 }, counters)
    expect(isInertJsonDataObject(proxy)).toBe(false)
    expect(isInertJsonDataArray([1, 2])).toBe(true)
    const arrayProxy = countingProxy([1, 2], counters)
    expect(isInertJsonDataArray(arrayProxy)).toBe(false)
    expect(isInertJsonDataArray('not-array')).toBe(false)
    expect(counters.get).toBe(0)
    expect(counters.has).toBe(0)
    expect(counters.getPrototypeOf).toBe(0)
    expect(counters.ownKeys).toBe(0)
    expect(counters.getOwnPropertyDescriptor).toBe(0)
  })
  it('reads own data descriptors and keeps missing, accessor and exception shapes apart', () => {
    const source: Record<string, unknown> = { data: 5, holeless: undefined }
    expect(readOwnDescriptor(source, 'data')).toEqual({ kind: 'data', value: 5 })
    expect(readOwnDescriptor(source, 'absent')).toEqual({ kind: 'missing' })
    Object.defineProperty(source, 'accessor', { get() { return 1 }, enumerable: true })
    expect(readOwnDescriptor(source, 'accessor')).toEqual({ kind: 'unsafe' })
    const sourceWithProto = Object.create({ inherited: 7 }) as Record<string, unknown>
    expect(readOwnDescriptor(sourceWithProto, 'inherited')).toEqual({ kind: 'missing' })
  })
  it('reads array length and elements through own descriptors and distinguishes holes', () => {
    const array = [1, , 3] as unknown[]
    expect(readArrayLength(array)).toBe(3)
    expect(readArrayElement(array, 0)).toEqual({ kind: 'data', value: 1 })
    expect(readArrayElement(array, 1)).toEqual({ kind: 'missing' })
    const accessorArray: unknown[] = [1]
    Object.defineProperty(accessorArray, 1, { get() { return 2 }, enumerable: true })
    expect(readArrayElement(accessorArray, 1)).toEqual({ kind: 'unsafe' })
  })
  it('streams only own enumerable string keys, charges before descriptor reads, and never calls getters', () => {
    let getterCalls = 0
    let charged = 0
    const source: Record<string, unknown> = { first: 1, second: 2, accessor: 0 }
    source.accessor = 0
    Object.defineProperty(source, 'accessor', { get() { getterCalls += 1; return 3 }, enumerable: true })
    Object.defineProperty(source, 'hidden', { value: 4, enumerable: false })
    const proto = { protoKey: 9 }
    Object.setPrototypeOf(source, proto)
    // An accessor fails the whole projection closed: enumeration stops there, the getter is never
    // invoked, and the key still cost one charge before its descriptor was inspected.
    const seen: Array<[string, unknown]> = []
    let latched = false
    for (const [key, value] of forEachOwnEnumerableDataProperty(source, () => {
      charged += 1
      return true
    }, () => {
      latched = true
    })) {
      seen.push([key, value])
    }
    expect(seen).toEqual([['first', 1], ['second', 2]])
    expect(charged).toBe(3)
    expect(latched).toBe(true)
    expect(getterCalls).toBe(0)
  })
  it('latches through the charge callback before the descriptor is read', () => {
    let descriptorReads = 0
    const source: Record<string, unknown> = { a: 1 }
    const original = Object.getOwnPropertyDescriptor
    ;(Object as { getOwnPropertyDescriptor: unknown }).getOwnPropertyDescriptor = (...args: unknown[]) => {
      descriptorReads += 1
      return (original as (...args: unknown[]) => PropertyDescriptor | undefined)(...(args as [object, string]))
    }
    try {
      const seen: string[] = []
      for (const [key] of forEachOwnEnumerableDataProperty(source, () => false, () => undefined)) seen.push(key)
      expect(seen).toEqual([])
      expect(descriptorReads).toBe(0)
    } finally {
      ;(Object as { getOwnPropertyDescriptor: unknown }).getOwnPropertyDescriptor = original
    }
  })
})
describe('bounded structural comparison', () => {
  it('returns equal for identical inert shapes regardless of key insertion order', () => {
    const budget = createComparisonBudget()
    expect(compareJsonData({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, 0, budget)).toBe('equal')
    expect(budget.dead).toBe(false)
  })
  it('returns different for value, size and key-set mismatches', () => {
    expect(compareJsonData(1, 2, 0, createComparisonBudget())).toBe('different')
    expect(compareJsonData({ a: 1 }, { a: 2 }, 0, createComparisonBudget())).toBe('different')
    expect(compareJsonData([1], [1, 2], 0, createComparisonBudget())).toBe('different')
    expect(compareJsonData({ a: 1 }, { b: 1 }, 0, createComparisonBudget())).toBe('different')
    expect(compareJsonData({ a: 1 }, { a: 1, b: 2 }, 0, createComparisonBudget())).toBe('different')
  })
  it('classifies Proxies, accessors, holes and non-plain objects as unsafe_shape with zero traps or getters', () => {
    const counters: Record<string, number> = { get: 0, has: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 }
    const proxy = countingProxy({ a: 1 }, counters)
    expect(compareJsonData(proxy, { a: 1 }, 0, createComparisonBudget())).toBe('unsafe_shape')
    expect(counters.get).toBe(0)
    expect(counters.has).toBe(0)
    expect(counters.getPrototypeOf).toBe(0)
    expect(counters.ownKeys).toBe(0)
    expect(counters.getOwnPropertyDescriptor).toBe(0)
    let getterCalls = 0
    const accessorSource: Record<string, unknown> = { a: 1 }
    Object.defineProperty(accessorSource, 'b', { get() { getterCalls += 1; return 2 }, enumerable: true })
    expect(compareJsonData(accessorSource, { a: 1, b: 2 }, 0, createComparisonBudget())).toBe('unsafe_shape')
    expect(getterCalls).toBe(0)
    const holed: unknown[] = [1]
    holed.length = 2
    expect(compareJsonData(holed, [1, undefined], 0, createComparisonBudget())).toBe('unsafe_shape')
    class Foo {}
    expect(compareJsonData(new Foo(), { a: 1 }, 0, createComparisonBudget())).toBe('unsafe_shape')
  })
  it('allows exactly 8192 pairs and latches pair_budget_exhausted on the 8193rd', () => {
    const atLimit = createComparisonBudget()
    const leftAt = Array.from({ length: 8191 }, (_, i) => i)
    expect(compareJsonData(leftAt, [...leftAt], 0, atLimit)).toBe('equal')
    expect(atLimit.pairs).toBe(8192)
    const over = createComparisonBudget()
    const leftOver = Array.from({ length: 8192 }, (_, i) => i)
    expect(compareJsonData(leftOver, [...leftOver], 0, over)).toBe('pair_budget_exhausted')
    expect(over.dead).toBe(true)
  })
  it('stops huge declared sparse arrays with bounded work instead of looping the declared length', () => {
    const huge = new Array(10_000_000) as unknown[]
    huge[0] = 1
    huge[1] = 2
    const budget = createComparisonBudget()
    expect(compareJsonData(huge, [...huge], 0, budget)).toBe('unsafe_shape')
    expect(budget.pairs).toBeLessThan(8193)
  })
  it('completes 8192-key projection and separates key_budget_exhausted from pair exhaustion', () => {
    const build = (count: number): Record<string, number> => {
      const out: Record<string, number> = {}
      for (let i = 0; i < count; i++) out[`k${i}`] = i
      return out
    }
    // 8192 key records per side complete projection; the child pairs then exhaust the pair budget.
    const recordsComplete = createComparisonBudget()
    expect(compareJsonData(build(8192), build(8192), 0, recordsComplete)).toBe('pair_budget_exhausted')
    // The 8193rd key latches key_budget_exhausted during projection, before its descriptor read.
    const keyLatch = createComparisonBudget()
    expect(compareJsonData(build(8193), build(8193), 0, keyLatch)).toBe('key_budget_exhausted')
    expect(keyLatch.dead).toBe(true)
  })
  it('allows depth 16 and latches depth_exhausted when entering depth 17', () => {
    const nested = (levels: number): unknown => {
      let inner: unknown = 'leaf'
      for (let i = 0; i < levels; i++) inner = { nested: inner }
      return inner
    }
    const allowed = createComparisonBudget()
    expect(compareJsonData(nested(16), nested(16), 0, allowed)).toBe('equal')
    expect(allowed.pairs).toBe(17)
    const latched = createComparisonBudget()
    expect(compareJsonData(nested(17), nested(17), 0, latched)).toBe('depth_exhausted')
    expect(latched.dead).toBe(true)
  })
  it('gates identical and accessor arrays through unsafe_shape instead of the equality fast path', () => {
    const counters: Record<string, number> = { get: 0, has: 0, getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 }
    const proxy = countingProxy({ a: 1 }, counters)
    // The same Proxy object would satisfy `left === right`; the plain-shape gate must still win.
    expect(compareJsonData(proxy, proxy, 0, createComparisonBudget())).toBe('unsafe_shape')
    expect(counters.get).toBe(0)
    expect(counters.has).toBe(0)
    expect(counters.getPrototypeOf).toBe(0)
    expect(counters.ownKeys).toBe(0)
    expect(counters.getOwnPropertyDescriptor).toBe(0)
    let getterCalls = 0
    const accessorArray: unknown[] = [1]
    Object.defineProperty(accessorArray, 0, { get() { getterCalls += 1; return 1 }, enumerable: true })
    expect(compareJsonData(accessorArray, accessorArray, 0, createComparisonBudget())).toBe('unsafe_shape')
    expect(getterCalls).toBe(0)
  })
  it('pre-charges the 8193rd array pair and depth 17 before reading any boundary value', () => {
    let getterCalls = 0
    const left: unknown[] = Array.from({ length: 8192 }, (_, i) => i)
    const right: unknown[] = Array.from({ length: 8192 }, (_, i) => i)
    Object.defineProperty(right, 8191, { get() { getterCalls += 1; return 8191 }, enumerable: true })
    const budget = createComparisonBudget()
    expect(compareJsonData(left, right, 0, budget)).toBe('pair_budget_exhausted')
    expect(budget.pairs).toBe(8193)
    expect(getterCalls).toBe(0)
    // depth 17 boundary: the child pair pre-charges and latches before the accessor is read.
    const nestedArrays = (levels: number, leaf: unknown): unknown => (levels === 0 ? leaf : [nestedArrays(levels - 1, leaf)])
    const accessorLeaf: unknown[] = []
    Object.defineProperty(accessorLeaf, 0, { get() { getterCalls += 1; return 'x' }, enumerable: true })
    const depthBudget = createComparisonBudget()
    expect(compareJsonData(nestedArrays(17, accessorLeaf), nestedArrays(17, accessorLeaf), 0, depthBudget)).toBe('depth_exhausted')
    expect(getterCalls).toBe(0)
  })
  it('keeps comparison budgets isolated per reconciliation', () => {
    const first = createComparisonBudget()
    expect(compareJsonData({ a: 1 }, { a: 2 }, 0, first)).toBe('different')
    expect(first.dead).toBe(false)
    const second = createComparisonBudget()
    expect(compareJsonData({ a: 1 }, { a: 1 }, 0, second)).toBe('equal')
    expect(second.pairs).toBe(2)
  })
})
