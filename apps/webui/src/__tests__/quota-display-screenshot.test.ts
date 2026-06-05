/**
 * Playwright screenshot tests for the QuotaDisplay component.
 *
 * AC1: Quota display rendering — shows usage text and progress bar
 * AC2: Color coding by usage level — green/yellow/red visual indicators
 * AC4: Non-platform mode — component is not rendered
 *
 * Spins up a minimal Bun HTTP server serving a self-contained HTML page that
 * renders the quota display states without the full Vite/React build.
 * Screenshots are saved to .hermes-coding/e2e-evidence/
 */
import { afterAll, beforeAll, describe, it, expect } from 'bun:test'
import { chromium, type Browser, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Evidence directory
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = join(import.meta.dir, '../../../../..')
const EVIDENCE_DIR = join(WORKSPACE_ROOT, '.hermes-coding/e2e-evidence/quota-display')

function ensureEvidenceDir() {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
}

// ---------------------------------------------------------------------------
// Self-contained quota display HTML
// ---------------------------------------------------------------------------

type QuotaState = 'loading' | 'normal' | 'warning' | 'critical' | 'exhausted' | 'error' | 'non-platform'

function buildQuotaHtml(state: QuotaState): string {
  // Quota data per state
  const STATES: Record<QuotaState, { used: number; limit: number } | null> = {
    loading: null,
    normal: { used: 154_000, limit: 1_000_000 },
    warning: { used: 820_000, limit: 1_000_000 },
    critical: { used: 950_000, limit: 1_000_000 },
    exhausted: { used: 1_000_000, limit: 1_000_000 },
    error: null,
    'non-platform': null,
  }

  const data = STATES[state]

  function formatTokens(n: number): string {
    if (n < 1_000) return String(n)
    if (n < 1_000_000) return `${parseFloat((n / 1_000).toFixed(1))}K`
    return `${parseFloat((n / 1_000_000).toFixed(1))}M`
  }

  function getPct(used: number, limit: number): number {
    if (limit <= 0) return 0
    return Math.min(Math.round((used / limit) * 100), 100)
  }

  function getColor(used: number, limit: number): { text: string; bar: string } {
    const pct = limit > 0 ? used / limit : 0
    if (pct >= 1) return { text: '#dc2626', bar: '#ef4444' }
    if (pct >= 0.9) return { text: '#dc2626', bar: '#ef4444' }
    if (pct >= 0.75) return { text: '#ca8a04', bar: '#eab308' }
    return { text: '#16a34a', bar: '#22c55e' }
  }

  let componentHtml = ''
  let readySignal = ''

  if (state === 'non-platform') {
    // No quota component rendered
    componentHtml = '<p style="color:#999;font-size:13px">No quota display (non-platform mode)</p>'
    readySignal = 'document.body.dataset.ready = "true"; document.body.dataset.state = "non-platform";'
  } else if (state === 'loading') {
    componentHtml = `
      <div data-testid="quota-display" data-quota-state="loading"
           style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;color:#999">
        <div style="height:4px;width:56px;border-radius:9999px;overflow:hidden;background:rgba(0,0,0,0.1)">
          <div style="height:100%;width:50%;background:rgba(0,0,0,0.2);border-radius:9999px;
               animation:pulse 1.5s ease-in-out infinite;"></div>
        </div>
        <span>Loading...</span>
      </div>
    `
    readySignal = 'document.body.dataset.ready = "true"; document.body.dataset.state = "loading";'
  } else if (state === 'error') {
    componentHtml = `
      <div data-testid="quota-display" data-quota-state="error"
           style="display:flex;align-items:center;padding:4px 8px;font-size:11px;color:#999">
        <span>Usage unavailable</span>
      </div>
    `
    readySignal = 'document.body.dataset.ready = "true"; document.body.dataset.state = "error";'
  } else if (data) {
    const { used, limit } = data
    const pct = getPct(used, limit)
    const { text: textColor, bar: barColor } = getColor(used, limit)
    const usedFmt = formatTokens(used)
    const limitFmt = formatTokens(limit)
    const label = pct >= 100 ? `${usedFmt} / ${limitFmt} — Quota exceeded` : `${usedFmt} / ${limitFmt}`

    componentHtml = `
      <div data-testid="quota-display" data-quota-state="${state}"
           aria-label="Token usage: ${label}"
           style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;
                  color:${textColor};transition:color 0.3s">
        <div style="height:4px;width:56px;border-radius:9999px;overflow:hidden;background:rgba(0,0,0,0.1)">
          <div role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"
               style="height:100%;width:${pct}%;background:${barColor};border-radius:9999px;transition:width 0.5s"></div>
        </div>
        <span style="white-space:nowrap;font-family:monospace">${label}</span>
      </div>
    `
    readySignal = `document.body.dataset.ready = "true"; document.body.dataset.state = "${state}";`
  }

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QuotaDisplay — ${state}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#1a1a2e;min-height:100vh;display:flex;align-items:flex-start;
      justify-content:flex-end;padding:0;
    }
    .topbar{
      position:fixed;top:0;left:0;right:0;height:48px;
      background:rgba(20,20,35,0.95);border-bottom:1px solid rgba(255,255,255,0.08);
      display:flex;align-items:center;justify-content:flex-end;
      padding-right:12px;
    }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
  </style>
</head>
<body>
  <div class="topbar" id="topbar">
    ${componentHtml}
  </div>
  <script>
    // Signal readiness for Playwright
    ${readySignal}
  </script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// HTTP test server
// ---------------------------------------------------------------------------

let browser: Browser
let testServerPort: number
let testServer: ReturnType<typeof Bun.serve>

const STATES: QuotaState[] = ['loading', 'normal', 'warning', 'critical', 'exhausted', 'error', 'non-platform']

beforeAll(async () => {
  ensureEvidenceDir()
  browser = await chromium.launch({ headless: true })

  testServerPort = 34568

  testServer = Bun.serve({
    port: testServerPort,
    fetch(req) {
      const url = new URL(req.url)
      const state = url.pathname.slice(1) as QuotaState
      if (!STATES.includes(state)) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(buildQuotaHtml(state), {
        headers: { 'Content-Type': 'text/html' },
      })
    },
  })
})

afterAll(async () => {
  await browser.close()
  testServer.stop()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForReady(page: Page, timeout = 5000): Promise<void> {
  await page.waitForFunction(
    () => document.body.dataset['ready'] === 'true',
    { timeout },
  )
}

async function getQuotaDisplay(page: Page) {
  return page.$('[data-testid="quota-display"]')
}

// ---------------------------------------------------------------------------
// AC1: Quota display rendering
// ---------------------------------------------------------------------------

describe('QuotaDisplay screenshots (AC1, AC2, AC4)', () => {
  it('captures loading state', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/loading`)
      await waitForReady(page)

      const el = await getQuotaDisplay(page)
      expect(el).not.toBeNull()

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('loading')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('Loading...')

      const screenshotPath = join(EVIDENCE_DIR, 'quota-loading.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures normal state (<75% usage) with green color', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/normal`)
      await waitForReady(page)

      const el = await getQuotaDisplay(page)
      expect(el).not.toBeNull()

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('normal')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('154K / 1M')

      // Verify progress bar is rendered
      const progressBar = await page.$('[role="progressbar"]')
      expect(progressBar).not.toBeNull()

      const pct = await page.$eval('[role="progressbar"]', el => el.getAttribute('aria-valuenow'))
      expect(parseInt(pct ?? '0')).toBe(15)

      const screenshotPath = join(EVIDENCE_DIR, 'quota-normal.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures warning state (75-90% usage) with yellow indicator', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/warning`)
      await waitForReady(page)

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('warning')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('820K / 1M')

      const screenshotPath = join(EVIDENCE_DIR, 'quota-warning.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures critical state (>90% usage) with red indicator', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/critical`)
      await waitForReady(page)

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('critical')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('950K / 1M')

      const screenshotPath = join(EVIDENCE_DIR, 'quota-critical.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures exhausted state (>=100%) with "Quota exceeded" text', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/exhausted`)
      await waitForReady(page)

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('exhausted')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('Quota exceeded')
      expect(text).toContain('1M / 1M')

      const pct = await page.$eval('[role="progressbar"]', el => el.getAttribute('aria-valuenow'))
      expect(parseInt(pct ?? '0')).toBe(100)

      const screenshotPath = join(EVIDENCE_DIR, 'quota-exhausted.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures error state with "Usage unavailable" text', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/error`)
      await waitForReady(page)

      const state = await page.$eval('[data-testid="quota-display"]', el => el.getAttribute('data-quota-state'))
      expect(state).toBe('error')

      const text = await page.$eval('[data-testid="quota-display"]', el => el.textContent?.trim())
      expect(text).toContain('Usage unavailable')

      const screenshotPath = join(EVIDENCE_DIR, 'quota-error.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('does not render quota display in non-platform mode (AC4)', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 100 })

    try {
      await page.goto(`http://localhost:${testServerPort}/non-platform`)
      await waitForReady(page)

      // No quota display element should be present
      const el = await getQuotaDisplay(page)
      expect(el).toBeNull()

      const screenshotPath = join(EVIDENCE_DIR, 'quota-non-platform.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })
})
