/**
 * POO-162 primitives render harness main: opens a real window, keyboard-drives
 * the production menu → submenu → WorkbenchSelect open states, asserts the
 * submenu portal renders inside the viewport (sideOffset +4 default must not
 * clip) and captures screenshots of every state.
 */
import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const here = __dirname
const build = process.env.POO162_BUILD_DIR ?? '/tmp/poo162-primitives-render'
const evidence = process.env.POO162_EVIDENCE_DIR ?? join(build, 'evidence')
mkdirSync(evidence, { recursive: true })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  await app.whenReady()
  const win = new BrowserWindow({ width: 1100, height: 760, show: false })
  await win.loadFile(join(build, 'pages', 'menu.html'))
  win.show()
  const page = win.webContents
  const cmd = (c: string) => page.executeJavaScript(`window.__poo162Cmd = ${JSON.stringify(c)}`, true)
  const report = () => page.executeJavaScript('window.__poo162Report ?? null', true)

  await sleep(800)
  const results: Record<string, unknown> = {}

  // State 1: root menu open (WorkbenchMenuContent token adapter).
  await cmd('open-menu')
  await sleep(900)
  await cmd('report')
  await sleep(200)
  results.menu = await report()
  writeFileSync(join(evidence, 'state1-menu-open.png'), (await page.capturePage()).toPNG())

  // State 2: submenu open (WorkbenchMenuSubContent, sideOffset 4 default).
  await cmd('open-submenu')
  await sleep(900)
  await cmd('report')
  await sleep(200)
  results.submenu = await report()
  writeFileSync(join(evidence, 'state2-submenu-open.png'), (await page.capturePage()).toPNG())

  // State 3: WorkbenchSelect open.
  await cmd('open-select')
  await sleep(900)
  await cmd('report')
  await sleep(200)
  results.select = await report()
  writeFileSync(join(evidence, 'state3-select-open.png'), (await page.capturePage()).toPNG())

  const sub = results.submenu as { subContent?: { x: number; y: number; w: number; h: number } | null; viewport?: { w: number; h: number } } | null
  const menu = results.menu as { content?: { x: number; y: number; w: number; h: number } | null } | null
  const sel = results.select as { option?: { x: number; y: number; w: number; h: number } | null } | null

  const checks = {
    rootMenuRendered: Boolean(menu?.content && menu.content.w > 0 && menu.content.h > 0),
    subMenuRendered: Boolean(sub?.subContent && sub.subContent.w > 0 && sub.subContent.h > 0),
    subMenuInsideViewport: Boolean(
      sub?.subContent && sub.viewport
      && sub.subContent.x >= 0 && sub.subContent.y >= 0
      && sub.subContent.x + sub.subContent.w <= sub.viewport.w
      && sub.subContent.y + sub.subContent.h <= sub.viewport.h,
    ),
    selectOptionRendered: Boolean(sel?.option && sel.option.w > 0),
  }
  results.checks = checks
  writeFileSync(join(evidence, 'runtime.json'), JSON.stringify({ results, startedAt: new Date().toISOString() }, null, 2))
  const ok = Object.values(checks).every(Boolean)
  console.log(`[poo162-primitives-render] ${ok ? 'ALL PASS' : 'FAIL'}: ${JSON.stringify(checks)}`)
  app.exit(ok ? 0 : 1)
}

main().catch(err => {
  console.error('[poo162-primitives-render] fatal:', err)
  app.exit(1)
})
