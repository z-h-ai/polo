import { readQuery, writeQuery, normalizeQuery } from './query.js'

let snapshot = readQuery()
const listeners = new Set()
const notify = () => listeners.forEach((listener) => listener())

export function getSnapshot() { return snapshot }
export function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
export function navigate(next, options = {}) {
  snapshot = writeQuery({ ...snapshot, ...next }, options)
  notify()
  return snapshot
}
export function reset() {
  snapshot = writeQuery(normalizeQuery({}))
  notify()
  return snapshot
}

window.addEventListener('popstate', () => {
  snapshot = readQuery()
  notify()
})
