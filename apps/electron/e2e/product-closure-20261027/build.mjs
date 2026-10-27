/**
 * Builds the product-closure-20261027 E2E harness (U6/U7/U11/U12 nails):
 * renderer harness pages (host + tabs), the production browser toolbar /
 * empty-state pages BrowserPaneManager loads, the fixture preload and the
 * main-process orchestrator. Idempotent; artifacts under
 * $PC_BUILD_DIR (default /tmp/product-closure-20261027).
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync, accessSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.PC_BUILD_DIR || '/tmp/product-closure-20261027'

mkdirSync(join(build, 'pages'), { recursive: true })
mkdirSync(join(build, 'renderer'), { recursive: true })

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

// 1. Harness pages — host (U11 download toast + U12 destroy-all) and tabs
//    (U7 tab-name rendering). The sidebar host page mounts the production
//    RightSidebarPane, whose './CanvasPane' import goes to the stub.
//    No caching: the harness must always reflect the CURRENT source tree.
{
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
      outDir: join(build, 'pages'),
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: {
          host: join(here, 'pages', 'host.html'),
          tabs: join(here, 'pages', 'tabs.html'),
        },
      },
    },
  })
}

// 2. Production browser toolbar + empty-state pages (consumed by
//    BrowserPaneManager via join(__dirname,'renderer/…')).
//    No caching either — a stale toolbar bundle once masked the U6 fix.
{
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

// 3. Fixture preload + production browser-toolbar preload + main.
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

// 4. Runtime resolution for externalized native deps.
mkdirSync(join(build, 'node_modules'), { recursive: true })
const koffiLink = join(build, 'node_modules', 'koffi')
if (!fsExists(koffiLink)) symlinkSync(join(repo, 'node_modules', 'koffi'), koffiLink)

console.log(`[product-closure-20261027] build complete → ${build}`)

function fsExists(p) {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}
