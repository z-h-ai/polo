/**
 * POO-113-P1 E2E: browser_tool suggest against a REAL in-app browser window.
 *
 * Drives the real BrowserPaneManager (real Chromium via CDP) against a local
 * fixture page, then runs the production `executeBrowserToolCommand` path with
 * the `suggest` command. Fast-model paths A/B hit the real APIs with real keys
 * from the environment; when keys are absent the harness still verifies the
 * full command surface (snapshot formatting, graceful degradation, help).
 *
 * Verifies:
 *  E1  real window opens, fixture page loads via CDP
 *  E2  real accessibility snapshot (production formatSnapshotText) contains
 *      the fixture elements
 *  E3  suggest with real dual fast-model keys returns a valid executable
 *      command that grounds the sub-step (skips to degradation check without
 *      keys)
 *  E4  without a decider callback → graceful "not available" degradation
 *  E5  suggestion marked read-only (nothing executed: no click/fill happened)
 *  E6  agreement/dangerous flags present in output when suggestion exists
 *
 * Usage: bun run scripts/electron-browser-suggest-e2e.ts
 * Env:   POO113_DS_API_KEY / POO113_GLM_API_KEY (optional — real fast models)
 */
import { mkdtempSync, writeFileSync, symlinkSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'node:http'

const rootDirectory = join(import.meta.dir, '..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'polo-suggest-e2e-'))
const mainOutput = join(temporaryDirectory, 'main.cjs')
const electronExecutable = require('electron') as string

// --- Fixture page: a small settings-like form with distinct elements. ---
const FIXTURE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>账户设置 - 示例应用</title></head>
<body>
  <h1>账户设置</h1>
  <label>邮箱 <input id="email" type="text" value="" /></label>
  <label>昵称 <input id="nickname" type="text" value="" /></label>
  <button id="save">保存更改</button>
  <button id="cancel">取消</button>
  <a href="/help">帮助中心</a>
</body></html>`

async function startFixtureServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  // keep the server alive for the lifetime of the electron child; write the port
  writeFileSync(join(temporaryDirectory, 'fixture-port'), String(port))
  return port
}

async function main(): Promise<void> {
  const port = await startFixtureServer()
  const dsKey = process.env.POO113_DS_API_KEY ?? ''
  const glmKey = process.env.POO113_GLM_API_KEY ?? ''

  symlinkSync(join(rootDirectory, 'node_modules'), join(temporaryDirectory, 'node_modules'), 'dir')

  await build({
    absWorkingDir: rootDirectory,
    bundle: true,
    entryPoints: ['apps/electron/e2e/browser-suggest/main.ts'],
    external: ['electron', 'koffi'],
    format: 'cjs',
    outfile: mainOutput,
    platform: 'node',
    define: {
      'process.env.POO113_FIXTURE_URL': JSON.stringify(`http://127.0.0.1:${port}/`),
      'process.env.POO113_DS_API_KEY': JSON.stringify(dsKey),
      'process.env.POO113_GLM_API_KEY': JSON.stringify(glmKey),
    },
  })

  // BrowserPaneManager loads toolbar/empty-state from <dirname>/renderer/*.html
  // (file mode). Copy the real renderer shells next to the bundled main.
  const rendererDir = join(temporaryDirectory, 'renderer')
  mkdirSync(rendererDir, { recursive: true })
  for (const file of ['browser-toolbar.html', 'browser-empty-state.html']) {
    copyFileSync(join(rootDirectory, 'apps/electron/src/renderer', file), join(rendererDir, file))
  }

  const electron = Bun.spawn([electronExecutable, mainOutput], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      POLO_AI_DISABLE_AUTO_OPEN: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await electron.exited
  if (exitCode !== 0) {
    throw new Error(`browser suggest E2E exited with code ${exitCode}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
