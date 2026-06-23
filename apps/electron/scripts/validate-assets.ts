import { existsSync } from 'fs'
import { join } from 'path'

const required = [
  'dist/main.cjs',
  'dist/bootstrap-preload.cjs',
  'dist/browser-toolbar-preload.cjs',
  'dist/interceptor.cjs',
  'dist/renderer/index.html',
  'dist/renderer/browser-toolbar.html',
  'dist/renderer/browser-empty-state.html',
  'dist/resources',
]

const missing = required.filter((path) => !existsSync(join(process.cwd(), path)))

if (missing.length > 0) {
  console.error(`Missing build assets:\n${missing.map((path) => `- ${path}`).join('\n')}`)
  process.exit(1)
}

console.log('✓ Build assets validated')
