import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../../../..')
const rendererRoot = resolve(repositoryRoot, 'apps/electron/src/renderer')

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      {
        find: '@/context/TabShellContext',
        replacement: resolve(__dirname, 'src/mocks/tab-shell.tsx'),
      },
      {
        find: '@/hooks/useAppCatalog',
        replacement: resolve(__dirname, 'src/mocks/app-catalog.ts'),
      },
      {
        find: '@tab-browser-types',
        replacement: resolve(
          repositoryRoot,
          'apps/electron/src/shared/tab-browser-types.ts',
        ),
      },
      {
        find: '@',
        replacement: rendererRoot,
      },
      {
        find: '@config',
        replacement: resolve(repositoryRoot, 'packages/shared/src/config'),
      },
      {
        find: 'react',
        replacement: resolve(repositoryRoot, 'node_modules/react'),
      },
      {
        find: 'react-dom',
        replacement: resolve(repositoryRoot, 'node_modules/react-dom'),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  define: {
    'import.meta.env.IS_WEBUI': 'false',
  },
  build: {
    outDir: resolve(__dirname, '../renderer'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
})
