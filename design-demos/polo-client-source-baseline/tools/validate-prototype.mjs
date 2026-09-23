import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const required = ['index.html', 'prototype-manifest.json', 'scene-catalog.json', 'SCENE-TRACEABILITY.md', 'src/main.jsx', 'src/app-shell.jsx', 'src/runtime/prototype-runtime.js', 'src/styles/tokens.css', 'tools/export-single-file.mjs']
const errors = []
const warnings = []
for (const file of required) if (!existsSync(resolve(root, file))) errors.push('missing required file: ' + file)

const manifest = JSON.parse(readFileSync(resolve(root, 'prototype-manifest.json'), 'utf8'))
const catalog = JSON.parse(readFileSync(resolve(root, 'scene-catalog.json'), 'utf8'))
if (!manifest.source?.gitRevision) errors.push('manifest.source.gitRevision is required')
if (!manifest.protocol?.query?.includes('scene')) errors.push('manifest protocol must include scene')
if (!Array.isArray(catalog.scenes) || catalog.scenes.length < 10) errors.push('scene catalog must contain at least 10 scenes')
const sceneIds = new Set(catalog.scenes.map((scene) => scene.id))
if (!sceneIds.has('home') || !sceneIds.has('chat') || !sceneIds.has('settings')) errors.push('core scenes home/chat/settings are required')
for (const scene of catalog.scenes) {
  if (!scene.source?.length) warnings.push('scene has no source mapping: ' + scene.id)
  if (!scene.states?.length) errors.push('scene has no states: ' + scene.id)
}
const traceability = readFileSync(resolve(root, 'SCENE-TRACEABILITY.md'), 'utf8')
for (const scene of catalog.scenes) {
  if (!traceability.includes('`' + scene.id + '`')) errors.push('scene missing traceability row: ' + scene.id)
}
const referencedScreenshots = manifest.evidence?.screenshots ?? []
for (const file of referencedScreenshots) {
  if (!existsSync(resolve(root, file))) errors.push('manifest references missing screenshot: ' + file)
}
if (!traceability.includes('baseline acceptance mode is **static source derivation**')) errors.push('traceability must declare static source derivation acceptance mode')
const htmlPath = resolve(root, 'prototype.html')
if (!existsSync(htmlPath)) warnings.push('prototype.html has not been exported yet')
else {
  const html = readFileSync(htmlPath, 'utf8')
  if (/<script[^>]+src=/.test(html)) errors.push('prototype.html still has external script references')
  if (/<link[^>]+stylesheet/.test(html)) errors.push('prototype.html still has external stylesheet references')
  if (/<(?:script|link)[^>]+https?:\/\//i.test(html)) errors.push('prototype.html contains a remote dependency')
  const digest = createHash('sha256').update(readFileSync(htmlPath)).digest('hex')
  if (manifest.artifacts.singleFileSha256 && manifest.artifacts.singleFileSha256 !== digest) errors.push('manifest singleFileSha256 does not match prototype.html')
}
const sourceText = readFileSync(resolve(root, 'src/app-shell.jsx'), 'utf8') + readFileSync(resolve(root, 'src/scenes/Scenes.jsx'), 'utf8')
if (sourceText.includes('window.electronAPI')) errors.push('prototype must not call production electronAPI directly')
if (sourceText.includes('Date.now(') || sourceText.includes('Math.random(')) errors.push('legacy fixture shell must remain deterministic')
const appShellSource = readFileSync(resolve(root, 'src/app-shell.jsx'), 'utf8')
for (const legacyImport of ["'./regions/TopBar.jsx'", "'./regions/NavigationRail.jsx'", "'./scenes/Scenes.jsx'", "'./runtime/interaction-primitives.jsx'"]) {
  if (appShellSource.includes(legacyImport)) errors.push('active router imports rejected generic mock module: ' + legacyImport)
}
if (appShellSource.includes('className="app-shell"')) errors.push('active router renders rejected generic app-shell')
const report = { ok: errors.length === 0, root, requiredFiles: required.length, scenes: catalog.scenes.length, warnings, errors, checkedAt: new Date().toISOString() }
if (report.ok) {
  manifest.verification = { ...manifest.verification, static: 'passed', sourceFidelity: 'static-source-derived' }
  writeFileSync(resolve(root, 'prototype-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (errors.length) process.exitCode = 1
