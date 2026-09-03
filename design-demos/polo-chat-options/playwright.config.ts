import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { defineConfig } from '@playwright/test'

// Collects the POO-50 prototype interaction spec. The spec file is named
// `*.playwright.ts` (not `*.spec.ts`) so bun test never discovers it in
// environments without @playwright/test — this config is the single
// collection point for the Playwright runner (`bunx playwright test`).
export default defineConfig({
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: /prototype\.playwright\.ts/,
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:8765',
  },
})
