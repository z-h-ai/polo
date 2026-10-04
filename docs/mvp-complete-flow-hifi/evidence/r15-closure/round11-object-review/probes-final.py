#!/usr/bin/env python3
"""Final probe batch: builtin-off click retry, card-scoped open binding, partial-stop cancel."""
import json, subprocess, sys, time
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 8981
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'
manifest = json.load(open(ROOT / 'docs/mvp-complete-flow-hifi/prototype-manifest.json'))
surface_of = {s['id']: (s.get('surface') or 'mvp') for s in manifest['scenes']}

from playwright.sync_api import sync_playwright

GET_ACTIVE = "() => { const el = document.querySelector('.scene.active[data-prototype-scene]'); if (el) return el.getAttribute('data-prototype-scene'); const el2 = document.querySelector('[data-prototype-scene]'); return el2 ? el2.getAttribute('data-prototype-scene') : ''; }"
CAP = """() => { const e=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
  const norm=s=>(s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  return {id:e.getAttribute('data-prototype-scene'), text:(e.innerText||'').slice(0,8000)}; }"""

CLICK_IN_CARD_JS = """
(args) => {
  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  const sceneEl = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
  const els = [...sceneEl.querySelectorAll('*')].filter(e => e.children.length === 0 && norm(e.innerText) === args.title);
  if (!els.length) return {ok:false, reason:'no-title'};
  let node = els[0];
  let container = null;
  let p = node;
  while (p && p !== sceneEl) {
    const btns = [...p.querySelectorAll('button')].filter(b => norm(b.innerText) === args.button && !b.disabled);
    if (btns.length === 1) { container = btns[0]; break; }
    p = p.parentElement;
  }
  if (!container) return {ok:false, reason:'no-unique-button'};
  container.setAttribute('data-pt','1');
  return {ok:true};
}
"""

CLICK_LABEL_JS = """
(args) => {
  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  const sceneEl = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
  const el = [...sceneEl.querySelectorAll('button,[role="switch"],[role="checkbox"]')].find(e => {
    if (e.disabled) return false;
    return norm(e.getAttribute('aria-label')||e.innerText||e.value) === args.text;
  });
  if (!el) return false;
  el.setAttribute('data-pt','1');
  return true;
}
"""

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
out = {'steps': []}

def log(tag, data):
    out['steps'].append({'tag': tag, **data})
    print(f"== {tag}: {json.dumps({k: v for k, v in data.items() if k != 'cap'}, ensure_ascii=False)[:200]}", flush=True)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        try:
            page.goto(REVIEW, wait_until='networkidle', timeout=30000)
            page.wait_for_selector('[data-prototype-viewport]', timeout=15000)
            time.sleep(1.5)

            def fr_for(sid):
                owner = surface_of[sid]
                for f in page.frames:
                    if owner == 'assistant' and 'polo-client-source-baseline/prototype.html' in f.url:
                        return f
                    if owner == 'mvp' and '/docs/mvp-complete-flow-hifi/prototype.html' in f.url:
                        return f
                return None

            def wait_scene(sid, timeout=15):
                end = time.time() + timeout
                while time.time() < end:
                    try:
                        f = fr_for(sid)
                        if f and page.evaluate("() => document.body.dataset.currentScene") == sid and f.evaluate(GET_ACTIVE) == sid:
                            return f
                    except Exception:
                        pass
                    time.sleep(0.12)
                return None

            def reset():
                page.evaluate("() => { const b=document.querySelector('[data-reset]'); if(b) b.click(); }")
                time.sleep(0.4)
                page.evaluate("() => { location.hash = '#scene=' + document.body.dataset.currentScene; }")
                time.sleep(0.2)

            def nav(sid):
                page.evaluate(f"() => {{ location.hash = '#scene={sid}'; }}")
                f = wait_scene(sid, 20)
                if not f:
                    # re-dispatch the scene command in case the surface iframe booted late
                    page.evaluate("() => { location.hash = '#scene=P-M01-LOGIN-PASSWORD'; }")
                    time.sleep(0.5)
                    page.evaluate(f"() => {{ location.hash = '#scene={sid}'; }}")
                    f = wait_scene(sid, 30)
                return f

            def click_label(fr, text):
                if not fr.evaluate(CLICK_LABEL_JS, {'text': text}):
                    return False
                try:
                    fr.click('[data-pt]', timeout=4000)
                except Exception:
                    fr.evaluate("() => { document.querySelector('[data-pt]').click(); }")
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                return True

            # warm up the assistant surface iframe (cold boot can be slow under load)
            nav('A-personal-skills')

            # SK1: builtin off with retry
            reset()
            fr = nav('A-personal-skills')
            assert fr, 'skills not ready'
            log('SK1-initial', {'cap': fr.evaluate(CAP)})
            clicked = False
            for attempt in range(5):
                clicked = click_label(fr, '停用内置技能')
                if clicked:
                    break
                time.sleep(1.2)
            time.sleep(0.8)
            cur = page.evaluate("() => document.body.dataset.currentScene")
            log('SK1-off-click', {'clicked': clicked, 'scene_after': cur, 'cap': fr.evaluate(CAP)})
            fr2 = nav('A-personal-skills')
            if fr2:
                log('SK1-list-consumer', {'cap': fr2.evaluate(CAP)})
                # restore: enable builtin
                ok_sel = click_label(fr2, '查看内置技能')
                ok_en = click_label(fr2, '启用内置技能')
                time.sleep(0.7)
                log('SK1-restore', {'select': ok_sel, 'enable': ok_en, 'cap': fr2.evaluate(CAP)})

            # OP1: card-scoped open binding on dedup page
            reset()
            fr = nav('P-M03-ALL-APPS')
            assert fr, 'all-apps not ready'
            ok = fr.evaluate(CLICK_IN_CARD_JS, {'title': '数据报表生成器', 'button': '打开'})
            log('OP1-locate', {'locate': ok})
            if ok.get('ok'):
                try:
                    fr.click('[data-pt]', timeout=4000)
                except Exception:
                    fr.evaluate("() => { document.querySelector('[data-pt]').click(); }")
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                f2 = wait_scene('P-M04-APP-REPORT', 8)
                log('OP1-opened', {'arrived': bool(f2), 'scene': page.evaluate("() => document.body.dataset.currentScene"), 'cap': (f2 or fr).evaluate(CAP)})
            # second sample: brand card
            page.evaluate("() => { location.hash = '#scene=P-M03-ALL-APPS'; }")
            time.sleep(1.0)
            ok = fr.evaluate(CLICK_IN_CARD_JS, {'title': '品牌语气分析', 'button': '打开'})
            log('OP1b-locate', {'locate': ok})
            if ok.get('ok'):
                try:
                    fr.click('[data-pt]', timeout=4000)
                except Exception:
                    fr.evaluate("() => { document.querySelector('[data-pt]').click(); }")
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                f2 = wait_scene('P-M04-APP-BRAND', 8)
                log('OP1b-opened', {'arrived': bool(f2), 'scene': page.evaluate("() => document.body.dataset.currentScene"), 'cap': (f2 or fr).evaluate(CAP)})

            # SW1: partial-stop then cancel
            reset()
            fr = nav('P-M02-CONFIRM')
            assert fr, 'confirm not ready'
            log('SW1-confirm', {'cap': fr.evaluate(CAP)})
            ok = click_label(fr, '停止全部并切换')
            log('SW1-start', {'clicked': ok})
            mid_text = None
            end = time.time() + 6
            while time.time() < end:
                try:
                    t = fr.evaluate(CAP).get('text','')
                    if '已停止 1' in t or '已停止 2' in t:
                        mid_text = t
                        break
                except Exception:
                    pass
                time.sleep(0.1)
            log('SW1-mid', {'partial_seen': bool(mid_text), 'text_head': (mid_text or '')[:300]})
            ok = click_label(fr, '取消切换')
            time.sleep(0.6)
            cur = page.evaluate("() => document.body.dataset.currentScene")
            log('SW1-cancel', {'clicked': ok, 'scene': cur, 'cap': fr.evaluate(CAP)})
            fr = nav('P-M04-RUNTIME')
            if fr:
                log('SW1-runtime', {'cap': fr.evaluate(CAP)})
        finally:
            try:
                browser.close()
            except Exception:
                pass
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except Exception:
        server.kill()

(OUT / 'probes-final-raw.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print('saved probes-final-raw.json, steps:', len(out['steps']))
