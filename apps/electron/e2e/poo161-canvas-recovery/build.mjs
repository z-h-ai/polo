/**
 * Builds the POO-161 canvas-recovery harness: the harness page (production
 * GenUiAppCard + CanvasPaneCard), the fixture preload and the main-process
 * orchestrator (which bundles the REAL SessionManager / PiEventAdapter /
 * handleGenerateApp / shared jsonl sources). Idempotent; artifacts under
 * $POO161_BUILD_DIR (default /tmp/poo161-canvas-recovery).
 * Mirrors e2e/product-closure-20261027/build.mjs.
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync, accessSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO161_BUILD_DIR || '/tmp/poo161-canvas-recovery'

mkdirSync(join(build, 'pages'), { recursive: true })

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

// 1. Harness page — production canvas entries only.
await viteBuild({
  configFile: false,
  root: join(here, 'pages'),
  base: './',
  plugins: [react(), tailwind()],
  resolve: { alias, dedupe },
  build: {
    target: 'esnext',
    outDir: join(build, 'pages'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { canvas: join(here, 'pages', 'canvas.html') },
    },
  },
})

// 2. Fixture preload + harness main (real SessionManager pipeline inside).
await esbuild({
  entryPoints: [join(here, 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(build, 'preload.cjs'),
  external: ['electron'],
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
    'node-fetch': join(repo, 'apps/electron/src/main/shims/node-fetch.cjs'),
    'abort-controller': join(repo, 'apps/electron/src/main/shims/abort-controller.cjs'),
  },
  define: {
    'process.env.GOOGLE_OAUTH_CLIENT_ID': '""',
    'process.env.GOOGLE_OAUTH_CLIENT_SECRET': '""',
    'process.env.SLACK_OAUTH_CLIENT_ID': '""',
    'process.env.SLACK_OAUTH_CLIENT_SECRET': '""',
    'process.env.MICROSOFT_OAUTH_CLIENT_ID': '""',
    'process.env.MICROSOFT_OAUTH_CLIENT_SECRET': '""',
  },
})

// 3. Runtime resolution for externalized native deps.
mkdirSync(join(build, 'node_modules'), { recursive: true })
const koffiLink = join(build, 'node_modules', 'koffi')
if (!fsExists(koffiLink)) symlinkSync(join(repo, 'node_modules', 'koffi'), koffiLink)

console.log(`[poo161-canvas-recovery] build complete → ${build}`)

function fsExists(p) {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}
