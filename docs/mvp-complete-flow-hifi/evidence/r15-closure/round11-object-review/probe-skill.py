#!/usr/bin/env python3
"""Interactive skill-management probe: built-in vs same-name circle skill independent toggles."""
import json, subprocess, sys, time
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 8971
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'

from playwright.sync_api import sync_playwright

GET_ACTIVE = "() => { const el = document.querySelector('.scene.active[data-prototype-scene]'); if (el) return el.getAttribute('data-prototype-scene'); const el2 = document.querySelector('[data-prototype-scene]'); return el2 ? el2.getAttribute('data-prototype-scene') : ''; }"
CAP = """() => { const e=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
  const norm=s=>(s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  return {id:e.getAttribute('data-prototype-scene'), text:(e.innerText||'').slice(0,6000),
    ctrls:[...e.querySelectorAll('button,[role="switch"],[role="checkbox"],input')].map(el=>({l:norm(el.getAttribute('aria-label')||el.innerText||el.value||el.placeholder).slice(0,80),d:el.disabled===true,c:el.getAttribute('aria-checked'),t:el.tagName.toLowerCase()}))}; }"""

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
out = {'steps': []}

def log(tag, data):
    out['steps'].append({'tag': tag, **data})
    print(f"== {tag}: {json.dumps({k: v for k, v in data.items() if k != 'cap'}, ensure_ascii=False)[:220]}")

try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        page = b.new_page(viewport={'width': 1440, 'height': 900})
        try:
            page.goto(f'{BASE}/docs/mvp-complete-flow-hifi/review.html', wait_until='networkidle', timeout=30000)
            page.wait_for_selector('[data-prototype-viewport]', timeout=15000)
            time.sleep(1.5)
            page.evaluate("() => { const b=document.querySelector('[data-reset]'); if(b) b.click(); }")
            time.sleep(0.4)
            page.evaluate("() => { location.hash = '#scene=A-personal-skills'; }")

            def fr_for():
                for f in page.frames:
                    if 'polo-client-source-baseline/prototype.html' in f.url:
                        return f
                return None

            fr = None; end = time.time() + 30
            seen = []
            while time.time() < end:
                try:
                    f = fr_for()
                    cur = page.evaluate("() => document.body.dataset.currentScene")
                    states = []
                    for ff in page.frames:
                        try:
                            states.append((ff.url.split('/')[-1][:22], ff.evaluate("() => { const e = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]'); return (e? e.getAttribute('data-prototype-scene'):'') + '|' + document.readyState; }")))
                        except Exception as ex:
                            states.append((ff.url.split('/')[-1][:22], f'ERR {str(ex)[:40]}'))
                    seen.append((cur, states))
                    if f and cur == 'A-personal-skills' and f.evaluate(GET_ACTIVE) == 'A-personal-skills':
                        fr = f; break
                except Exception as ex:
                    seen.append(('EXC', str(ex)[:80]))
                time.sleep(0.15)
            if fr is None:
                for s in seen[-6:]:
                    print('DBG', s, flush=True)
            assert fr, 'assistant frame never ready'
            log('list-initial', {'cap': fr.evaluate(CAP)})

            def click_label(text, exact=True):
                ok = fr.evaluate("""(args) => { const norm=s=>(s==null?'':String(s)).replace(/\\s+/g,' ').trim();
                  const root=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
                  const el=[...root.querySelectorAll('button,[role="switch"],[role="checkbox"]')].find(e=>{
                    if (e.disabled) return false;
                    const lb=norm(e.getAttribute('aria-label')||e.innerText||e.value);
                    return args.exact? lb===args.text : lb.includes(args.text); });
                  if(el){el.setAttribute('data-pt','1'); return true;} return false; }""", {'text': text, 'exact': exact})
                if not ok:
                    return False
                try:
                    fr.click('[data-pt]', timeout=4000)
                except Exception:
                    fr.evaluate("() => { document.querySelector('[data-pt]').click(); }")
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                time.sleep(0.7)
                return True

            # select the built-in entry in the detail pane
            ok = click_label('查看内置技能')
            log('select-builtin', {'clicked': ok, 'cap': fr.evaluate(CAP)})
            # find and click its 停用 control
            ok2 = click_label('停用')
            log('toggle-builtin-off', {'clicked': ok2, 'cap': fr.evaluate(CAP)})
            # navigate to the list scene again WITHOUT reset — consumer view
            page.evaluate("() => { location.hash = '#scene=A-personal-skills'; }")
            time.sleep(1.0)
            log('list-after-off', {'cap': fr.evaluate(CAP)})
            # search same name
            fh = fr.evaluate("""() => { const root=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
              const el=[...root.querySelectorAll('input')].find(e=>e.type==='search'||(e.placeholder||'').includes('搜索')||(e.getAttribute('aria-label')||'').includes('名称'));
              if(!el) return false; el.setAttribute('data-pt','1'); return true; }""")
            if fh:
                fr.fill('[data-pt]', '资料研究', timeout=3000)
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                time.sleep(0.9)
            log('search-samename', {'filled': bool(fh), 'cap': fr.evaluate(CAP)})
            # clear search
            if fh:
                fr.evaluate("""() => { const root=document.querySelector('.scene.active[data-prototype-scene]')||document.querySelector('[data-prototype-scene]');
                  const el=[...root.querySelectorAll('input')].find(e=>e.type==='search'||(e.placeholder||'').includes('搜索'));
                  if(el){el.setAttribute('data-pt','1');} }""")
                try:
                    fr.fill('[data-pt]', '', timeout=3000)
                    fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                except Exception:
                    pass
                time.sleep(0.6)
            # re-enable builtin via its detail
            ok3 = click_label('查看内置技能')
            ok4 = click_label('启用')
            log('toggle-builtin-on', {'clicked_select': ok3, 'clicked_enable': ok4, 'cap': fr.evaluate(CAP)})
        finally:
            try:
                b.close()
            except Exception:
                pass
finally:
    server.terminate()
    try:
        server.wait(timeout=5)
    except Exception:
        server.kill()

(OUT / 'probe-skill-toggle.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print('saved probe-skill-toggle.json, steps:', len(out['steps']))
