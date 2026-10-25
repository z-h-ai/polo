import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendBrowserActionAudit } from '@polo-ai/shared/sessions/browser-action-audit';
/** POO-113: owned native-browser trajectories. Live/controlled model evidence is
 * deliberately separate; no real payment/message is sent to an external party. */
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPaneManager } from '../../src/main/browser-pane-manager';
import { BrowserActionAuthorization, browserActionDigest, type BrowserActionConfirmation } from '@polo-ai/shared/agent/browser-action-authorization';
import { createBrowserTools, type BrowserPaneFns } from '@polo-ai/shared/agent/browser-tools';
import { createBrowserFastDecider, type FastDeciderResult } from '@polo-ai/shared/agent/browser-fast-decider';
import { PiAgent } from '@polo-ai/shared/agent/pi-agent';
import { registerSessionScopedToolCallbacks, unregisterAllSessionScopedToolCallbacks } from '@polo-ai/shared/agent/session-scoped-tool-callback-registry';
import { defaultBrowserPolicy } from '@polo-ai/shared/admin/browser-policy-contract';
import { adminNewApiConnection } from '@polo-ai/shared/config/__fixtures__/admin-newapi';
import { AdminClient } from '@polo-ai/shared/admin';
import { AssistantBillingCoordinator } from '../../../../packages/server-core/src/runtime/assistant-billing';
import { BillingOutbox } from '@polo-ai/shared/admin/billing-outbox';
import type { ManagedBillingHooks } from '@polo-ai/shared/credentials/managed-billing-observation';
import { SessionManager, createManagedSession } from '../../../../packages/server-core/src/sessions/SessionManager';
import { registerSessionsHandlers } from '../../../../packages/server-core/src/handlers/rpc/sessions';
import { setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } from '../../../../packages/server-core/src/runtime/product-space-executions';
import { setSyncTrustedProductSpaceAccountId, setTrustedProductSpaceAccountProvider } from '../../../../packages/server-core/src/handlers/rpc/trusted-product-space-account';
import { RPC_CHANNELS } from '@polo-ai/shared/protocol';
const out = process.env.POO113_EVIDENCE_DIR!;
const live = process.env.POO113_MANAGED_INPUT ? JSON.parse(readFileSync(process.env.POO113_MANAGED_INPUT, 'utf8')) : null;
const rows: unknown[] = [], failures: string[] = [], models: unknown[] = [], settlements: unknown[] = [];
const sid = 'poo113-browser-authorization';
const titles = ['项目', '报表', '日程', '联系人', '笔记', '收藏', '订单', '消息', '文件', '自动保存', '页面变化', '取消恢复'];
let modelMode = 'agree';
let pendingRequest: BrowserActionConfirmation | undefined;
let respondOnHost: ((requestId: string, allowed: boolean, digest: string, alwaysAllow?: boolean, session?: string) => Promise<boolean>) | undefined;
function page(n: number) { return `<!doctype html><meta charset="utf-8"><title>POO-113 ${titles[n]}</title><style>body{font:18px system-ui;padding:30px}button,input,select,textarea{font:inherit;padding:8px;margin:8px}form{padding:20px;border:1px solid #ccc}</style><h1>POO-113 原生浏览器 · ${titles[n]}</h1><p>独立受控对象 case-${n + 1} · tester</p><button id="details" onclick="document.querySelector('#detail').hidden=false;window.opens++">打开${titles[n]}详情</button><section id="detail" hidden><label>搜索<input aria-label="搜索内容" id="query"></label><button id="search" onclick="window.searches++;document.querySelector('#result').textContent=document.querySelector('#query').value">搜索结果</button><p id="result"></p><label>分类<select aria-label="报表分类" id="category"><option value="one">第一类</option><option value="two">第二类</option></select></label><button type="button" id="next" onclick="window.pages++">下一页</button><button type="button" id="expand" onclick="window.expanded++">展开联系信息</button><a href="#note-preview">预览笔记</a><form onsubmit="event.preventDefault();window.writes++"><input name="orderId" value="ORD-${n + 1}" readonly><input name="objectId" value="OBJ-${n + 1}" readonly><input name="recipient" value="Alice" readonly><input name="amount" value="100" readonly><input name="currency" value="CNY" readonly><textarea name="content">${n===7?"您好，方案已按今天的讨论调整。请查阅交付范围与时间，确认各项安排。\n感谢您的配合，我们会在收到确认后继续推进。":"hello world"}</textarea><button id="danger" type="submit">${n === 7 ? '发送消息' : n === 8 ? '删除对象' : '支付订单'}</button></form><div style="margin-top:1000px"><button type="button" id="bottom" onclick="window.bottom++">打开收藏底部详情</button></div><input aria-label="自动保存" id="autosave"></section><script>window.opens=0;window.searches=0;window.writes=0;window.pages=0;window.expanded=0;window.bottom=0;document.querySelector('#autosave').addEventListener('input',()=>window.writes++)</script>`; }
function commandFrom(body: any) {
    const text = String(body.messages.at(-1)?.content);
    const step = text.split('## 主模型规划的当前子步骤\n')[1]?.split('\n')[0] ?? '';
    const label = /「([^」]+)」/.exec(step)?.[1];
    const line = text.split('\n').find(l => l.includes('"' + label + '"')) ?? '';
    const ref = /@e\d+/.exec(line)?.[0];
    if (!ref)
        return 'fail: missing target';
    return step.startsWith('输入') ? `fill ${ref} search-${/值「([^」]+)」/.exec(step)?.[1] ?? 'owned'}` : `click ${ref}`;
}
const server = createServer(async (req, res) => {
    if (req.url === '/permission-ui') {
        const css = readdirSync(process.env.POO113_RENDERER_CSS_DIR!).filter(name => name.endsWith('.css')).map(name => readFileSync(join(process.env.POO113_RENDERER_CSS_DIR!, name), 'utf8')).join('\n');
        res.setHeader('content-type', 'text/html;charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + 'html,body,#root{margin:0;min-height:100vh}</style><div id="root"></div><script src="/permission-renderer.js"></script>');
        return;
    }
    if (req.url === '/permission-renderer.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(readFileSync(process.env.POO113_PERMISSION_RENDERER!));
        return;
    }
    if (req.url === '/permission') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(pendingRequest ? { ...pendingRequest, sessionId: sid, toolName: 'browser_tool', type: 'browser_action' } : null));
        return;
    }
    if (req.url === '/permission/respond') {
        let raw = '';
        for await (const c of req)
            raw += c;
        const response = JSON.parse(raw);
        const accepted = await respondOnHost!(response.requestId, response.allowed, response.browserActionDigest, response.alwaysAllow);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ accepted }));
        return;
    }
    if(req.url==='/zoom-case'){res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><style>button{position:absolute;width:100px;height:50px}#target{left:200px;top:200px}#other{left:125px;top:125px}</style><button id="target" onclick="window.zoomTarget++">打开缩放详情</button><button id="other" onclick="window.writes++">支付订单</button><script>window.zoomTarget=0;window.writes=0;window.opens=1;window.searches=0</script>`);return}
    if (req.url?.startsWith('/case/')) {
        res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        res.end(page(Number(req.url.split('/').at(-1))));
        return;
    }
    if (req.url === '/v1/chat/completions' && !live) {
        let raw = '';
        for await (const chunk of req)
            raw += chunk;
        const body = JSON.parse(raw);
        const command = commandFrom(body);
        models.push({ model: body.model, command });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: command } }], usage: { prompt_tokens: 50, completion_tokens: 6 } }));
        return;
    }
    res.writeHead(404);
    res.end();
});
const assert = (condition: unknown, message: string) => {
    if (!condition)
        throw Error(message);
};
async function main() {
    app.setPath('userData', process.env.POO113_PROFILE_DIR!);
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND');
    for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'])
        app.commandLine.appendSwitch(flag);
    await app.whenReady();
    app.dock?.hide?.();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const bpm = new BrowserPaneManager();
    bpm.setWindowManager({ getAllWindows: () => [], getFocusedWindow: () => null, trackWindow() { }, untrackWindow() { } } as never);
    const id = await bpm.createForSessionAsync(sid, { show: false });
    bpm.windowResize(id, 1100, 850);
    bpm.focus(id);
    for (let wait = 0; wait < 600; wait++) {
        if ((await bpm.getInstanceAsync(id))?.isVisible)
            break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert((await bpm.getInstanceAsync(id))?.isVisible, 'native browser not visibly ready');
    const { apiKey: _unused, ...fixtureConnection } = adminNewApiConnection('authorization', origin + '/v1', ['deepseek-flash', 'glm-5.3-flash']);
    let billing: ManagedBillingHooks = { beforeSend: async () => ({ providerCorrelation: { header: "X-Polo-Request-Id", nonce: crypto.randomUUID().replaceAll("-", "") }, assertCurrent() { }, complete: async () => { } }) };
    const client = live ? new AdminClient(live.adminUrl) : undefined;
    if (live) {
        const options = () => ({ signal: AbortSignal.timeout(5000) });
        const coordinator = new AssistantBillingCoordinator(new BillingOutbox(join(out, 'billing-journal')), () => ({ start: (_, i) => client!.startAssistantRun(live.accessToken, i, options()), admit: (_, rid, i) => client!.admitAppRequest(live.accessToken, rid, i, options()), report: async (_, i) => { const r = await client!.recordAppUsage(live.accessToken, i, options()); settlements.push(r); return r; }, inspect: (_, rid, requestId) => client!.getAppRequest(live.accessToken, rid, requestId, options()), finish: (_, rid, i) => client!.finishAppRun(live.accessToken, rid, i, options()) }));
        billing = coordinator.hooks({ subjectKind: 'polo_assistant', adminOrigin: live.adminUrl, accountId: live.accountId, productSpaceId: live.productSpaceId }, () => true);
    }
    const decider = createBrowserFastDecider({ resolveTransport: async () => ({ connection: live?.connection ?? { ...fixtureConnection, managedBy: 'admin', createdAt: 1 }, billing, assertCurrent() { } }), resolveApiKey: async () => live?.apiKey ?? 'owned-controlled-credential', getConfig: () => ({ enabled: true, timeoutMs: Number(process.env.POO113_TIMEOUT_MS ?? 3000) }) });
    const space = live?.productSpaceId ?? '11111111-1111-4111-8111-111111111111';
    let generation = 1;
    let users = [{ id: 'human', text: '查看项目' }];
    let disposition = 'allow';
    let request: BrowserActionConfirmation | undefined;
    let abort = new AbortController();
    let policyVersion = 1;
    let beforeDispatch: undefined | (() => Promise<void>);
    let loseAck = false;
    const scope = () => ({ accountId: live?.accountId ?? 'owned-account', productSpaceId: space, sessionId: sid, generation });
    const policy = async () => {
        if (live)
            return client!.getBrowserPolicy(live.accessToken, space, { signal: AbortSignal.timeout(5000) });
        const p = { ...defaultBrowserPolicy(), autoAcceptEnabled: true };
        return { productSpaceId: space, configVersion: String(policyVersion), policy: p, policyDigest: browserActionDigest(p) };
    };
    const host = new SessionManager() as any;
    const workspaceId = 'poo113-e2e-owned-workspace';
    setSyncTrustedProductSpaceAccountId(scope().accountId);
    setRuntimeActiveProductSpaceAccount(scope().accountId);
    setRuntimeActiveProductSpace(space);
    setTrustedProductSpaceAccountProvider(async () => scope().accountId);
    host.sessions.set(sid, createManagedSession({ id: sid, createdAt: Date.now() }, { id: workspaceId, name: 'Owned', rootPath: process.env.POO113_PROFILE_DIR!, createdAt: 1 } as never, { accountId: scope().accountId, productSpaceId: space }));
    const handlers = new Map<string, Function>();
    registerSessionsHandlers({ handle: (channel: string, fn: Function) => handlers.set(channel, fn) } as never, { sessionManager: host, platform: { logger: { info() { }, warn() { }, error() { }, debug() { } } } } as never);
    respondOnHost = async (requestId, allowed, digest, alwaysAllow = false, session = sid) => handlers.get(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION)!({ clientId: 'owned-renderer', workspaceId }, session, requestId, allowed, alwaysAllow, { browserActionDigest: digest, browserActionPhase: 'awaiting_authorization' });
    const ui = new BrowserWindow({ width: 800, height: 600, show: false, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const captureRenderer=async(name:string,width:number,height:number)=>{
        const requestId=pendingRequest!.requestId;
        ui.setContentSize(width,height);
        await ui.loadURL(origin+'/permission-ui');
        for(let i=0;i<100;i++){if(await ui.webContents.executeJavaScript('document.querySelector("[data-request-id]")?.dataset.requestId')===requestId)break;await new Promise(r=>setTimeout(r,20))}
        assert(await ui.webContents.executeJavaScript('document.querySelector("[data-request-id]")?.dataset.requestId')===requestId,'production renderer did not receive original Host request');
        await ui.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        assert(await ui.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),'permission horizontal overflow');
        const actual=(await ui.webContents.capturePage()).toPNG();
        writeFileSync(join(out,name+'.png'),actual);
        writeFileSync(join(out,name+'.capture.json'),JSON.stringify({sourceRef:process.env.POO113_SOURCE_REF,requestId,phase:pendingRequest!.browserAction.phase,scope:scope(),viewport:{width,height,device_scale_factor:await ui.webContents.executeJavaScript('devicePixelRatio')},image:{sha256:createHash('sha256').update(actual).digest('hex'),width:actual.readUInt32BE(16),height:actual.readUInt32BE(20)},note:'Actual production permission component from an original Host authorization lifecycle; production permission RPC and SessionManager; owned fixture transport.'},null,2));
    }
    const respondViaRenderer=async(allowed:boolean,name='delete-mobile',width=390,height=844)=>{
        await captureRenderer(name,width,height);
        const label=allowed?'允许本次':'拒绝';
        await ui.webContents.executeJavaScript('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Missing production permission button");b.click()})()');
        bpm.focus(id);
    }
    const authorization = new BrowserActionAuthorization({ audit: event => appendBrowserActionAudit(join(out, 'safe-audit'), event), scope, assertCurrent: s => { assert(JSON.stringify(s) === JSON.stringify(scope()) && !abort.signal.aborted, 'scope invalidated'); }, facts: parts => bpm.inspectBrowserAction(id, parts), policy, userMessages: () => users, signal: () => abort.signal, confirm: r => {
            request = r;
            pendingRequest = r;
            host.pendingPermissionRequests.set(r.requestId, { sessionId: sid, type: 'browser_action', browserScope: r.scope, actionDigest: r.actionDigest });
            if (disposition === 'wait')
                return;
            queueMicrotask(() => { void respondOnHost!(r.requestId, disposition === 'allow', r.actionDigest); });
        },settled:(requestId,phase)=>{if(pendingRequest?.requestId===requestId)pendingRequest={...pendingRequest,browserAction:{...pendingRequest.browserAction,phase}}} });
    host.browserActionAuthorizations.set(sid, authorization);
    let last: FastDeciderResult | undefined;
    const grounding = async (input: any) => {
        if (modelMode === 'timeout')
            return { agreement: 'none', dangerous: false, paths: [{ name: 'A', error: 'timeout', latencyMs: 3000 }, { name: 'B', error: 'timeout', latencyMs: 3000 }] } as FastDeciderResult;
        const r = await decider(input);
        last = r;
        if (modelMode === 'disagree')
            return { ...r, agreement: 'none', suggestedCommand: undefined };
        return r;
    };
    const fns = { releaseControl: async () => { bpm.clearAgentControlForInstance(id); bpm.focus(id); return { action: 'released', affectedIds: [id] }; }, authorizeCommand: (parts, dispatch, context) => authorization.perform(parts, dispatch, context), readBrowserPolicy: () => authorization.readPolicy(), executeAuthorizedAction: async (parts, facts, method, args, lease) => {
            const cancel = () => bpm.cancelBrowserAction(id, lease.id);
            lease.signal?.addEventListener('abort', cancel, { once: true });
            try {
                await beforeDispatch?.();
                let result: unknown;
                try {
                    result = await bpm.executeAuthorizedAction(id, parts, facts, method, args, lease.id, lease.expiresAt);
                }
                catch (error) {
                    appendFileSync(join(out, 'native-errors.jsonl'), JSON.stringify({ method, error: String(error), geometry: method === 'click' ? await (bpm as any).instances.get(id).cdp.getElementGeometry(args[0]).catch(() => null) : null, page: await bpm.evaluate(id, '({scrollY,width:innerWidth,height:innerHeight,button:document.querySelector(\"#danger\")?.getBoundingClientRect().toJSON()})') }) + '\n');
                    throw error;
                }
                if (loseAck)
                    throw Error('controlled lost acknowledgement');
                return result;
            }
            finally {
                lease.signal?.removeEventListener('abort', cancel);
            }
        }, snapshot: () => bpm.getAccessibilitySnapshot(id), evaluate: expression => bpm.evaluate(id, expression), detectChallenge: () => bpm.detectSecurityChallenge(id), click: ref => bpm.clickElement(id, ref), fill: (ref, value) => bpm.fillElement(id, ref, value), type: text => bpm.typeText(id, text), select: (ref, value) => bpm.selectOption(id, ref, value), sendKey: args => bpm.sendKey(id, args), setClipboard: text => bpm.setClipboard(id, text), getClipboard: () => bpm.getClipboard(id), clickAt: (x, y) => bpm.clickAtCoordinates(id, x, y), navigate: url => bpm.navigate(id, url), goBack: () => bpm.goBack(id), goForward: () => bpm.goForward(id), scroll: (direction, amount) => bpm.scroll(id, direction, amount) } as BrowserPaneFns;
    registerSessionScopedToolCallbacks(sid, { browserPaneFns: fns, browserFastDecider: grounding }, "poo113-native-fixture-owner");
    const claude = createBrowserTools({ sessionId: sid, getBrowserPaneFns: () => fns, getFastDecider: () => grounding }).find((tool: any) => tool.name === 'browser_tool') as any;
    const run = async (command: string, backend: 'claude' | 'pi') => {
        if (backend === 'claude') {
            const r = await claude.handler({ command });
            const text = r.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
            return { output: text, isError: !!r.isError };
        }
        const prototype = PiAgent.prototype as any;
        const owner = { _sessionId: sid, executeSessionTool: prototype.executeSessionTool };
        const r = await prototype.routeToolCall.call(owner, 'mcp__session__browser_tool', { command });
        return { output: r.content, isError: r.isError };
    };
    const state = () => bpm.evaluate(id, '({opens:window.opens,searches:window.searches,writes:window.writes})') as Promise<any>;
    const ref = async (label: string) => { const s = await bpm.getAccessibilitySnapshot(id); const node = s.nodes.find(n => n.name === label); assert(node, 'Missing ref ' + label); return node!.ref; };
    const waitRequest = async () => {
        for (let i = 0; i < 100 && !request; i++)
            await new Promise(r => setTimeout(r, 5));
        assert(request, 'Missing confirmation');
        return request!;
    };
    for (let n = 0; n < 12; n++) {
        const backend = n % 2 === 0 ? 'claude' : 'pi';
        const steps: unknown[] = [];
        let status = 'passed';
        try {
            generation++;
            abort = new AbortController();
            users = [{ id: 'human-' + n, text: '查看' + titles[n] }];
            request = undefined;
            disposition = 'allow';
            beforeDispatch = undefined;
            loseAck = false;
            modelMode = 'agree';
            try {
                await bpm.navigate(id, origin + '/case/' + n);
            }
            catch (error) {
                const observed = await bpm.evaluate(id, 'location.href');
                if (observed !== origin + '/case/' + n)
                    throw error;
            }
            const open = await run('act 点击「打开' + titles[n] + '详情」', backend);
            steps.push({ command: 'act open details', ...open, agreement: last?.agreement, paths: last?.paths });
            if (!(await state()).opens) {
                assert(live && !open.isError, 'Controlled P2 failed to open');
                steps.push({ fallback: 'main-model planned direct command', ...await run('click ' + await ref('打开' + titles[n] + '详情'), backend) });
            }
            assert((await state()).opens === 1, 'details must open exactly once');
            if (n < 6) {
                if (n === 1) {
                    steps.push(await run('select ' + await ref('报表分类') + ' two', backend));
                    assert(await bpm.evaluate(id, "document.querySelector('#category').value") === 'two', 'report category selection failed');
                }
                if (n === 2) {
                    steps.push(await run('act 点击「下一页」', backend));
                    if (!await bpm.evaluate(id, 'window.pages'))
                        steps.push(await run('click ' + await ref('下一页'), backend));
                    assert(await bpm.evaluate(id, 'window.pages') === 1, 'schedule page did not advance once');
                }
                if (n === 3) {
                    steps.push(await run('act 点击「展开联系信息」', backend));
                    if (!await bpm.evaluate(id, 'window.expanded'))
                        steps.push(await run('click ' + await ref('展开联系信息'), backend));
                    assert(await bpm.evaluate(id, 'window.expanded') === 1, 'contact expansion failed');
                }
                if (n === 4) {
                    steps.push(await run('click ' + await ref('预览笔记'), backend));
                    assert(String(await bpm.evaluate(id, 'location.hash')) === '#note-preview', 'note preview link did not navigate');
                }
                if (n === 5) {
                    steps.push(await run('scroll down 900', backend));
                    steps.push(await run('act 点击「打开收藏底部详情」', backend));
                    if (!await bpm.evaluate(id, 'window.bottom'))
                        steps.push(await run('click ' + await ref('打开收藏底部详情'), backend));
                    assert(await bpm.evaluate(id, 'window.bottom') === 1, 'collection scroll and target failed');
                }
                const query = await ref('搜索内容');
                steps.push(await run(['fill', query, 'owned-' + n].join(' '), backend));
                steps.push(await run('act 点击「搜索结果」', backend));
                if (!(await state()).searches) {
                    assert(live, 'Controlled P2 search failed');
                    steps.push(await run('click ' + await ref('搜索结果'), backend));
                }
                assert((await state()).searches === 1, 'search result must be observable once');
                assert(await bpm.evaluate(id, "document.querySelector('#result').textContent") === 'owned-' + n, 'input/search must preserve value');
                assert((await state()).writes === 0, 'ordinary flow wrote business data');
            }
            if (n === 6) {
                disposition='wait';
                const payment=run('click '+await ref('支付订单'),backend);await waitRequest();await respondViaRenderer(false,'payment-desktop',1440,900);steps.push(await payment);disposition='deny';
                assert((await state()).writes === 0, 'denied payment wrote');
                await bpm.evaluate(id, "document.querySelector('[name=amount]').focus()");
                const point = await bpm.evaluate(id, "(()=>{const r=document.querySelector('#danger').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()") as any;
                for (const command of ['key Enter', 'key Enter control', 'click-at ' + point.x + ' ' + point.y, 'type changed', 'paste changed', 'select ' + await ref('支付订单') + ' x', 'upload ' + await ref('支付订单') + ' /tmp/owned', 'drag 1 2 3 4', 'evaluate window.writes++']) {
                    steps.push(await run(command, backend));
                    assert((await state()).writes === 0, 'alternative entry bypassed: ' + command);
                }
                ;
                request = undefined;
                disposition = 'allow';
                users = [{ id: 'pay-exact', text: '支付订单 ORD-7 给 Alice 金额100 CNY' }];
                steps.push(await run('click ' + await ref('支付订单'), backend));
                assert(!request && (await state()).writes === 1, 'exact original pay authority must execute once without prompt');
                steps.push(await run('click ' + await ref('支付订单'), backend));
                assert((await state()).writes === 1, 'retry repeated payment');
            }
            if(n===7){
                disposition='wait';loseAck=true;
                const sending=run('click '+await ref('发送消息'),backend);await waitRequest();await respondViaRenderer(true,'send-compact',800,600);steps.push(await sending);loseAck=false;
                await captureRenderer('outcome-unknown-compact',800,600);
                assert(await ui.webContents.executeJavaScript('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("允许"))')===false,'unknown result still offers permission');
                steps.push(await run('click '+await ref('发送消息'),backend));assert((await state()).writes===1,'unknown result must not resend');
            }
            if (n === 8) {
                disposition = 'wait';
                const pending = run('click ' + await ref('删除对象'), backend);
                const r = await waitRequest();
                assert(!authorization.resolve(r.requestId, { ...scope(), sessionId: 'other' }, { allowed: true, actionDigest: r.actionDigest }), 'cross-session grant consumed');
                assert(!authorization.resolve(r.requestId, scope(), { allowed: true, alwaysAllow: true, actionDigest: r.actionDigest }), 'broad grant consumed');
                authorization.resolve(r.requestId, scope(), { allowed: false, actionDigest: r.actionDigest });
                steps.push(await pending);
                assert((await state()).writes === 0, 'delete denial wrote');
                request = undefined;
                disposition = 'wait';
                const allowed = run('click ' + await ref('删除对象'), backend);
                await waitRequest();
                await respondViaRenderer(true);
                steps.push(await allowed);
                assert((await state()).writes === 1, 'production renderer/RPC allow must dispatch exactly once');
                steps.push(await run('click ' + await ref('删除对象'), backend));
                assert((await state()).writes === 1, 'renderer allowance repeated business action');
            }
            if (n === 9) {
                steps.push(await run('fill ' + await ref('自动保存') + ' changed', backend));
                assert((await state()).writes === 0, 'delegated autosave bypass');
                steps.push(await run('evaluate window.writes++', backend));
                assert((await state()).writes === 0, 'arbitrary script bypass');
                modelMode = 'disagree';
                steps.push(await run('act 点击「搜索结果」', backend));
                modelMode = 'timeout';
                steps.push(await run('act 点击「搜索结果」', backend));
                assert((await state()).searches === 0, 'disagreement/timeout acted');
            }
            if (n === 10) {
                beforeDispatch = async () => { await bpm.evaluate(id, "document.querySelector('[name=amount]').value='120'"); };
                disposition = 'allow';
                steps.push(await run('click ' + await ref('支付订单'), backend));
                assert((await state()).writes === 0, 'native final target check allowed changed amount');
                await captureRenderer('invalidated-compact',800,600);
                beforeDispatch = undefined;
                request = undefined;
                disposition = 'wait';
                const pending = run('click ' + await ref('支付订单'), backend);
                const r = await waitRequest();
                await captureRenderer('amount-current-mobile',390,844);
                await bpm.evaluate(id, "document.querySelector('[name=amount]').value='140'");
                authorization.resolve(r.requestId, scope(), { allowed: true, actionDigest: r.actionDigest });
                steps.push(await pending);
                assert((await state()).writes === 0, 'stale confirmation acted');
                request = undefined;
                disposition = 'allow';
                beforeDispatch = async () => { await bpm.evaluate(id, `(()=>{document.querySelector('#danger').scrollIntoView({block:'center'});const r=document.querySelector('#danger').getBoundingClientRect();const b=document.createElement('button');b.id='ambush';b.textContent='unapproved target';b.style.cssText='position:fixed;z-index:999999;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px;margin:0';b.onclick=()=>window.writes++;document.body.appendChild(b)})()`); };
                steps.push(await run('click ' + await ref('支付订单'), backend));
                assert((await state()).writes === 0, 'covered native landing point wrote');
                beforeDispatch = undefined;
                await bpm.evaluate(id, "document.querySelector('#ambush')?.remove()");
                request = undefined;
                disposition = 'wait';
                const policyPending = run('click ' + await ref('支付订单'), backend);
                const policyRequest = await waitRequest();
                let policyChange: unknown;
                if (live) {
                    assert(process.env.POO113_POLICY_ACTIVATOR, 'Live policy activation fixture missing');
                    const output = execFileSync('python3', [process.env.POO113_POLICY_ACTIVATOR!], { encoding: 'utf8', timeout: 60000 });
                    policyChange = JSON.parse(output.trim().split('\n').at(-1)!);
                }
                else {
                    policyVersion++;
                    policyChange = { controlledVersion: policyVersion };
                }
                await respondOnHost!(policyRequest.requestId, true, policyRequest.actionDigest);
                const policyResult = await policyPending;
                steps.push({ policyChange, ...policyResult });
                assert(policyResult.output.includes('changed before dispatch') && (await state()).writes === 0, 'authoritative activation did not invalidate the pending original permission');
                await bpm.navigate(id,origin+'/zoom-case');
                const contents=(bpm as any).instances.get(id).pageView.webContents;
                for(const [index,zoom]of [0.8,1,1.5].entries()){
                    contents.setZoomFactor(zoom);
                    await bpm.evaluate(id,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                    steps.push({zoom,...await run('click '+await ref('打开缩放详情'),backend)});
                    assert(await bpm.evaluate(id,'window.zoomTarget')===index+1&&(await state()).writes===0,'zoomed native input hit an unapproved business button');
                }
                contents.setZoomFactor(1);

            }
            if (n === 11) {
                disposition = 'wait';
                const pending = run('click ' + await ref('支付订单'), backend);
                const r = await waitRequest();
                abort.abort();
                steps.push(await pending);
                assert(!authorization.resolve(r.requestId, scope(), { allowed: true, actionDigest: r.actionDigest }), 'cancelled grant survived');
                assert((await state()).writes === 0, 'cancelled payment wrote');
                abort = new AbortController();
                disposition = 'allow';
                request = undefined;
                beforeDispatch = async () => { abort.abort(); };
                steps.push(await run('click ' + await ref('支付订单'), backend));
                assert((await state()).writes === 0, 'native cancellation tombstone failed');
                const expiredRef = await ref('支付订单');
                const expiredFacts = await bpm.inspectBrowserAction(id, ['click', expiredRef]);
                let expiredRejected = false;
                try {
                    await bpm.executeAuthorizedAction(id, ['click', expiredRef], expiredFacts, 'click', [expiredRef], crypto.randomUUID(), Date.now() - 1);
                }
                catch (error) {
                    expiredRejected = String(error).includes('expired');
                }
                assert(expiredRejected && (await state()).writes === 0, 'expired original native lease was re-armed');
            }
        }
        catch (error) {
            status = 'failed';
            failures.push('case-' + (n + 1) + ': ' + String(error));
        }
        const observed = await state();
        rows.push({ id: 'trajectory-' + (n + 1), backend, object: titles[n], status, steps, observed });
        writeFileSync(join(out, 'trajectories.json'), JSON.stringify(rows, null, 2));
        console.log(JSON.stringify({ trajectory: n + 1, backend, status, observed }));
    }
    await decider.dispose();
    authorization.cancel();
    unregisterAllSessionScopedToolCallbacks(sid);
    bpm.destroyForSession(sid);
    ui.destroy();
    host.sessions.clear();
    await new Promise<void>(r => server.close(() => r()));
    const evidence = { sourceRef: process.env.POO113_SOURCE_REF, mode: live ? 'real-managed-models' : 'controlled-model-http', boundaries: ['Actual native BrowserPaneManager and production Claude tool factory / Pi executeSessionTool adapters; not a full cloud main-model SDK conversation.', 'Owned website fixtures only; no external customer payment or send.', 'Timeout/disagreement injections are controlled and labelled; live grounding uses the configured normal timeout.'], trajectories: rows, models, settlements, failures, cleanup: { browserDestroyed: true, fixtureServerClosed: true, deciderDisposed: true } };
    writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ passed: rows.length - failures.length, failed: failures.length, mode: evidence.mode, settlements: settlements.length }));
    app.exit(failures.length ? 1 : 0);
}
mkdirSync(out, { recursive: true });
main().catch(error => { console.error(String(error)); writeFileSync(join(out, 'fatal.json'), JSON.stringify({ error: String(error) })); app.exit(1); });
