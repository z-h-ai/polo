import { getCatalog, queryOptions } from './query.js'
import { getSnapshot, navigate, reset, subscribe } from './state.js'

export function installPrototypeRuntime() {
  if (window.PrototypeRuntime) return window.PrototypeRuntime
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  const runtime = {
    config: getCatalog(),
    ready,
    getSnapshot,
    listScenes: () => queryOptions(),
    navigate,
    reset,
    subscribe,
  }
  window.PrototypeRuntime = Object.freeze(runtime)
  queueMicrotask(resolveReady)
  return runtime
}
