import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = process.env.POLO_REPO_ROOT || execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
const viteModule = await import(pathToFileURL(resolve(repositoryRoot, 'node_modules/vite/dist/node/index.js')).href)
const reactModule = await import(pathToFileURL(resolve(repositoryRoot, 'node_modules/@vitejs/plugin-react/dist/index.js')).href)
const { defineConfig } = viteModule
const react = reactModule.default || reactModule
const electronRoot = resolve(repositoryRoot, 'apps/electron')
const devNodeModules = resolve(repositoryRoot, 'node_modules')

export default defineConfig({
  root: sourceRoot,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      react: resolve(devNodeModules, 'react'),
      'react-dom': resolve(devNodeModules, 'react-dom'),
      // Render the same icon package as the Electron Renderer. The export
      // tool subsequently inlines its generated SVG into prototype.html.
      'lucide-react': resolve(devNodeModules, 'lucide-react'),
      // WhatsApp QR code rendering — same package as the Electron Renderer.
      'qrcode.react': resolve(devNodeModules, 'qrcode.react'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: resolve(sourceRoot, 'dist'),
    emptyDirBeforeWrite: true,
    sourcemap: false,
  },
  server: { port: 4183, open: false },
  define: { __ELECTRON_SOURCE_ROOT__: JSON.stringify(electronRoot) },
})
