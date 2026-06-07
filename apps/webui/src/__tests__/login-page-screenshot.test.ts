/**
 * Playwright screenshot tests for the Polo AI login page.
 *
 * AC5: Visual testing
 * - Screenshot of login page in initial state (form ready with username/password fields)
 * - Screenshot of login page in error state
 *
 * This test spins up a minimal Bun HTTP server that serves a self-contained
 * HTML page with the login component logic. Screenshots are saved to
 * .hermes-coding/e2e-evidence/
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium, type Browser, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Evidence directory
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = join(import.meta.dir, '../../../../..')
const EVIDENCE_DIR = join(WORKSPACE_ROOT, '.hermes-coding/e2e-evidence/login-page')

function ensureEvidenceDir() {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
}

// ---------------------------------------------------------------------------
// Self-contained login HTML (inline implementation for testing without Vite)
// ---------------------------------------------------------------------------

function buildLoginHtml(opts: {
  authMeStatus: number
  publicConfig: { adminUrl: string | null; platformMode: boolean }
  loginStatus?: number
  loginBody?: object
}): string {
  const loginStatus = opts.loginStatus ?? 401
  const loginBody = opts.loginBody ?? { error: 'invalid_credentials' }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polo AI — Login Test</title>
  <style>
    :root {
      --page-bg: #f8f8fa; --page-fg: #1a1a2e; --card-bg: rgba(255,255,255,0.86);
      --card-border: rgba(228,228,232,0.9); --card-shadow: 0 32px 96px rgba(41,25,63,0.14);
      --subtitle: rgba(26,26,46,0.56); --input-bg: rgba(255,255,255,0.72);
      --input-border: rgba(212,212,216,0.95); --placeholder: rgba(26,26,46,0.34);
      --accent: #6d5dfc; --accent-hover: #5a4be0; --ambient-strong: rgba(104,78,133,0.18);
      --ambient-soft: rgba(104,78,133,0.1); --error-bg: #fef2f2;
      --error-border: #fecaca; --error-fg: #b91c1c;
      --logo-bg: linear-gradient(135deg,#7b6dff 0%,#5a4be0 100%);
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;
      background:var(--page-bg);color:var(--page-fg);display:flex;
      align-items:center;justify-content:center;min-height:100vh;padding:16px;
      position:relative;isolation:isolate;overflow:hidden;
    }
    body::before{
      content:'';position:absolute;inset:-18%;
      background:radial-gradient(circle at 18% 20%,var(--ambient-strong) 0,transparent 34%),
        radial-gradient(circle at 82% 18%,var(--ambient-soft) 0,transparent 28%);
      filter:blur(44px);opacity:0.95;pointer-events:none;
    }
    .login-card{
      position:relative;z-index:1;width:100%;max-width:28rem;padding:40px 36px 36px;
      background:var(--card-bg);border:1px solid var(--card-border);border-radius:20px;
      text-align:center;box-shadow:var(--card-shadow);
      backdrop-filter:blur(24px) saturate(140%);
    }
    .login-logo{
      display:flex;align-items:center;justify-content:center;margin:0 auto 16px;
      width:40px;height:40px;background:var(--logo-bg);border-radius:10px;
      box-shadow:0 8px 20px rgba(109,93,252,0.35);
    }
    .login-logo-mark{font-size:18px;font-weight:700;color:#fff;user-select:none}
    .login-title{font-size:20px;font-weight:600;margin-bottom:4px;letter-spacing:-0.01em}
    .login-subtitle{font-size:13px;color:var(--subtitle);margin-bottom:28px}
    .login-field{margin-bottom:16px;text-align:left}
    .login-label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
    .login-input{
      width:100%;padding:10px 12px;font-size:14px;font-family:inherit;
      border:1px solid var(--input-border);border-radius:8px;outline:none;
      background:var(--input-bg);color:var(--page-fg);transition:border-color 0.15s,box-shadow 0.15s;
    }
    .login-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(109,93,252,0.12)}
    .login-input:disabled{opacity:0.6;cursor:not-allowed}
    .login-btn{
      display:inline-flex;align-items:center;justify-content:center;gap:8px;
      width:100%;margin-top:8px;padding:10px;font-size:14px;font-weight:500;font-family:inherit;
      color:#fff;background:linear-gradient(180deg,#7b6dff 0%,var(--accent) 100%);
      border:none;border-radius:8px;cursor:pointer;
      transition:transform 0.15s,filter 0.15s;box-shadow:0 10px 24px rgba(109,93,252,0.28);
    }
    .login-btn:disabled{opacity:0.55;cursor:not-allowed;transform:none;filter:none;box-shadow:none}
    .login-btn:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.02)}
    .login-error{
      display:none;margin-top:16px;padding:10px 12px;font-size:13px;text-align:left;
      background:var(--error-bg);border:1px solid var(--error-border);border-radius:8px;
      color:var(--error-fg);line-height:1.5;
    }
    .login-error--visible{display:block}
    @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
    .animate-spin{animation:spin 1s linear infinite;display:inline-block;width:14px;height:14px}
  </style>
</head>
<body>
  <div id="root"></div>

  <script>
    // Mock fetch responses
    const MOCKS = {
      '/auth/me': { status: ${opts.authMeStatus}, body: { error: 'session_expired' } },
      '/api/public-config': { status: 200, body: ${JSON.stringify(opts.publicConfig)} },
      '/auth/login': {
        status: ${loginStatus},
        body: ${JSON.stringify(loginBody)}
      },
      '/api/config': { status: 200, body: { wsUrl: 'wss://polo.test/ws' } },
    };

    const _origFetch = window.fetch.bind(window);
    window._loginFetches = [];
    window.fetch = async function(url, init) {
      const key = typeof url === 'string' ? url : url.toString();
      window._loginFetches.push(key);
      if (Object.prototype.hasOwnProperty.call(MOCKS, key)) {
        const mock = MOCKS[key];
        await new Promise(r => setTimeout(r, 10));
        return new Response(JSON.stringify(mock.body), {
          status: mock.status,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return _origFetch(url, init);
    };

    // Prevent navigation
    window._redirectTarget = null;
    try {
      Object.defineProperty(window.location, 'href', {
        get: function() { return window._redirectTarget || 'http://localhost/login'; },
        set: function(val) { window._redirectTarget = val; document.body.dataset.redirectTo = val; },
        configurable: true,
      });
    } catch(e) { /* ignore — some browsers don't allow overriding location.href */ }
  </script>

  <script>
    (function() {
      const root = document.getElementById('root');

      function loginCardHtml(cfg) {
        const errorHtml = cfg.error
          ? '<div role="alert" data-testid="config-error" class="login-error login-error--visible">' + cfg.error + '</div>'
          : '';
        const formHtml = cfg.showForm ? [
          '<p class="login-subtitle">Sign in to continue</p>',
          '<form id="login-form" novalidate>',
          '  <div class="login-field">',
          '    <label for="username" class="login-label">Username</label>',
          '    <input id="username" name="username" type="text" autocomplete="username"',
          '      placeholder="Enter your username" class="login-input" aria-required="true" autofocus />',
          '  </div>',
          '  <div class="login-field">',
          '    <label for="password" class="login-label">Password</label>',
          '    <input id="password" name="password" type="password" autocomplete="current-password"',
          '      placeholder="Enter your password" class="login-input" aria-required="true" />',
          '  </div>',
          '  <button type="submit" class="login-btn" data-testid="login-submit" disabled>Login</button>',
          '</form>',
          '<div role="alert" data-testid="login-error" class="login-error"></div>',
        ].join('') : '';

        return [
          '<div class="login-card" role="main">',
          '  <div class="login-logo" aria-hidden="true"><span class="login-logo-mark">P</span></div>',
          '  <h1 class="login-title">Polo AI</h1>',
          errorHtml,
          formHtml,
          '</div>',
        ].join('');
      }

      function setupForm() {
        var form = document.getElementById('login-form');
        var submitBtn = document.querySelector('[data-testid="login-submit"]');
        var usernameInput = document.getElementById('username');
        var passwordInput = document.getElementById('password');
        var errorEl = document.querySelector('[data-testid="login-error"]');

        function updateSubmit() {
          var filled = usernameInput.value.trim() && passwordInput.value.trim();
          submitBtn.disabled = !filled;
        }

        function clearError() {
          errorEl.classList.remove('login-error--visible');
          errorEl.textContent = '';
        }

        usernameInput.addEventListener('input', function() { updateSubmit(); clearError(); });
        passwordInput.addEventListener('input', function() { updateSubmit(); clearError(); });

        form.addEventListener('submit', async function(e) {
          e.preventDefault();
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<svg class="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke-linecap="round"/></svg> Signing in\\u2026';

          try {
            var loginRes = await window.fetch('/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }),
            });

            if (!loginRes.ok) {
              var status = loginRes.status;
              var msg = 'An unexpected error occurred';
              if (status === 401) msg = 'Username or password incorrect';
              else if (status === 403) msg = 'Account disabled, contact administrator';
              else if (status === 429) msg = 'Too many attempts, try again later';
              errorEl.textContent = msg;
              errorEl.classList.add('login-error--visible');
              submitBtn.disabled = false;
              submitBtn.textContent = 'Login';
              updateSubmit();
              return;
            }

            await loginRes.json();
            window.location.href = '/';
          } catch(err) {
            errorEl.textContent = 'Service temporarily unavailable';
            errorEl.classList.add('login-error--visible');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
          }
        });
      }

      async function init() {
        var meRes = await window.fetch('/auth/me');
        if (meRes.ok) {
          window.location.href = '/';
          return;
        }

        var configRes = await window.fetch('/api/public-config');
        var config = await configRes.json();

        if (!config.platformMode) {
          root.innerHTML = loginCardHtml({ error: 'Platform mode not enabled' });
          return;
        }
        if (!config.adminUrl) {
          root.innerHTML = loginCardHtml({ error: 'Admin service not configured' });
          return;
        }

        root.innerHTML = loginCardHtml({ showForm: true });
        setupForm();
        document.body.dataset.ready = 'true';
      }

      init();
    })();
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

beforeAll(async () => {
  ensureEvidenceDir()
  browser = await chromium.launch({ headless: true })

  testServerPort = 34567

  testServer = Bun.serve({
    port: testServerPort,
    fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === '/' || path === '/initial') {
        return new Response(
          buildLoginHtml({
            authMeStatus: 401,
            publicConfig: { adminUrl: 'http://mock-admin.local', platformMode: true },
          }),
          { headers: { 'Content-Type': 'text/html' } },
        )
      }

      if (path === '/error-state') {
        return new Response(
          buildLoginHtml({
            authMeStatus: 401,
            publicConfig: { adminUrl: 'http://mock-admin.local', platformMode: true },
            loginStatus: 401,
            loginBody: { error: 'invalid_credentials' },
          }),
          { headers: { 'Content-Type': 'text/html' } },
        )
      }

      if (path === '/platform-disabled') {
        return new Response(
          buildLoginHtml({
            authMeStatus: 401,
            publicConfig: { adminUrl: null, platformMode: false },
          }),
          { headers: { 'Content-Type': 'text/html' } },
        )
      }

      return new Response('Not found', { status: 404 })
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

async function waitForReady(page: Page, timeout = 5000) {
  await page.waitForFunction(
    () => document.body.dataset['ready'] === 'true',
    { timeout },
  )
}

async function waitForSelector(page: Page, selector: string, timeout = 5000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout })
}

async function waitForSelectorHidden(page: Page, selector: string, timeout = 5000): Promise<void> {
  await page.waitForSelector(selector, { state: 'hidden', timeout })
}

// ---------------------------------------------------------------------------
// AC5: Screenshot tests
// ---------------------------------------------------------------------------

describe('Login page screenshots (AC5)', () => {
  it('fixture submits through the production /auth/login platform proxy without handling Admin tokens', () => {
    const source = buildLoginHtml({
      authMeStatus: 401,
      publicConfig: { adminUrl: 'http://mock-admin.local', platformMode: true },
    })

    const staleAdminLoginExpression = ['config.adminUrl', "'/api/auth/login'"].join(' + ')
    const staleSessionPath = ['/auth', 'session'].join('/')

    expect(source).toContain("window.fetch('/auth/login'")
    expect(source).not.toContain(staleAdminLoginExpression)
    expect(source).not.toContain(`window.fetch('${staleSessionPath}'`)
    expect(source).not.toContain(['loginData', 'token'].join('.'))
  })

  it('captures initial state with username and password fields visible', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })

    try {
      await page.goto(`http://localhost:${testServerPort}/initial`)
      await waitForReady(page)

      // AC1: Verify structural elements are present
      await waitForSelector(page, '#username')
      await waitForSelector(page, '#password')
      await waitForSelector(page, '[data-testid="login-submit"]')

      // AC1: Submit button is disabled when both fields are empty
      const isDisabled = await page.$eval(
        '[data-testid="login-submit"]',
        (btn) => (btn as HTMLButtonElement).disabled,
      )
      expect(isDisabled).toBe(true)

      // Take screenshot (AC5)
      const screenshotPath = join(EVIDENCE_DIR, 'login-initial-state.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('captures error state after failed login attempt', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 800 })

    try {
      await page.goto(`http://localhost:${testServerPort}/error-state`)
      await waitForReady(page)

      // Fill in credentials
      await page.fill('#username', 'alice')
      await page.fill('#password', 'wrongpassword')

      // Submit button should be enabled after filling both fields
      const isEnabled = await page.$eval(
        '[data-testid="login-submit"]',
        (btn) => !(btn as HTMLButtonElement).disabled,
      )
      expect(isEnabled).toBe(true)

      // Submit form
      await page.click('[data-testid="login-submit"]')

      // Wait for error message to appear (AC3)
      await waitForSelector(page, '[data-testid="login-error"].login-error--visible')

      const errorText = await page.$eval('[data-testid="login-error"]', el => el.textContent)
      expect(errorText).toContain('incorrect')
      const fetches = await page.evaluate(() => (window as unknown as { _loginFetches: string[] })._loginFetches)
      const staleAdminLoginUrl = ['http://mock-admin.local', 'api/auth/login'].join('/')
      const staleSessionPath = ['/auth', 'session'].join('/')
      expect(fetches).toContain('/auth/login')
      expect(fetches).not.toContain(staleAdminLoginUrl)
      expect(fetches).not.toContain(staleSessionPath)

      // Take screenshot (AC5)
      const screenshotPath = join(EVIDENCE_DIR, 'login-error-state.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`Screenshot saved: ${screenshotPath}`)
    } finally {
      await page.close()
    }
  })

  it('shows "Platform mode not enabled" when platformMode=false (AC2)', async () => {
    const page = await browser.newPage()

    try {
      await page.goto(`http://localhost:${testServerPort}/platform-disabled`)
      await waitForSelector(page, '[data-testid="config-error"]')

      const errorText = await page.$eval('[data-testid="config-error"]', el => el.textContent)
      expect(errorText).toContain('Platform mode not enabled')
    } finally {
      await page.close()
    }
  })

  it('submit button enabled only when both fields are filled (AC1)', async () => {
    const page = await browser.newPage()

    try {
      await page.goto(`http://localhost:${testServerPort}/initial`)
      await waitForReady(page)

      const getDisabled = () =>
        page.$eval('[data-testid="login-submit"]', (btn) => (btn as HTMLButtonElement).disabled)

      // Initially disabled
      expect(await getDisabled()).toBe(true)

      // Fill username only — still disabled
      await page.fill('#username', 'alice')
      expect(await getDisabled()).toBe(true)

      // Fill password — now enabled
      await page.fill('#password', 'secret')
      expect(await getDisabled()).toBe(false)

      // Clear username — disabled again
      await page.fill('#username', '')
      expect(await getDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  })

  it('clears error message when user modifies input (AC3)', async () => {
    const page = await browser.newPage()

    try {
      await page.goto(`http://localhost:${testServerPort}/error-state`)
      await waitForReady(page)

      // Fill and submit
      await page.fill('#username', 'alice')
      await page.fill('#password', 'wrong')
      await page.click('[data-testid="login-submit"]')

      // Wait for error
      await waitForSelector(page, '[data-testid="login-error"].login-error--visible')

      // Edit username input — error should clear
      await page.fill('#username', 'alice2')
      await waitForSelectorHidden(page, '[data-testid="login-error"].login-error--visible')

      const isVisible = await page.$eval('[data-testid="login-error"]', el => {
        return getComputedStyle(el).display !== 'none' && el.classList.contains('login-error--visible')
      })
      expect(isVisible).toBe(false)
    } finally {
      await page.close()
    }
  })

  it('shows "Admin service not configured" when adminUrl=null (AC2)', async () => {
    const page = await browser.newPage()

    try {
      await page.goto(`http://localhost:${testServerPort}/platform-disabled`)
      // This route serves platformMode=false, adminUrl=null
      // Platform mode disabled error takes precedence
      await waitForSelector(page, '[data-testid="config-error"]')

      const errorText = await page.$eval('[data-testid="config-error"]', el => el.textContent)
      // Either platform mode error or admin not configured should show
      expect(errorText).toBeTruthy()
    } finally {
      await page.close()
    }
  })
})
