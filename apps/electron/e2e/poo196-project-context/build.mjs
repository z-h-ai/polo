/**
 * Builds the poo196-project-context E2E harness: the renderer host page
 * (production ChatPage + project-context surface), the programmable fixture
 * preload and the main-process orchestrator. Idempotent; artifacts under
 * $POO196_BUILD_DIR (default /tmp/poo196-experience/build). No caching: the
 * harness must always reflect the CURRENT source tree.
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync, symlinkSync, accessSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO196_BUILD_DIR || '/tmp/poo196-experience/build'

mkdirSync(join(build, 'pages'), { recursive: true })
mkdirSync(join(build, 'fixture'), { recursive: true })

const { build: viteBuild } = await import(join(repo, 'node_modules/vite/dist/node/index.js'))
const react = (await import(join(repo, 'node_modules/@vitejs/plugin-react/dist/index.js'))).default
const tailwind = (await import(join(repo, 'node_modules/@tailwindcss/vite/dist/index.mjs'))).default
const { build: esbuild } = require('esbuild')

const rendererDir = join(repo, 'apps/electron/src/renderer')
const alias = {
  '@': rendererDir,
  '@config': join(repo, 'packages/shared/src/config'),
  'fixture-data': join(here, 'fixture-data.ts'),
  react: join(repo, 'node_modules/react'),
  'react-dom': join(repo, 'node_modules/react-dom'),
}
const dedupe = ['react', 'react-dom']

// 1. Harness host page — mounts production ChatPage over the fixture preload.
await viteBuild({
  configFile: false,
  root: join(here, 'pages'),
  base: './',
  plugins: [react(), tailwind()],
  resolve: { alias, dedupe },
  define: {
    global: 'globalThis',
  },
  build: {
    target: 'esnext',
    outDir: join(build, 'pages'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { host: join(here, 'pages', 'host.html') },
    },
  },
})

// 2. Fixture preload + main orchestrator (fixture-data inlined into both).
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
  external: ['electron'],
  nodePaths: [join(repo, 'node_modules')],
  alias: {
    '@polo-ai/shared/protocol': join(repo, 'packages/shared/src/protocol/index.ts'),
  },
})

console.log(`[poo196-project-context] build complete → ${build}`)

function fsExists(p) {
  try {
    accessSync(p)
    return true
  } catch {
    return false
  }
}
void fsExists
void symlinkSync
