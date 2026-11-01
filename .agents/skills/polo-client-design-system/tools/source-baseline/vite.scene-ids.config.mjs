import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// SSR build of entries/scene-ids.ts: the manifest scene list is produced by
// evaluating the REAL scene modules with the SAME toolchain as the browser
// bundle (esbuild alone cannot transform import.meta.glob / asset imports).
// Output is a fixed-name CJS file executed by scene-ids-runner.cjs.
function findToolchainRoot() {
  if (process.env.POLO_TOOLCHAIN_ROOT) return process.env.POLO_TOOLCHAIN_ROOT
  let dir = resolve(process.cwd())
  for (;;) {
    if (existsSync(resolve(dir, 'node_modules/vite/dist/node/index.js'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) throw new Error('Could not locate node_modules above ' + process.cwd())
    dir = parent
  }
}
const root = findToolchainRoot()
const rendererRoot = resolve(root, 'apps/electron/src/renderer')

const viteModule = await import(pathToFileURL(resolve(root, 'node_modules/vite/dist/node/index.js')).href)
const { defineConfig } = viteModule

export default defineConfig({
  root: resolve(process.cwd()),
  base: './',
  // Bundle ALL dependencies into the single CJS output: node must not resolve
  // the externalized workspace/browser packages itself (several exports maps,
  // e.g. @pierre/diffs, do not expose the subpaths the bundle requires).
  ssr: { noExternal: true },
  resolve: {
    alias: {
      '@': rendererRoot,
      '@config': resolve(root, 'packages/shared/src/config'),
      react: resolve(root, 'node_modules/react'),
      'react-dom': resolve(root, 'node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    // Evaluate the scene registry, not render it: bundle everything (the
    // workspace packages are TS source, not node-resolvable JS) into one
    // fixed-name CJS file. No HTML, no hashing — deterministic output.
    ssr: resolve(process.cwd(), 'entries/scene-ids.ts'),
    // Same contract as vite.config.mjs: build.py points this at a temp dir.
    outDir: process.env.POLO_BASELINE_SCENE_DIST || 'dist-scene-ids',
    emptyDirBeforeWrite: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        // One file, fixed name: the runner requires exactly scene-ids.cjs.
        inlineDynamicImports: true,
        entryFileNames: 'scene-ids.cjs',
        chunkFileNames: 'scene-ids.cjs',
        assetFileNames: 'scene-ids[extname]',
      },
    },
  },
})
