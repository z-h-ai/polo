/**
 * Builds the POO-162 primitives render harness (real Electron window, real
 * production primitives). Artifacts under $POO162_BUILD_DIR
 * (default /tmp/poo162-primitives-render).
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO162_BUILD_DIR || '/tmp/poo162-primitives-render'

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
    rollupOptions: { input: { menu: join(here, 'pages', 'menu.html') } },
  },
})

await esbuild({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(build, 'main.cjs'),
  external: ['electron'],
})

console.log(`[poo162-primitives-render] build complete → ${build}`)
