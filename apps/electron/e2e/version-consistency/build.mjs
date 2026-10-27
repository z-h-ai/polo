/**
 * Builds the POO-160 harness: the about page (production settings surface)
 * via Vite, the fixture preload and the main orchestrator via esbuild.
 * Idempotent; artifacts under $POO160_BUILD_DIR (default /tmp/poo160-version).
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { mkdirSync, accessSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..', '..')
const require = createRequire(join(repo, 'package.json'))
const build = process.env.POO160_BUILD_DIR || '/tmp/poo160-version'

mkdirSync(join(build, 'pages'), { recursive: true })

// Launch identity: Electron resolves app.getVersion() from the app dir's
// package.json (in a packaged build this is the same value electron-builder
// writes into Info.plist). Write the production app's identity here so the
// harness's `electron <build>` launch sees the real app version.
writeFileSync(
  join(build, 'package.json'),
  JSON.stringify({ name: 'polo-ai', productName: 'Polo AI', version: require(join(repo, 'apps/electron/package.json')).version, main: 'main.cjs' }, null, 2) + '\n',
)

const { build: viteBuild } = await import(join(repo, 'node_modules/vite/dist/node/index.js'))
const react = (await import(join(repo, 'node_modules/@vitejs/plugin-react/dist/index.js'))).default
const tailwind = (await import(join(repo, 'node_modules/@tailwindcss/vite/dist/index.mjs'))).default
const { build: esbuild } = require('esbuild')

const rendererDir = join(repo, 'apps/electron/src/renderer')
const sharedSrc = join(repo, 'packages/shared/src')
const alias = {
  '@': rendererDir,
  '@config': join(sharedSrc, 'config'),
  // Pin the shared entry points the page imports so Vite bundles the
  // workspace source (and therefore packages/shared/package.json's version).
  '@polo-ai/shared/version': join(sharedSrc, 'version/index.ts'),
  '@polo-ai/shared/i18n': join(sharedSrc, 'i18n/index.ts'),
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
    outDir: join(build, 'pages', 'about'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: { input: join(here, 'pages', 'about.html'), output: { inlineDynamicImports: true } },
  },
})

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
  // Bundle electron-updater/electron-log too: bun's isolated node_modules
  // layout keeps their transitive deps out of the top level, so runtime
  // require from the build dir cannot resolve them.
  external: ['electron', 'koffi'],
  nodePaths: [join(repo, 'node_modules')],
  alias: {
    '@polo-ai/shared/version': join(sharedSrc, 'version/index.ts'),
    '@polo-ai/shared/config': join(sharedSrc, 'config/index.ts'),
    '@polo-ai/shared/utils/files': join(sharedSrc, 'utils/files.ts'),
  },
})

console.log(`[poo160-version] build complete → ${build}`)

// Native dep pulled in transitively via @polo-ai/shared/config: main.cjs lives
// in the build dir, so koffi must be require-able from there (same approach
// as poo-batch-20261027).
mkdirSync(join(build, 'node_modules'), { recursive: true })
const koffiLink = join(build, 'node_modules', 'koffi')
try {
  accessSync(koffiLink)
} catch {
  symlinkSync(join(repo, 'node_modules', 'koffi'), koffiLink)
}
