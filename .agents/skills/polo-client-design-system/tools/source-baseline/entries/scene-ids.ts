/**
 * Scene-id extraction source of truth.
 *
 * build.py bundles THIS file with vite (SSR) and executes it under node, so
 * the manifest scene list comes from the same module evaluation the browser
 * performs — no regex guessing over source text (which silently missed the
 * quoted keys of the typed SETTINGS_PAGE_COMPONENTS registry and produced a
 * manifest that disagreed with the running page).
 *
 * The mock-utils import must stay FIRST — same contract as baseline.tsx /
 * playground.tsx: renderer modules read window.electronAPI at module load
 * (e.g. SessionFilesSection's top-level getRuntimeEnvironment), so the mock
 * must be installed before any scene dependency is evaluated. Rendering never
 * happens here; only module scope runs, under the happy-dom window provided
 * by scene-ids-runner.cjs.
 */
import '@/playground/mock-utils'
import { baselineScenes } from './scenes'

console.log(JSON.stringify(
  baselineScenes.map(s => ({ id: s.id, region: s.region, fullBleed: s.fullBleed === true })),
))
