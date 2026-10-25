/** Real browser trajectories. Model/billing authority is explicit in evidence.json. */
import { app } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { BrowserPaneManager } from '../../src/main/browser-pane-manager'
// @ts-expect-error pinned historical P1 runtime is materialized only by this runner.
import { executeBrowserToolCommand, formatSnapshotText } from '__poo113_p1_runtime__'
import { createBrowserFastDecider, type FastDeciderResult } from '@polo-ai/shared/agent/browser-fast-decider'
import type { BrowserPaneFns } from '@polo-ai/shared/agent/browser-tools'
import { adminNewApiConnection } from '@polo-ai/shared/config/__fixtures__/admin-newapi'
import { AdminClient } from '@polo-ai/shared/admin'
import { AssistantBillingCoordinator } from '../../../../packages/server-core/src/runtime/assistant-billing'
import { BillingOutbox } from '@polo-ai/shared/admin/billing-outbox'
import type { ManagedBillingHooks } from '@polo-ai/shared/credentials/managed-billing-observation'
// @ts-expect-error exact baseline is materialized by the runner, never imported by the product.
import { createBrowserFastDecider as createBefore } from '__poo113_baseline__'

// @ts-expect-error exact baseline method is materialized only by this test runner.
import { BrowserCDP as BeforeCDP } from '__poo113_baseline_cdp__'

const out = process.env.POO113_EVIDENCE_DIR!
mkdirSync(out, { recursive: true })
const rows: unknown[] = [], receipts: unknown[] = [], admissions: unknown[] = [], providerCalls: unknown[] = [], settlements: unknown[] = []
const failures: string[] = []
const live = process.env.POO113_MANAGED_INPUT ? JSON.parse(readFileSync(process.env.POO113_MANAGED_INPUT, 'utf8')) : null
const names = ['项目', '报表', '日程', '联系人', '笔记', '订单草稿', '商品草稿', '收藏', '工单草稿', '标签', '邮件草稿', '设置草稿']
const caseLimit = Math.min(names.length, Math.max(1, Number(process.env.POO113_CASE_LIMIT ?? names.length)))
let attemptedTrajectories = 0
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
function page(n: number) {
  const name = names[n]!
  return `<!doctype html><meta charset="utf-8"><title>POO-113 ${name}轨迹</title><style>body{font:18px system-ui;padding:36px;background:#fafafa}button,input,select{font:inherit;padding:10px;margin:10px}pre{white-space:pre-wrap;background:#eef2f7;padding:18px;font:14px monospace}#evidence{border-top:1px solid #ccc;margin-top:30px}h1{font-size:25px}</style>
  <h1>POO-113 内置浏览器测试 · ${name}</h1><p>隔离 fixture · tester · trajectory-${n + 1}</p><nav><a href="#guide">目录说明</a> · <a href="#help">帮助中心</a> · <a href="#privacy">隐私说明</a></nav><main id="main"></main><section id="evidence"></section>
  <script>window.state={phase:'list',value:'',category:'one',writes:0};function render(){const s=window.state;document.querySelector('#main').innerHTML=s.phase==='list'?'<button id="open">查看${name}详情</button>':s.phase==='detail'?'<label>${name}名称<input id="value" value="'+s.value+'"></label><label>${name}分类<select id="category"><option value="one">第一类</option><option value="two">第二类</option></select></label><button id="preview">预览${name}</button>':'<p>预览：'+s.value+' / '+s.category+'</p><button id="save">保存${name}</button><button id="back">返回列表</button>';document.querySelector('#open')?.addEventListener('click',()=>{s.phase='detail';render()});document.querySelector('#value')?.addEventListener('input',e=>s.value=e.target.value);document.querySelector('#category')?.addEventListener('change',e=>s.category=e.target.value);document.querySelector('#preview')?.addEventListener('click',()=>{s.phase='preview';render()});document.querySelector('#save')?.addEventListener('click',()=>{s.writes++});document.querySelector('#back')?.addEventListener('click',()=>{s.phase='list';render()})};render()</script>`
}
function controlledCommand(body: any) {
  const prompt = String(body.messages.at(-1)?.content)
  const substep = prompt.split('## 主模型规划的当前子步骤\n')[1]?.split('\n')[0] ?? ''
  const target = /「([^」]+)」/.exec(substep)?.[1]
  const line = prompt.split('\n').find(l => l.includes(`"${target}"`)) ?? ''
  const ref = /@e\d+/.exec(line)?.[0]
  if (!ref) return 'fail: target missing'
  if (substep.startsWith('输入')) return `fill ${ref} ${/值「([^」]+)」/.exec(substep)?.[1]}`
  if (substep.startsWith('选择')) return `select ${ref} 第二类`
  return `click ${ref}`
}
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/case/')) { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(page(Number(req.url.split('/').at(-1)))); return }
  if (req.url === '/v1/chat/completions' && !live) {
    let text = ''; for await (const c of req) text += c
    const body = JSON.parse(text), command = controlledCommand(body)
    providerCalls.push({ model: body.model, command, path: req.url, correlated: typeof req.headers['x-polo-request-id'] === 'string' })
    res.writeHead(200, { 'content-type': 'application/json', 'x-oneapi-request-id': `controlled-${providerCalls.length}` })
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: command } }], usage: { prompt_tokens: 50, completion_tokens: 6 } })); return
  }
  res.writeHead(404); res.end()
})
function check(value: unknown, label: string) { if (!value) failures.push(label) }
let drainDecider: (() => Promise<void>) | undefined
async function main() {
  app.setPath('userData', process.env.POO113_PROFILE_DIR!)
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND')
  for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag)
  await app.whenReady(); app.dock?.hide?.()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const { apiKey: _key, ...fixtureConnection } = adminNewApiConnection('trajectory', `${origin}/v1`, ['deepseek-flash', 'glm-5.3-flash'])
  const connection = live?.connection ?? { ...fixtureConnection, managedBy: 'admin', createdAt: 1 }
  const credential = live?.apiKey ?? 'controlled-private-key'
  let billing: ManagedBillingHooks
  if (live) {
    if (!live.accessToken || !live.adminUrl || !live.accountId || !live.productSpaceId) throw new Error('Live mode requires authenticated Admin billing, not a standalone key')
    const client = new AdminClient(live.adminUrl), token = live.accessToken
    const options = () => ({ signal: AbortSignal.timeout(5000) })
    const coordinator = new AssistantBillingCoordinator(new BillingOutbox(join(out, 'billing-journal')), () => ({
      start: (_, input) => client.startAssistantRun(token, input, options()),
      admit: (_, id, input) => client.admitAppRequest(token, id, input, options()),
      report: async (_, input) => { const r = await client.recordAppUsage(token, input, options()); settlements.push(r); return r },
      inspect: (_, id, rid) => client.getAppRequest(token, id, rid, options()),
      finish: (_, id, input) => client.finishAppRun(token, id, input, options()),
    }))
    billing = coordinator.hooks({ subjectKind: 'polo_assistant', adminOrigin: live.adminUrl, accountId: live.accountId, productSpaceId: live.productSpaceId }, () => true)
  } else {
    billing = { beforeSend: async () => ({ providerCorrelation: { header: 'X-Polo-Request-Id', nonce: crypto.randomUUID().replaceAll('-', '') }, assertCurrent() {}, complete: async () => {} }) }
  }
  const observed: ManagedBillingHooks = { beforeSend: async facts => {
    const admission: any = { model: facts.model, transportBaseUrl: facts.transportBaseUrl }
    admissions.push(admission)
    let lease: Awaited<ReturnType<typeof billing.beforeSend>>
    try { lease = await billing.beforeSend(facts); admission.status = 'admitted' }
    catch (e: any) { admission.status = 'rejected'; admission.errorCode = e.errorCode ?? e.code ?? 'unknown'; admission.httpStatus = e.status; throw e }
    return { ...lease, complete: async result => { receipts.push(result); await lease.complete(result) } }
  } }
  const decider = createBrowserFastDecider({ resolveTransport: async () => ({ connection, billing: observed, assertCurrent() {} }), resolveApiKey: async () => credential,
    getConfig: () => ({ enabled: true, timeoutMs: Number(process.env.POO113_TIMEOUT_MS ?? 3000) }) })
  drainDecider = () => decider.dispose()
  const before = createBefore({ getConfig: () => ({ enabled: true, paths: [], timeoutMs: 3000 }), resolveApiKey: async () => credential })
  const bpm = new BrowserPaneManager()
  bpm.setWindowManager({ getAllWindows: () => [], getFocusedWindow: () => null, trackWindow() {}, untrackWindow() {} } as never)
  const id = await bpm.createForSessionAsync('poo113-managed-trajectory', { show: false })
  bpm.windowResize(id, 1100, 850)
  // CDP keyboard delivery needs a painted native view on macOS.
  bpm.focus(id)
  const fns = {
    releaseControl: async () => { bpm.clearAgentControlForInstance(id); bpm.focus(id); return { action: 'released', affectedIds: [id] } },
    scroll: (direction: 'up'|'down'|'left'|'right', amount: number) => bpm.scroll(id, direction, amount),
    sendKey: (args: any) => bpm.sendKey(id, args),
    evaluate: (expression: string) => bpm.evaluate(id, expression), detectChallenge: () => bpm.detectSecurityChallenge(id),
    snapshot: () => bpm.getAccessibilitySnapshot(id), click: (ref: string) => bpm.clickElement(id, ref),
    fill: (ref: string, value: string) => bpm.fillElement(id, ref, value), select: (ref: string, value: string) => bpm.selectOption(id, ref, value),
  } as unknown as BrowserPaneFns
  let last: FastDeciderResult | undefined
  const run = async (command: string, useBefore = false) => executeBrowserToolCommand({ command, fns, sessionId: 'poo113-managed-trajectory',
    getFastDecider: () => useBefore ? before : async input => { last = await decider(input); return last } })
  async function shot(side: string, output: string, select = false) {
    const selector = select ? '#preview' : '#open'
    const expectedState = select ? '预览项目' : '查看项目详情'
    await bpm.evaluate(id, `document.querySelector('#evidence').innerHTML=${JSON.stringify('<h2>真实 browser_tool 输出（测试展示区）</h2><pre>' + esc(output) + '</pre>')}`)
    const observe = () => bpm.evaluate(id, `({title:document.querySelector('h1').innerText,identity:document.querySelector('body>p').innerText,state:document.querySelector(${JSON.stringify(selector)}).innerText,output:document.querySelector('#evidence pre').innerText,url:location.href,width:innerWidth,height:innerHeight})`) as Promise<any>
    const observed = await observe()
    if (!observed.identity.includes('trajectory-1') || !observed.state.includes(expectedState) || observed.output !== output) throw new Error('Capture scene mismatch')
    await bpm.evaluate(id, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))`)
    const s = await bpm.screenshot(id, { format: 'png' })
    if (JSON.stringify(await observe()) !== JSON.stringify(observed)) throw new Error('Capture scene changed')
    const scene = { source_ref: side.endsWith('before') ? '253781a3d2712f2a17f47bf91c1ac2fb73f2a71c' : process.env.POO113_SOURCE_REF,
      object: select ? 'POO-113 原生分类选择' : 'POO-113 项目详情定位', state: select ? 'detail-after-select-label' : 'list-before-action', role: 'tester', data: 'trajectory-1', viewport: [observed.width, observed.height],
      identity: { fixture: 'trajectory-1', actor: 'tester', title: 'POO-113 内置浏览器测试 · 项目' } }
    const checks = { fixture: { selector: 'body>p', expected: 'trajectory-1', observed: observed.identity }, actor: { selector: 'body>p', expected: 'tester', observed: observed.identity }, title: { selector: 'h1', expected: scene.identity.title, observed: observed.title } }
    const receipt = { schema_version: 1, captured_at: new Date().toISOString(), url: observed.url, scene,
      image: { sha256: createHash('sha256').update(s.imageBuffer).digest('hex'), width: s.imageBuffer.readUInt32BE(16), height: s.imageBuffer.readUInt32BE(20), device_scale_factor: 1, full_page: false },
      identity_checks: checks, state_checks: [{ selector, expected: expectedState, observed: observed.state }, { selector: '#evidence pre', expected: output, observed: observed.output }],
      note: 'Real Electron BrowserPaneManager screenshot, CSS-pixel scaling; fixture includes actual browser_tool text, not the Polo chat UI.' }
    writeFileSync(join(out, `${side}.png`), s.imageBuffer)
    writeFileSync(join(out, `${side}.capture.json`), JSON.stringify(receipt, null, 2))
    await bpm.evaluate(id, `document.querySelector('#evidence').innerHTML=''`)
  }
  // Run the exact old/new native-select methods against the same real page.
  for (const side of ['select-before', 'select-after']) {
    try { await bpm.navigate(id, `${origin}/case/0`) }
    catch (error) { if (!String(error).includes('about:blank')) throw error; await bpm.navigate(id, `${origin}/case/0`) }
    await bpm.waitFor(id, { kind: 'selector', value: '#open', timeoutMs: 3000 })
    await bpm.evaluate(id, `document.querySelector('#open').click()`)
    const snapshot = formatSnapshotText(await fns.snapshot()).join('\n')
    const ref = /(@e\d+) \[combobox\]/.exec(snapshot)![1]!
    let outcome = '成功'
    try {
      if (side.endsWith('before')) await BeforeCDP.prototype.selectOption.call((bpm as any).instances.get(id).cdp, ref, '第二类')
      else await fns.select(ref, '第二类')
    } catch { outcome = '失败：未匹配选项' }
    const selected = await bpm.evaluate(id, `document.querySelector('#category').value`)
    check(side.endsWith('before') ? selected === '' : selected === 'two', `${side} native label regression`)
    await shot(side, `输入：select ${ref} 第二类\n执行结果：${outcome}\n实际选中值：${JSON.stringify(selected)}`, true)
  }
  for (let n = 0; n < caseLimit; n++) {
    attemptedTrajectories++
    const name = names[n]!, value = `Run-${String(n + 1).padStart(2, '0')}`
    try { await bpm.navigate(id, `${origin}/case/${n}`) }
    catch (error) {
      // The raw toolbar shell's startup fallback can race the first load.
      // Recover only that known about:blank failure, then prove fixture load.
      if (n !== 0 || !String(error).includes("about:blank")) throw error
      await bpm.navigate(id, `${origin}/case/${n}`)
    }
    await bpm.waitFor(id, { kind: 'selector', value: '#open', timeoutMs: 3000 })
    bpm.focus(id)
    const paintDeadline = Date.now() + 5000
    while (!bpm.getBrowserWindows()[0]!.isVisible() && Date.now() < paintDeadline) await new Promise(r => setTimeout(r, 50))
    const steps = [`点击「查看${name}详情」`, `输入「${name}名称」值「${value}」`, `选择「${name}分类」为第二类`, `点击「预览${name}」`, `点击「保存${name}」`]
    for (let k = 0; k < steps.length; k++) {
      const snapshot = formatSnapshotText(await fns.snapshot()).join('\n')
      const stateBefore = await bpm.evaluate(id, 'JSON.stringify(window.state)')
      if (n === 0 && k === 0) await shot('before', (await run(`suggest ${steps[k]}`, true)).output)
      if (k === 2) {
        const selectRef = /(@e\d+) \[combobox\]/.exec(snapshot)?.[1]
        if (!selectRef) throw new Error('Fixture select missing')
        let rejected = false
        try { await run(`select ${selectRef} 不存在的分类`) } catch { rejected = true }
        check(rejected && await bpm.evaluate(id, 'JSON.stringify(window.state)') === stateBefore, `${n + 1} invalid option preserves form state`)
      }
      const started = Date.now(), result = await run(`suggest ${steps[k]}`), elapsedMs = Date.now() - started
      check(await bpm.evaluate(id, 'JSON.stringify(window.state)') === stateBefore, `${n + 1}/${k + 1} suggestion is read-only`)
      if (n === 0 && k === 0) await shot('after', result.output)
      const command = last?.suggestedCommand
      const row: any = { trajectory: n + 1, step: k + 1, substep: steps[k], snapshot, result: last, output: result.output, elapsedMs, stateBefore }
      rows.push(row)
      if (!command) { failures.push(`${n + 1}/${k + 1} no suggestion`); break }
      if (k === 4) {
        check(last?.dangerous === true, `${n + 1} save marked dangerous`)
        check(await bpm.evaluate(id, 'window.state.writes') === 0, `${n + 1} no save executed`)
      } else {
        await run(command)
        const state: any = await bpm.evaluate(id, 'window.state')
        row.stateAfter = state
        const ok = k === 0 ? state.phase === 'detail' : k === 1 ? state.value === value : k === 2 ? state.category === 'two' : state.phase === 'preview'
        check(ok, `${n + 1}/${k + 1} action effect`)
        if (!ok) break
      }
    }
    console.log(`[trajectory] ${n + 1}/${names.length} ${name}; failures=${failures.length}`)
  }
}
main().catch(e => { failures.push(String(e)); console.error(e) }).finally(async () => {
  await drainDecider?.().catch(e => { failures.push(`Billing cleanup: ${String(e)}`) })
  const evidence = { scope: 'historical P1 reproduction; not current P2 authorization', runtimeBaseline: '253781a3', capturedAt: new Date().toISOString(), browser: 'real Electron BrowserPaneManager/CDP', models: live ? 'live Admin-managed models' : 'controlled HTTP responses', billing: live ? 'real AssistantBillingCoordinator/Admin API' : 'controlled admission/settlement hooks', formalAcceptance: 'not_run', autoAcceptEnabled: false, requestedTrajectoryCount: caseLimit, trajectoryCount: attemptedTrajectories, rows, admissions, receipts, settlements, providerCalls, failures }
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ rows: rows.length, admissions: admissions.length, receipts: receipts.length, failures }))
  server.closeAllConnections(); server.close(); app.exit(failures.length ? 1 : 0)
})
