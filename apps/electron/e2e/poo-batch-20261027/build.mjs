/**
 * Builds the batch E2E harness: renderer pages (host + surfaces), the
 * production browser toolbar/empty-state pages BrowserPaneManager loads, the
 * fixture preload, the main-process orchestrator, and a tiny canvas bundle
 * fixture. Idempotent; artifacts under $POO_BATCH_BUILD_DIR (default
 * /tmp/poo-batch-20261027).
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync, accessSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO_BATCH_BUILD_DIR || '/tmp/poo-batch-20261027'

mkdirSync(join(build, 'pages'), { recursive: true })
mkdirSync(join(build, 'renderer'), { recursive: true })
mkdirSync(join(build, 'fixture-bundle'), { recursive: true })

const { build: viteBuild } = await import(join(repo, 'node_modules/vite/dist/node/index.js'))
const react = (await import(join(repo, 'node_modules/@vitejs/plugin-react/dist/index.js'))).default
const tailwind = (await import(join(repo, 'node_modules/@tailwindcss/vite/dist/index.mjs'))).default
const { build: esbuild } = require('esbuild')

const rendererDir = join(repo, 'apps/electron/src/renderer')
const alias = {
  '@': rendererDir,
  '@config': join(repo, 'packages/shared/src/config'),
  react: join(repo, 'node_modules/react'),
  'react-dom': join(repo, 'node_modules/react-dom'),
}
const dedupe = ['react', 'react-dom']

// 1. Host page (loop A) — RightSidebarPane's './CanvasPane' goes to the stub.
if (!fsExists(join(build, 'pages', 'host', 'host.html'))) {
  await viteBuild({
    configFile: false,
    root: join(here, 'pages'),
    base: './',
    plugins: [
      {
        name: 'stub-canvas-pane',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === './CanvasPane' && importer?.endsWith('RightSidebarPane.tsx')) return join(here, 'pages', 'canvas-unused.tsx')
        },
      },
      react(),
      tailwind(),
    ],
    resolve: { alias, dedupe },
    build: {
      target: 'esnext',
      outDir: join(build, 'pages', 'host'),
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: join(here, 'pages', 'host.html'), output: { inlineDynamicImports: true } },
    },
  })
}

// 2. Surfaces page (loops B/C/D).
if (!fsExists(join(build, 'pages', 'surfaces', 'surfaces.html'))) {
  await viteBuild({
    configFile: false,
    root: join(here, 'pages'),
    base: './',
    plugins: [react(), tailwind()],
    resolve: { alias, dedupe },
    build: {
      target: 'esnext',
      outDir: join(build, 'pages', 'surfaces'),
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: join(here, 'pages', 'surfaces.html'), output: { inlineDynamicImports: true } },
    },
  })
}

// 3. Production browser toolbar + empty-state pages (consumed by BrowserPaneManager
//    via join(__dirname,'renderer/…')).
if (!fsExists(join(build, 'renderer', 'browser-toolbar.html'))) {
  await viteBuild({
    configFile: false,
    root: rendererDir,
    base: './',
    plugins: [react(), tailwind()],
    resolve: { alias, dedupe },
    build: {
      target: 'esnext',
      outDir: join(build, 'renderer'),
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: {
          'browser-toolbar': join(rendererDir, 'browser-toolbar.html'),
          'browser-empty-state': join(rendererDir, 'browser-empty-state.html'),
        },
      },
    },
  })
}

// 4. Fixture preload + production browser-toolbar preload (loaded by
//    BrowserPaneManager via join(__dirname,'browser-toolbar-preload.cjs')) + main.
await esbuild({
  entryPoints: [join(here, 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(build, 'preload.cjs'),
  external: ['electron'],
})
await esbuild({
  entryPoints: [join(repo, 'apps/electron/src/preload/browser-toolbar.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(build, 'browser-toolbar-preload.cjs'),
  external: ['electron'],
  nodePaths: [join(repo, 'node_modules')],
})
await esbuild({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(build, 'main.cjs'),
  external: ['electron', 'koffi'],
  nodePaths: [join(repo, 'node_modules')],
  alias: {
    '@polo-ai/shared/agent/browser-action-authorization': join(repo, 'packages/shared/src/agent/browser-action-authorization.ts'),
  },
})

// 5. Runtime resolution for externalized native deps: the compiled main.cjs
//    lives in the build dir, so koffi must be require-able from there.
mkdirSync(join(build, 'node_modules'), { recursive: true })
const koffiLink = join(build, 'node_modules', 'koffi')
if (!fsExists(koffiLink)) symlinkSync(join(repo, 'node_modules', 'koffi'), koffiLink)

// 6. Canvas bundle fixture the card's indexPath points at.
writeFileSync(
  join(build, 'fixture-bundle', 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Team Dashboard</title></head><body><h1>Team Dashboard fixture</h1><p>隔离画布夹具 · 无账号数据</p></body></html>',
)

console.log(`[poo-batch-20261027] build complete → ${build}`)

function fsExists(p) {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}
