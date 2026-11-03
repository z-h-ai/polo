import { resolve } from 'node:path'
import base from './vite.config.mjs'

// The same aliases/plugins/CSS as the current baseline, with only the editor entry.
export default {
  ...base,
  build: {
    ...base.build,
    rollupOptions: { input: resolve(process.cwd(), 'entries/interview-input.html') },
  },
}
