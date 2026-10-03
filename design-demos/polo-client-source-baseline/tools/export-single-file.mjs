import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const viteBin = process.env.VITE_BIN || resolve(root, '../../../../../dev/node_modules/.bin/vite')
const config = resolve(root, 'vite.config.mjs')
const dist = resolve(root, 'dist')
const distHtml = resolve(dist, 'index.html')
const output = resolve(root, 'prototype.html')

if (!existsSync(viteBin)) throw new Error('Vite executable not found: ' + viteBin)
execFileSync(viteBin, ['build', '--config', config], { cwd: root, stdio: 'inherit' })
let html = readFileSync(distHtml, 'utf8')
html = html.replace(/<link[^>]+href="([^"]+\.css)"[^>]*>/g, (_match, href) => {
  const cssPath = resolve(dist, href.replace(/^\.\//, ''))
  return '<style data-inlined-from="' + href + '">\n' + readFileSync(cssPath, 'utf8') + '\n</style>'
})
html = html.replace(/<script([^>]+)src="([^"]+\.js)"([^>]*)><\/script>/g, (_match, before, href, after) => {
  const jsPath = resolve(dist, href.replace(/^\.\//, ''))
  let js = readFileSync(jsPath, 'utf8')
  // Vite emits imported raster assets beside its JS chunk. A relative asset URL
  // breaks when the chunk is inlined into prototype.html, so turn every emitted
  // raster reference into its original data URL before embedding the script.
  js = js.replace(/([A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp|svg))/g, (assetName) => {
    const assetPath = resolve(dist, 'assets', assetName)
    if (!existsSync(assetPath)) return assetName
    const extension = assetName.split('.').pop().toLowerCase()
    const mime = extension === 'png' ? 'image/png'
      : extension === 'svg' ? 'image/svg+xml'
        : extension === 'gif' ? 'image/gif'
          : extension === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${readFileSync(assetPath).toString('base64')}`
  })
  return '<script' + before + after + '>\n' + js + '\n</script>'
})
html = html.replace(/\s+crossorigin(?:="[^"]*")?/g, '')
html = html.replace('</head>', '<meta name="prototype-artifact" content="polo-assistant-chat-single-file"><meta name="prototype-size" content="' + Math.round(Buffer.byteLength(html) / 1024) + ' KiB"></head>')
writeFileSync(output, html)

const manifestPath = resolve(root, 'prototype-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
// Exporting is mechanical; the Chat shell is a product-design adaptation and
// must not be promoted to a source-faithful Renderer capture.
manifest.baselineVersion = '0.5.3-workbench-r15-ui-refinement'
manifest.name = 'Polo 技能管理增量 · 既有助手行为示意'
manifest.protocol.defaultScene = 'A-personal-new'
manifest.protocol.reviewMessages = 'product-ui-prototype:* v1; expected parent window, session, epoch, declared scene'
manifest.protocol.auxiliaryReferences = '?reference=1&scene=chat&state=empty'
manifest.coverage.mvpSceneSource = 'src/mvp/scenes.mjs'
manifest.coverage.unifiedManifest = '../../docs/mvp-complete-flow-hifi/prototype-manifest.json'
manifest.coverage.regions = 'Skills and explicit Spec 13.11 deltas are reviewed here. Existing assistant UI stays owned by apps/electron/src/renderer; illustrative chat layouts must not drive production UI rewrites. Auxiliary scene-catalog is historical reference only.'
manifest.verification = { static: 'see-unified-quality-report', browser: 'see-unified-quality-report', interactive: 'see-unified-quality-report', visual: 'pending-user-review', sourceFidelity: 'existing-assistant-behavior-illustration-not-ui-authority', report: '../../docs/mvp-complete-flow-hifi/quality-report.json', browserScope: 'Chinese light; file and local HTTP; 1440x900, 1024x768, 800x600. Results are bound to artifact hashes in the unified report.' }
manifest.evidence.historicalChatFocus ||= { revision: '0.3.0-chat-focused', screenshots: manifest.evidence.currentScreenshots, browser: manifest.evidence.currentBrowserCheck }
manifest.evidence.currentScreenshots = ['1440x900', '1024x768', '800x600'].map(size => '../../docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/A-personal-new-desktop-' + size + '.png')
manifest.evidence.currentBrowserCheck = '../../docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/browser.json'
manifest.artifacts.componentGallery.note = 'Historical auxiliary component gallery captured before r12. MVP deltas are reviewed only through the unified entry; this gallery is not current whole-page evidence.'
manifest.artifacts.singleFileBytes = statSync(output).size
manifest.artifacts.singleFileSha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
manifest.artifacts.moduleBuild = 'dist/'
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('Wrote ' + output + ' (' + statSync(output).size + ' bytes)')
