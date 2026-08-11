import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const toolchainRoot = process.env.POLO_ELECTRON_ROOT || resolve(process.cwd(), '../../../../../dev')
const viteModule = await import(pathToFileURL(resolve(toolchainRoot, 'node_modules/vite/dist/node/index.js')).href)
const reactModule = await import(pathToFileURL(resolve(toolchainRoot, 'node_modules/@vitejs/plugin-react/dist/index.js')).href)
const { defineConfig } = viteModule
const react = reactModule.default || reactModule
const sourceRoot = resolve(process.cwd())
const electronRoot = resolve(toolchainRoot, 'apps/electron')
const devNodeModules = resolve(toolchainRoot, 'node_modules')

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
