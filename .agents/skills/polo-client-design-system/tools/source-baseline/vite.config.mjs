import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Builds the design-skill source baseline from the REAL renderer sources.
// Toolchain (vite / react plugin / tailwind) and every runtime dependency are
// resolved from the monorepo root so the baseline renders with exactly the
// dependency versions the Electron renderer ships with. No timestamp or
// machine path is embedded: identical inputs must produce byte-identical
// output, which check_design_system.py verifies by regenerating.
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
const electronRoot = resolve(root, 'apps/electron')
const rendererRoot = resolve(electronRoot, 'src/renderer')

const viteModule = await import(pathToFileURL(resolve(root, 'node_modules/vite/dist/node/index.js')).href)
const reactModule = await import(pathToFileURL(resolve(root, 'node_modules/@vitejs/plugin-react/dist/index.js')).href)
const tailwindModule = await import(pathToFileURL(resolve(root, 'node_modules/@tailwindcss/vite/dist/index.mjs')).href)
const { defineConfig } = viteModule

// Emits the REAL build's input set (post-alias resolved ids) so build.py
// can fingerprint the exact inputs consumed by this build — not a guess from
// import statements. moduleParsed only covers the JS module graph; the CSS
// pipeline (the @import chain under renderer/index.css) and other watched
// dependencies never pass through it, so closeBundle merges Rollup's
// watch-file list, which does include them. Path via POLO_BASELINE_MODULES_OUT;
// nothing is written when the variable is absent (e.g. other consumers).
function collectModuleGraph() {
  const ids = new Set()
  return {
    name: 'polo-baseline-module-graph',
    apply: 'build',
    moduleParsed(module) {
      if (module.id) ids.add(module.id)
    },
    closeBundle() {
      const out = process.env.POLO_BASELINE_MODULES_OUT
      if (!out) return
      for (const id of this.getWatchFiles()) {
        if (id) ids.add(id)
      }
      writeFileSync(out, JSON.stringify([...ids].sort(), null, 2) + '\n')
    },
  }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Inlines every bundle file into the entry HTML so the generated page opens
// directly from file:// — a plain ES module <script src> is CORS-blocked on
// the file scheme, which made the pre-inline export a blank page. Dynamic
// imports are folded into the single chunk first (inlineDynamicImports), so
// nothing is fetched at runtime; inline code escapes "</script" so the
// document cannot be truncated by a string literal in the bundle.
function singleFileInline() {
  return {
    name: 'polo-baseline-single-file',
    apply: 'build',
    config(config) {
      config.build = config.build ?? {}
      config.build.rollupOptions = {
        ...(config.build.rollupOptions ?? {}),
        output: { ...(config.build.rollupOptions?.output ?? {}), inlineDynamicImports: true },
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        let out = html
        for (const [name, file] of Object.entries(ctx.bundle ?? {})) {
          if (file.type === 'chunk') {
            const re = new RegExp('<script type="module"[^>]*\\ssrc="[^"]*' + escapeRe(name) + '"[^>]*>\\s*</script>')
            const code = file.code.replace(/<\/script/gi, '<\\/script')
            out = out.replace(re, () => '<script type="module">\n' + code + '\n</script>')
          } else if (name.endsWith('.css')) {
            const re = new RegExp('<link rel="stylesheet"[^>]*\\shref="[^"]*' + escapeRe(name) + '"[^>]*>')
            out = out.replace(re, () => '<style>\n' + file.source + '\n</style>')
          }
        }
        return out.replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
      },
    },
  }
}

export default defineConfig({
  // Resolved from cwd, not import.meta.url: vite copies the config to
  // node_modules/.vite-temp before evaluating it.
  root: resolve(process.cwd()),
  base: './',
  plugins: [reactModule.default(), (tailwindModule.default || tailwindModule.tailwindcss)(), singleFileInline(), collectModuleGraph()],
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
    // Build output goes where build.py points it (a temp dir by default), so
    // the generator tree never accumulates bundle leftovers.
    outDir: process.env.POLO_BASELINE_DIST || 'dist',
    emptyDirBeforeWrite: true,
    sourcemap: false,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(process.cwd(), 'entries/baseline.html'),
    },
  },
})
