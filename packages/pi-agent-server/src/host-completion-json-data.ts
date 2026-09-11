import { types } from 'node:util'
// Single responsibility: bounded, descriptor-safe reading of inert JSON-data shapes and bounded
// structural comparison. This kernel never applies Host policy (512KiB, slots, claims, tool
// max-or-double); it returns structured outcomes and explicit comparison reasons (R12 §6.2).

export interface ComparisonBudget {
  pairs: number
  dead: boolean
  outcome: JsonComparisonOutcome | null
}
export type JsonComparisonOutcome = 'equal' | 'different' | 'unsafe_shape' | 'pair_budget_exhausted' | 'key_budget_exhausted' | 'depth_exhausted'
export type OwnDataRead = { kind: 'data'; value: unknown } | { kind: 'missing' } | { kind: 'unsafe' }

// Comparison boundaries (R12 §6.6): the root pair sits at depth 0 and consumes pair unit 1; every
// visited child pair charges exactly one unit before its values are read (8192 allowed, the 8193rd
// latches pair_budget_exhausted). Each side of a plain-object pair captures at most 8192 key
// records; the 8193rd key latches key_budget_exhausted before its descriptor is inspected. Depth 16
// is allowed, entering depth 17 latches depth_exhausted without reading the value. Maps match by
// key name and size, so insertion order never affects equality. The first non-equal outcome or any
// budget/shape latch stops all further descriptor, value and pair access.
const COMPARISON_PAIR_BUDGET = 8192
const COMPARISON_KEY_RECORD_BUDGET = 8192
const COMPARISON_DEPTH_LIMIT = 16

// Proxy-first gate: util.types.isProxy runs before any getPrototypeOf/enumeration/descriptor trap;
// only plain objects (prototype Object.prototype or null) are inert JSON-data objects.
export function isInertJsonDataObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
// Proxy arrays pass Array.isArray, so every array path re-checks isProxy before length/index reads.
export function isInertJsonDataArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && !types.isProxy(value)
}
// Fixed-field read: own data descriptor only. Missing stays distinguishable; accessor, missing
// backing or descriptor exceptions are unsafe and never invoke a getter (R12 §6.2 rule 3).
export function readOwnDescriptor(source: object, key: string): OwnDataRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return { kind: 'missing' }
    if (descriptor.get !== undefined || descriptor.set !== undefined) return { kind: 'unsafe' }
    return { kind: 'data', value: descriptor.value }
  } catch {
    return { kind: 'unsafe' }
  }
}
// Array length is read through its own data descriptor — never through the `length` property get,
// which a Proxy array or accessor would intercept (R12 §6.2 rule 6).
export function readArrayLength(array: unknown[]): number | null {
  const descriptor = readOwnDescriptor(array, 'length')
  if (descriptor.kind !== 'data') return null
  if (typeof descriptor.value !== 'number' || !Number.isInteger(descriptor.value) || descriptor.value < 0) return null
  return descriptor.value
}
// Array elements use their own descriptor: holes stay distinguishable from undefined data and
// accessor indexes are unsafe; prototype values are never read (R12 §6.2 rule 7).
export function readArrayElement(array: unknown[], index: number): OwnDataRead {
  return readOwnDescriptor(array, String(index))
}
// Streaming own-enumerable string-key projection: no key-array materialization. chargeKey runs
// after Object.hasOwn and BEFORE the descriptor is read so budget latches stop pre-read; an unsafe
// or missing descriptor latches through `latch` without ever invoking a getter. Symbols and
// non-enumerable fields stay outside the JSON-data domain (R12 §6.2 rules 4/5/10).
export function* forEachOwnEnumerableDataProperty(source: object, chargeKey: () => boolean, latch: () => void): Generator<[string, unknown]> {
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue
    if (!chargeKey()) return latch()
    const descriptor = readOwnDescriptor(source, key)
    if (descriptor.kind !== 'data') return latch()
    yield [key, descriptor.value]
  }
}
export function createComparisonBudget(): ComparisonBudget {
  return { pairs: 0, dead: false, outcome: null }
}
function latchComparison(budget: ComparisonBudget, outcome: JsonComparisonOutcome): JsonComparisonOutcome {
  budget.dead = true
  budget.outcome = outcome
  return outcome
}
function captureKeyRecords(source: object, budget: ComparisonBudget): Map<string, unknown> {
  const records = new Map<string, unknown>()
  let discovered = 0
  for (const [key, value] of forEachOwnEnumerableDataProperty(source, () => {
    discovered += 1
    if (discovered > COMPARISON_KEY_RECORD_BUDGET) {
      budget.dead = true
      budget.outcome = 'key_budget_exhausted'
    }
    return !budget.dead
  }, () => {
    if (budget.outcome === null) budget.outcome = 'unsafe_shape'
    budget.dead = true
  })) {
    if (budget.dead) return records
    records.set(key, value)
  }
  return records
}
export function compareJsonData(left: unknown, right: unknown, depth: number, budget: ComparisonBudget): JsonComparisonOutcome {
  if (budget.dead) return budget.outcome ?? 'unsafe_shape'
  budget.pairs += 1
  if (budget.pairs > COMPARISON_PAIR_BUDGET) return latchComparison(budget, 'pair_budget_exhausted')
  if (depth > COMPARISON_DEPTH_LIMIT) return latchComparison(budget, 'depth_exhausted')
  if (left === right) return 'equal'
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return 'different'
    if (!isInertJsonDataArray(left) || !isInertJsonDataArray(right)) return latchComparison(budget, 'unsafe_shape')
    const leftLength = readArrayLength(left)
    const rightLength = readArrayLength(right)
    if (leftLength === null || rightLength === null) return latchComparison(budget, 'unsafe_shape')
    if (leftLength !== rightLength) return 'different'
    for (let index = 0; index < leftLength; index++) {
      const leftElement = readArrayElement(left, index)
      const rightElement = readArrayElement(right, index)
      if (leftElement.kind !== 'data' || rightElement.kind !== 'data') return latchComparison(budget, 'unsafe_shape')
      const outcome = compareJsonData(leftElement.value, rightElement.value, depth + 1, budget)
      if (outcome !== 'equal') return outcome
    }
    return 'equal'
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return 'different'
  if (!isInertJsonDataObject(left) || !isInertJsonDataObject(right)) return latchComparison(budget, 'unsafe_shape')
  const leftRecords = captureKeyRecords(left, budget)
  if (budget.dead) return budget.outcome ?? 'unsafe_shape'
  const rightRecords = captureKeyRecords(right, budget)
  if (budget.dead) return budget.outcome ?? 'unsafe_shape'
  if (leftRecords.size !== rightRecords.size) return 'different'
  for (const [key, leftValue] of leftRecords) {
    if (!rightRecords.has(key)) return 'different'
    const outcome = compareJsonData(leftValue, rightRecords.get(key), depth + 1, budget)
    if (outcome !== 'equal') return outcome
  }
  return 'equal'
}
