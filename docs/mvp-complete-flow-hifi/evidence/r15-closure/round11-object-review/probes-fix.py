#!/usr/bin/env python3
"""Fix-up probes for the three failed interactions + extra consumer checks."""
import json, subprocess, sys, time
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 8961
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'
manifest = json.load(open(ROOT / 'docs/mvp-complete-flow-hifi/prototype-manifest.json'))
surface_of = {s['id']: (s.get('surface') or 'mvp') for s in manifest['scenes']}

from playwright.sync_api import sync_playwright

GET_ACTIVE = "() => { const el = document.querySelector('.scene.active[data-prototype-scene]'); if (el) return el.getAttribute('data-prototype-scene'); const el2 = document.querySelector('[data-prototype-scene]'); return el2 ? el2.getAttribute('data-prototype-scene') : ''; }"

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
                if fr and fr.evaluate(GET_ACTIVE) == sid:
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
 dict(id='FX1-open-dedup-report-exact', steps=[
   {'nav':'P-M03-ALL-APPS','cap':'dedup-list'},
   {'click_exact':{'text':'打开','scope':'数据报表生成器'},'expect':'P-M04-APP-REPORT','cap':'report-app-opened'},
 ]),
 dict(id='FX2-samename-toggle-and-search', steps=[
   {'nav':'A-personal-skills','cap':'list-before'},
   {'click_exact':{'text':'停用内置技能'},'expect':'A-personal-builtinoff','cap':'off-page'},
   {'nav':'A-personal-skills','cap':'list-after-off'},
   {'fill2':{'match':'搜索','value':'资料研究'},'cap':'search-samename'},
   {'fill2':{'match':'搜索','value':''},'cap':None},
   {'nav':'A-personal-detail','cap':'detail-one-name'},
 ]),
 dict(id='FX3-renew-limit-click', steps=[
   {'nav':'P-M07-RENEW','cap':'renew-offer'},
   {'click_exact':{'text':'查看续费限制'},'expect':'P-M07-RENEW-LIMIT','cap':'renew-limit'},
 ]),
 dict(id='FX4-cancel-switch-runtime', steps=[
   {'nav':'P-M02-STOPPING','cap':'stopping-frozen'},
   {'click_exact':{'text':'取消切换'},'expect':'P-M02-STOP-CANCEL','cap':'cancel-scene'},
   {'click_exact':{'text':'后台任务'},'expect':'P-M04-RUNTIME','cap':'runtime-after-cancel'},
 ]),
 dict(id='FX5-home-search-report', steps=[
   {'nav':'P-M03-HOME-PERSONAL','cap':'home-before'},
   {'fill2':{'match':'搜索应用','value':'报表'},'cap':'home-search'},
 ]),
]

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
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
                    srec['nav'] = step['nav']; srec['nav_ok'] = bool(nav(page, step['nav']))
                elif 'click_exact' in step or 'click' in step:
                    spec = step.get('click_exact') or step['click']
                    exact = 'click_exact' in step
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    fr.evaluate("() => { document.querySelectorAll('[data-probe-target]').forEach(e=>e.removeAttribute('data-probe-target')); }")
                    found = fr.evaluate("""(args) => {
                      const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
                      const sceneEl = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
                      if (!sceneEl) return {ok:false, reason:'no-scene'};
                      const want = norm(args.text);
                      const sel = 'button, a[href], [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"], [role="tab"], [role="menuitem"], summary';
                      let cands = [...sceneEl.querySelectorAll(sel)].filter(el => {
                        if (el.disabled || el.getAttribute('aria-disabled')==='true') return false;
                        const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') return false;
                        const r = el.getBoundingClientRect(); if (r.width===0 && r.height===0) return false;
                        const label = norm(el.getAttribute('aria-label') || el.innerText || el.value);
                        return args.exact ? (label === want || label.split(' ')[0] === want) : (label === want || label.includes(want));
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
                    }""", {'text': spec['text'], 'scope': spec.get('scope'), 'index': spec.get('index', 0), 'exact': exact})
                    srec['click'] = spec['text']; srec['found'] = found
                    if found.get('ok'):
                        try:
                            fr.click('[data-probe-target]', timeout=4000)
                        except Exception:
                            fr.evaluate("() => { document.querySelector('[data-probe-target]').click(); }")
                        fr.evaluate("() => { const e=document.querySelector('[data-probe-target]'); if(e) e.removeAttribute('data-probe-target'); }")
                        if 'expect' in step:
                            srec['arrived'] = wait_shell_scene(page, step['expect'], 8)
                            srec['expected'] = step['expect']
                        else:
                            time.sleep(1.0)
                elif 'fill2' in step:
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    m = step['fill2']['match']; val = step['fill2']['value']
                    fh = fr.evaluate("""(m) => { const norm=s=>(s==null?'':String(s)); const root=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
                      const els=[...root.querySelectorAll('input, textarea')];
                      const el = els.find(e => norm(e.placeholder).includes(m) || norm(e.getAttribute('aria-label')).includes(m) || norm(e.name).includes(m));
                      if (!el) return false; el.setAttribute('data-probe-target','1'); return true; }""", m)
                    srec['fill'] = m; srec['fill_ok'] = bool(fh)
                    if fh:
                        fr.fill('[data-probe-target]', val, timeout=3000)
                        fr.evaluate("() => { const e=document.querySelector('[data-probe-target]'); if(e) e.removeAttribute('data-probe-target'); }")
                        time.sleep(0.8)
                if step.get('cap'):
                    fr = frame_for(page, page.evaluate("() => document.body.dataset.currentScene"))
                    srec['capture'] = fr.evaluate(CAPTURE_JS) if fr else {'ok': False}
                    srec['shell_scene'] = page.evaluate("() => document.body.dataset.currentScene")
            except Exception as ex:
                srec['error'] = str(ex)[:300]
            rec['steps'].append(srec)
        results.append(rec)
    browser.close()
server.terminate()
try: server.wait(timeout=5)
except Exception: server.kill()
(OUT / 'probes-fix-raw.json').write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding='utf-8')
for r in results:
    for s in r['steps']:
        line = f"  {r['chain']} step{s['step']}: "
        line += f"nav={s.get('nav')} ok={s.get('nav_ok')} " if 'nav' in s else ''
        line += f"click={s.get('click')} found={s.get('found',{}).get('ok')} arrived={s.get('arrived')} " if 'click' in s or 'click_exact' in s else ''
        line += f"fill={s.get('fill')} ok={s.get('fill_ok')} " if 'fill' in s else ''
        line += f"err={s.get('error','')[:120]}" if s.get('error') else ''
        print(line)
