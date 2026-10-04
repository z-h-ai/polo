#!/usr/bin/env python3
"""Object/permission/lifecycle probes with real click chains.
Each chain starts from an independent Reset of the review shell.
Reviewer: zcode-subagent-object-final-r15c-v2.
"""
import json, subprocess, sys, time, re
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 8941
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'

manifest = json.load(open(ROOT / 'docs/mvp-complete-flow-hifi/prototype-manifest.json'))
surface_of = {s['id']: (s.get('surface') or 'mvp') for s in manifest['scenes']}

from playwright.sync_api import sync_playwright

FIND_CLICK_JS = """
(args) => {
  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  const sceneEl = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
  if (!sceneEl) return {ok:false, reason:'no-scene'};
  const want = norm(args.text);
  const sel = 'button, a[href], [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], [role="tab"], [role="menuitem"], summary, [role="option"]';
  let cands = [...sceneEl.querySelectorAll(sel)].filter(el => {
    if (el.disabled || el.getAttribute('aria-disabled')==='true') return false;
    const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') return false;
    const r = el.getBoundingClientRect(); if (r.width===0 && r.height===0) return false;
    const label = norm(el.getAttribute('aria-label') || el.innerText || el.value);
    return label === want || label.includes(want);
  });
  if (args.scope) {
    const sc = norm(args.scope);
    const f = cands.filter(el => { let p = el; while (p && p !== sceneEl.parentElement) { if (norm(p.innerText).includes(sc)) return true; p = p.parentElement; } return false; });
    if (f.length) cands = f;
  }
  if (!cands.length) return {ok:false, reason:'no-control', want};
  const el = cands[args.index || 0];
  el.setAttribute('data-probe-target','1');
  return {ok:true, label: norm(el.getAttribute('aria-label')||el.innerText||el.value).slice(0,100), total: cands.length};
}
"""

CAPTURE_JS = """
() => {
  const sceneEl = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
  if (!sceneEl) return {ok:false};
  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  const text = (sceneEl.innerText||'');
  const ctrls = [...sceneEl.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="checkbox"], [role="tab"], summary')].map(el => ({
    label: norm(el.getAttribute('aria-label')||el.innerText||el.value||el.getAttribute('placeholder')).slice(0,120),
    disabled: el.disabled===true || el.getAttribute('aria-disabled')==='true',
    checked: el.getAttribute('aria-checked') !== null ? el.getAttribute('aria-checked') : (typeof el.checked==='boolean'?String(el.checked):null),
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type')
  })).filter(c => c.label);
  return {ok:true, id: sceneEl.getAttribute('data-prototype-scene')||'', text: text.slice(0,12000), controls: ctrls};
}
"""

def frame_for(page, sid):
    owner = surface_of[sid]
    for f in page.frames:
        if owner == 'assistant' and 'polo-client-source-baseline/prototype.html' in f.url:
            return f
        if owner == 'mvp' and '/docs/mvp-complete-flow-hifi/prototype.html' in f.url:
            return f
    return None

def wait_shell_scene(page, sid, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if page.evaluate("() => document.body.dataset.currentScene") == sid:
                fr = frame_for(page, sid)
                if fr and fr.evaluate("() => { const e = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]'); return e? (e.getAttribute('data-prototype-scene')||''):''; }") == sid:
                    return True
        except Exception:
            pass
        time.sleep(0.06)
    return False

def reset_shell(page):
    page.evaluate("() => { const b = document.querySelector('[data-reset]'); if (b) b.click(); }")
    time.sleep(0.35)
    page.evaluate("() => { location.hash = '#scene=' + document.body.dataset.currentScene; }")
    time.sleep(0.2)

def nav(page, sid, timeout=8):
    page.evaluate(f"() => {{ location.hash = '#scene={sid}'; }}")
    return wait_shell_scene(page, sid, timeout)

CHAINS = [
 dict(id='CH1-multi-source-dedup', steps=[
   {'nav':'P-M03-ALL-APPS','cap':'dedup-list'},
   {'click':{'text':'打开','scope':'数据报表生成器'},'expect':'P-M04-APP-REPORT','cap':'open-report-from-dedup'},
 ]),
 dict(id='CH2-source-fallback-app', steps=[
   {'nav':'P-M07-SOURCE-FALLBACK','cap':'fallback-circle'},
   {'click':{'text':'我的圈子'},'expect':'P-M07-LIST','cap':'circle-list-after-fallback'},
 ]),
 dict(id='CH3-last-source-blocked', steps=[
   {'nav':'P-M11-BLOCKED-EXPIRED','cap':'blocked-expired'},
 ]),
 dict(id='CH4-skill-fallback-restricted', steps=[
   {'nav':'A-personal-fallback','cap':'skill-fallback'},
   {'nav':'A-personal-restricted','cap':'skill-restricted'},
   {'nav':'A-personal-reauthorized','cap':'skill-reauthorized'},
 ]),
 dict(id='CH5-same-name-skill-toggle', steps=[
   {'nav':'A-personal-skills','cap':'skills-list-before'},
   {'click':{'text':'停用内置技能'},'expect':'A-personal-builtinoff','cap':'builtin-off-page'},
   {'nav':'A-personal-skills','cap':'skills-list-after-off'},
   {'fill':{'match':'搜索','value':'资料研究'},'cap':'skills-search-samename'},
   {'fill':{'match':'搜索','value':''},'cap':None},
   {'nav':'A-personal-builtinoff','cap':'builtin-off-state-check'},
   {'click':{'text':'启用内置技能'},'expect':'A-personal-builtinon','cap':'builtin-on-page'},
 ]),
 dict(id='CH6-import-second-same-name', steps=[
   {'nav':'A-personal-transfer-import','cap':'import-list'},
   {'click':{'text':'选择导出文件','index':1},'expect':'A-personal-transfer-preview','cap':'preview-second'},
   {'click':{'text':'确认导入'},'expect':'A-personal-transfer-done','cap':'import-done'},
 ]),
 dict(id='CH6b-import-cancel-no-object', steps=[
   {'nav':'A-personal-transfer-import','cap':'import-list-2'},
   {'click':{'text':'返回原对话'},'expect':'A-personal-conversation','cap':'cancel-back-conversation'},
   {'nav':'A-personal-new','cap':'new-session-no-imported'},
 ]),
 dict(id='CH6c-import-invalid', steps=[
   {'nav':'A-personal-transfer-invalid','cap':'invalid-format'},
 ]),
 dict(id='CH7-pay-return-repeat-query', steps=[
   {'nav':'P-M07-PAY-RETURN','cap':'pay-return'},
   {'click':{'text':'查询原订单'},'cap':'after-query-1'},
   {'click':{'text':'查询原订单'},'cap':'after-query-2'},
 ]),
 dict(id='CH8-renew-monthly', steps=[
   {'nav':'P-M07-RENEW','cap':'renew-offer'},
   {'click':{'text':'去浏览器支付'},'expect':'P-M07-RENEW-WEB','cap':'renew-web'},
   {'click':{'text':'返回 Polo'},'expect':'P-M07-RENEW-RETURN','cap':'renew-return'},
   {'click':{'text':'查询原订单和资格'},'expect':'P-M07-RENEW-RESULT','cap':'renew-result'},
   {'click':{'text':'返回我的圈子'},'expect':'P-M07-LIST-RENEWED','cap':'circle-list-renewed'},
 ]),
 dict(id='CH9-renew-second-order-latest-price', steps=[
   {'nav':'P-M07-RENEW','cap':'renew-offer-2'},
   {'click':{'text':'查看续费限制'},'expect':'P-M07-RENEW-LIMIT','cap':'renew-limit'},
 ]),
 dict(id='CH10-renew-year', steps=[
   {'nav':'P-M07-RENEW-YEAR','cap':'renew-year'},
   {'click':{'text':'前往年度圈续费网页'},'expect':'P-M07-YEAR-WEB','cap':'year-web'},
   {'click':{'text':'返回 Polo'},'expect':'P-M07-YEAR-RETURN','cap':'year-return'},
 ]),
 dict(id='CH11-roles-menu', steps=[
   {'nav':'P-M10-MENU','cap':'menu-owner-priv'},
   {'nav':'P-M10-MENU-ENT','cap':'menu-ent'},
   {'nav':'P-M10-MENU-NOPRIV','cap':'menu-nopriv'},
 ]),
 dict(id='CH12-creator-responsibility', steps=[
   {'nav':'P-M10-MENU-RESPONSIBILITY','cap':'menu-responsibility'},
   {'click':{'text':'创作者责任只读'},'expect':'P-M10-RESPONSIBILITY-BROWSER','cap':'responsibility-browser'},
   {'click':{'text':'返回 Polo'},'expect':'P-M10-RESPONSIBILITY-RETURN','cap':'responsibility-return'},
   {'click':{'text':'重新核对资格'},'expect':'P-M10-RESPONSIBILITY-VERIFIED','cap':'responsibility-verified'},
 ]),
 dict(id='CH13-switch-confirm-autoplay', steps=[
   {'nav':'P-M02-CONFIRM','cap':'confirm-3tasks'},
   {'click':{'text':'停止全部并切换'},'expect':'P-M02-STOPPING','cap':'stopping-start'},
   {'sleep':0.8,'cap':'stopping-mid'},
   {'sleep':1.5,'cap':'stopping-late'},
   {'wait':'P-M03-HOME-PERSONAL','timeout':20,'cap':'target-home-personal'},
 ]),
 dict(id='CH14-stop-cancel-runtime', steps=[
   {'nav':'P-M02-STOPPING','cap':'stopping-frozen'},
   {'click':{'text':'取消切换'},'expect':'P-M02-STOP-CANCEL','cap':'stop-cancel'},
   {'click':{'text':'后台任务'},'expect':'P-M04-RUNTIME','cap':'runtime-after-cancel'},
 ]),
 dict(id='CH15-stop-failed-retry', steps=[
   {'nav':'P-M02-STOP-FAILED','cap':'stop-failed'},
   {'click':{'text':'重试失败项'},'expect':'P-M02-STOPPING','cap':'retry-stopping'},
   {'wait':'P-M03-HOME-PERSONAL','timeout':20,'cap':'retry-target-home'},
 ]),
 dict(id='CH16-runtime-personal-report-stopped', steps=[
   {'nav':'P-M04-RUNTIME-PERSONAL','cap':'runtime-personal'},
 ]),
 dict(id='CH17-leave-cancel', steps=[
   {'nav':'P-M07-LEAVE','cap':'leave-dialog'},
   {'click':{'text':'取消'},'expect':'P-M07-DETAIL-FOCUS','cap':'leave-cancel-detail'},
 ]),
 dict(id='CH18-expired-vs-left', steps=[
   {'nav':'P-M07-EXPIRED','cap':'expired'},
   {'nav':'P-M07-DETAIL-PAID-AFTER-LEAVE','cap':'detail-after-leave'},
   {'nav':'P-M07-REJOIN-BROWSER','cap':'rejoin-browser'},
   {'click':{'text':'取消本次前往'},'expect':'P-M07-DETAIL-PAID-AFTER-LEAVE','cap':'rejoin-cancel'},
 ]),
 dict(id='CH19-credit-query-once', steps=[
   {'nav':'A-personal-return','cap':'credit-return'},
   {'click':{'text':'已完成，查询结果'},'expect':'A-personal-checking','cap':'credit-checking'},
   {'sleep':2.0,'cap':'credit-check-result'},
 ]),
 dict(id='CH20-credit-notyet-requery', steps=[
   {'nav':'A-personal-notyet','cap':'credit-notyet'},
   {'click':{'text':'已完成，查询结果'},'expect':'A-personal-checking','cap':'credit-checking-2'},
   {'sleep':2.0,'cap':'credit-check2-result'},
 ]),
 dict(id='CH21-credit-states', steps=[
   {'nav':'A-personal-preblock','cap':'preblock'},
   {'nav':'A-personal-cut','cap':'cut-partial'},
   {'nav':'A-personal-stopped','cap':'manual-stop'},
   {'nav':'A-personal-completezero','cap':'complete-zero'},
   {'nav':'A-personal-resumed','cap':'resumed'},
 ]),
 dict(id='CH22-enterprise-credit-notify', steps=[
   {'nav':'A-enterprise-notify','cap':'ent-notify'},
   {'nav':'A-enterprise-notified','cap':'ent-notified-member'},
   {'nav':'P-M09-APP-NOTIFIED','cap':'app-notified'},
 ]),
 dict(id='CH23-governance-roles', steps=[
   {'nav':'P-M11-GOVERNANCE-PAUSED-MEMBER','cap':'gov-paused-member'},
   {'nav':'P-M11-GOVERNANCE-PAUSED-OWNER','cap':'gov-paused-owner'},
   {'nav':'P-M11-GOVERNANCE-ARREARS-MEMBER','cap':'gov-arrears-member'},
   {'nav':'P-M11-GOVERNANCE-PENDING','cap':'gov-pending'},
 ]),
 dict(id='CH24-close-active-cancel', steps=[
   {'nav':'P-M04-CLOSE-REPORT','cap':'close-dialog'},
   {'click':{'text':'取消'},'expect':'P-M04-APP-REPORT','cap':'close-cancel-app'},
 ]),
 dict(id='CH25-term-failed', steps=[
   {'nav':'P-M04-TERM-FAILED','cap':'term-failed'},
 ]),
 dict(id='CH26-offline-contract', steps=[
   {'nav':'P-M11-OFFLINE-HOME','cap':'offline-home'},
   {'nav':'P-M11-CONTRACT-FAIL','cap':'contract-fail'},
   {'nav':'P-M11-CONTRACT-READY','cap':'contract-ready'},
 ]),
 dict(id='CH27-space-isolation-assistant', steps=[
   {'nav':'A-personal-new','cap':'assistant-personal-new'},
   {'nav':'A-enterprise-new','cap':'assistant-enterprise-new'},
   {'nav':'P-M03-HOME-ENT-AFTER-CANCEL','cap':'home-after-cancel-switch'},
 ]),
 dict(id='CH28-circle-join-handoff', steps=[
   {'nav':'P-M07-PUBLIC-WEB','cap':'public-web'},
   {'click':{'text':'返回 Polo'},'expect':'P-M07-RETURN','cap':'join-return-verify'},
 ]),
 dict(id='CH29-question-answer-flow', steps=[
   {'nav':'A-personal-question','cap':'question-waiting'},
   {'nav':'A-personal-deferred','cap':'question-deferred'},
   {'nav':'A-personal-expired','cap':'question-expired'},
   {'nav':'A-personal-reopen','cap':'question-reopen'},
 ]),
]

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page_errors = []
    page.on('pageerror', lambda e: page_errors.append(str(e)[:300]))
    page.on('dialog', lambda d: d.dismiss())
    page.goto(REVIEW, wait_until='networkidle', timeout=30000)
    page.wait_for_selector('[data-prototype-viewport]', timeout=15000)
    time.sleep(1.5)

    for chain in CHAINS:
        rec = {'chain': chain['id'], 'steps': []}
        reset_shell(page)
        for i, step in enumerate(chain['steps']):
            srec = {'step': i}
            try:
                if 'nav' in step:
                    ok = nav(page, step['nav'])
                    srec['nav'] = step['nav']; srec['nav_ok'] = bool(ok)
                elif 'click' in step:
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    spec = step['click']
                    fr.evaluate("() => { document.querySelectorAll('[data-probe-target]').forEach(e=>e.removeAttribute('data-probe-target')); }")
                    found = fr.evaluate(FIND_CLICK_JS, {'text': spec['text'], 'scope': spec.get('scope'), 'index': spec.get('index', 0)})
                    srec['click'] = spec['text']; srec['found'] = found
                    if found.get('ok'):
                        fr.click('[data-probe-target]', timeout=4000)
                        fr.evaluate("() => { const e=document.querySelector('[data-probe-target]'); if(e) e.removeAttribute('data-probe-target'); }")
                        if 'expect' in step:
                            srec['arrived'] = wait_shell_scene(page, step['expect'], 8)
                            srec['expected'] = step['expect']
                        else:
                            time.sleep(1.0); srec['arrived'] = None
                elif 'fill' in step:
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    m = step['fill']['match']; val = step['fill']['value']
                    fh = fr.evaluate("""(m) => { const norm=s=>(s==null?'':String(s)); const root=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]'); const els=[...root.querySelectorAll('input, textarea')];
                      const el = els.find(e => norm(e.placeholder).includes(m) || norm(e.getAttribute('aria-label')).includes(m) || norm(e.name).includes(m) || ['search','text'].includes(e.type));
                      if (!el) return false; el.setAttribute('data-probe-target','1'); return true; }""", m)
                    srec['fill'] = m; srec['fill_ok'] = bool(fh)
                    if fh:
                        fr.fill('[data-probe-target]', val, timeout=3000)
                        fr.dispatchEvent('[data-probe-target]', 'input')
                        fr.evaluate("() => { const e=document.querySelector('[data-probe-target]'); if(e) e.removeAttribute('data-probe-target'); }")
                        time.sleep(0.6)
                elif 'sleep' in step:
                    time.sleep(step['sleep'])
                elif 'wait' in step:
                    srec['wait'] = step['wait']
                    srec['arrived'] = wait_shell_scene(page, step['wait'], step.get('timeout', 10))
                if step.get('cap'):
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    data = fr.evaluate(CAPTURE_JS) if fr else {'ok': False}
                    srec['capture'] = data
                    srec['shell_scene'] = page.evaluate("() => document.body.dataset.currentScene")
            except Exception as ex:
                srec['error'] = str(ex)[:300]
            rec['steps'].append(srec)
        rec['pageerror_during_chain'] = len(page_errors)
        results.append(rec)
    browser.close()

server.terminate()
try: server.wait(timeout=5)
except Exception: server.kill()

(OUT / 'probes-raw.json').write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding='utf-8')
print('chains:', len(results))
for r in results:
    caps = sum(1 for s in r['steps'] if s.get('capture', {}).get('ok'))
    bad = [s.get('click') or s.get('nav') or s.get('wait') or s.get('fill') for s in r['steps'] if s.get('error') or s.get('nav_ok') is False or s.get('arrived') is False or s.get('fill_ok') is False]
    print(f"  {r['chain']}: captures={caps} issues={bad}")
