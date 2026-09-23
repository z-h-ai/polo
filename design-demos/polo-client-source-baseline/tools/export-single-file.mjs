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
html = html.replace('</head>', '<meta name="prototype-artifact" content="source-baseline-single-file"><meta name="prototype-size" content="' + Math.round(Buffer.byteLength(html) / 1024) + ' KiB"></head>')
writeFileSync(output, html)

const manifestPath = resolve(root, 'prototype-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
// Exporting is mechanical; it must never promote an in-progress reconstruction
// to a verified, source-faithful baseline.
manifest.verification = { ...manifest.verification, static: 'pending_reexport', browser: 'not_run_for_reconstruction', visual: 'not_run_for_reconstruction', interactive: 'not_run_for_reconstruction' }
manifest.artifacts.singleFileBytes = statSync(output).size
manifest.artifacts.singleFileSha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
manifest.artifacts.moduleBuild = 'dist/'
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('Wrote ' + output + ' (' + statSync(output).size + ' bytes)')
