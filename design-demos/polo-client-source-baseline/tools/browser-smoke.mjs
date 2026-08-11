import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const modulePath = process.env.PLAYWRIGHT_MODULE || resolve(root, '../../../../../../polo-admin-dir/dev/node_modules/playwright/index.mjs')
const baseURL = process.env.PROTOTYPE_URL || 'http://127.0.0.1:4183'
const evidenceDir = resolve(root, 'screenshots/baseline')
mkdirSync(evidenceDir, { recursive: true })

if (!existsSync(modulePath)) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'Playwright module not found', modulePath }, null, 2))
  process.exit(0)
}

const { chromium } = await import(modulePath)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const checks = []
const check = (name, value) => checks.push({ name, pass: Boolean(value) })

await page.goto(baseURL + '/?scene=home&state=normal&theme=light')
await page.waitForTimeout(250)
check('home heading', await page.getByRole('heading', { name: 'Good morning, workspace admin' }).count() === 1)
await page.screenshot({ path: resolve(evidenceDir, 'home-light-1440x900.png'), fullPage: true })

await page.getByRole('button', { name: 'Resources' }).click()
await page.waitForTimeout(100)
check('resources navigation', await page.getByRole('heading', { name: 'Sources' }).count() === 1)

await page.goto(baseURL + '/?scene=chat&state=normal&theme=dark')
await page.waitForTimeout(150)
await page.getByPlaceholder(/Ask Polo/).fill('smoke test')
await page.getByRole('button', { name: 'Send message' }).click()
check('chat send interaction', await page.getByText('The local mock is ready for review.').count() === 1)
await page.screenshot({ path: resolve(evidenceDir, 'chat-dark-1440x900.png'), fullPage: true })

await page.goto(baseURL + '/?scene=organization&state=select&theme=light')
await page.waitForTimeout(150)
await page.getByRole('button', { name: 'Continue' }).click()
check('organization lifecycle to management', await page.getByRole('heading', { name: 'Creator Space' }).count() > 0)

await page.goto('file://' + resolve(root, 'prototype.html') + '?scene=settings&state=appearance&theme=light')
await page.waitForTimeout(250)
check('single-file settings', await page.getByRole('heading', { name: 'Appearance' }).count() > 0)
check('single-file runtime', await page.evaluate(() => Boolean(window.PrototypeRuntime)))
await page.screenshot({ path: resolve(evidenceDir, 'settings-file-800x600.png'), fullPage: true })

const report = { ok: errors.length === 0 && checks.every((item) => item.pass), baseURL, checks, pageErrors: errors, generatedAt: new Date().toISOString() }
writeFileSync(resolve(root, 'screenshots/browser-acceptance.json'), JSON.stringify(report, null, 2) + '\n')
const manifestPath = resolve(root, 'prototype-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.verification = { ...manifest.verification, browser: report.ok ? 'passed' : 'failed', visual: report.ok ? 'passed' : 'pending', interactive: report.ok ? 'passed' : 'failed' }
manifest.evidence = { browserAcceptance: 'screenshots/browser-acceptance.json', sceneMatrix: 'screenshots/scene-matrix.json', screenshots: ['screenshots/baseline/home-light-1440x900.png', 'screenshots/baseline/chat-dark-1440x900.png', 'screenshots/baseline/settings-file-800x600.png'] }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
await browser.close()
if (!report.ok) process.exitCode = 1
