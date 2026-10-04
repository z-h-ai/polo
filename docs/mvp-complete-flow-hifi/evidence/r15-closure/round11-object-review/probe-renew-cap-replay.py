#!/usr/bin/env python3
"""Independent replay of the renewal cap sequence: 11 full renewal cycles then the 12th renewal offer.
Verifies OBJ-R15C-01 resolution: the 查看续费限制 entry becomes reachable through real user actions.
Only real in-page clicks advance session state; hash navigation is used once at the start (after Reset).
"""
import json, subprocess, sys, time
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 9001
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'

from playwright.sync_api import sync_playwright

GET_ACTIVE = "() => { const el = document.querySelector('.scene.active[data-prototype-scene]'); if (el) return el.getAttribute('data-prototype-scene'); const el2 = document.querySelector('[data-prototype-scene]'); return el2 ? el2.getAttribute('data-prototype-scene') : ''; }"

STATE_JS = """
() => {
  const root = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
  const limitEl = [...root.querySelectorAll('button, a[href]')].find(e => norm(e.innerText) === '查看续费限制');
  const payEl = [...root.querySelectorAll('button')].find(e => norm(e.innerText) === '去浏览器支付');
  const info = el => el ? {hiddenAttr: el.hidden, display: getComputedStyle(el).display, disabled: el.disabled === true, visible: el.offsetParent !== null && getComputedStyle(el).display !== 'none'} : null;
  return {
    scene: root.getAttribute('data-prototype-scene'),
    text: (root.innerText||'').slice(0, 2500),
    limit_entry: info(limitEl),
    pay_button: info(payEl)
  };
}
"""

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
out = {'cycles': [], 'cap_state': None, 'notes': []}

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        try:
            page.goto(REVIEW, wait_until='networkidle', timeout=30000)
            page.wait_for_selector('[data-prototype-viewport]', timeout=15000)
            time.sleep(1.5)
            page.evaluate("() => { const b=document.querySelector('[data-reset]'); if(b) b.click(); }")
            time.sleep(0.4)

            def mvp_frame():
                for f in page.frames:
                    if '/docs/mvp-complete-flow-hifi/prototype.html' in f.url:
                        return f
                return None

            def wait_scene(sid, timeout=12):
                end = time.time() + timeout
                while time.time() < end:
                    try:
                        f = mvp_frame()
                        if f and page.evaluate("() => document.body.dataset.currentScene") == sid and f.evaluate(GET_ACTIVE) == sid:
                            return f
                    except Exception:
                        pass
                    time.sleep(0.1)
                return None

            def click(fr, label, scope=None, exclude=None):
                ok = fr.evaluate("""(args) => {
                  const norm = s => (s==null?'':String(s)).replace(/\\s+/g,' ').trim();
                  const root = document.querySelector('.scene.active[data-prototype-scene]') || document.querySelector('[data-prototype-scene]');
                  let els = [...root.querySelectorAll('button, a[href]')].filter(e => {
                    if (e.disabled || e.hidden) return false;
                    const st = getComputedStyle(e); if (st.display==='none'||st.visibility==='hidden') return false;
                    const r = e.getBoundingClientRect(); if (r.width===0&&r.height===0) return false;
                    return norm(e.innerText) === args.label;
                  });
                  if (args.scope && els.length > 1) {
                    const f2 = els.filter(el => { let p = el; while (p && p !== root) {
                      const t = norm(p.innerText);
                      if (args.exclude && args.exclude.some(x => t.includes(x))) return false;
                      if (t.includes(args.scope)) return true;
                      p = p.parentElement; } return false; });
                    if (f2.length) els = f2;
                  }
                  if (!els.length) return false;
                  els[0].setAttribute('data-pt','1');
                  return true;
                }""", {'label': label, 'scope': scope, 'exclude': exclude})
                if not ok:
                    return False
                try:
                    fr.click('[data-pt]', timeout=4000)
                except Exception:
                    fr.evaluate("() => { document.querySelector('[data-pt]').click(); }")
                fr.evaluate("() => { const e=document.querySelector('[data-pt]'); if(e) e.removeAttribute('data-pt'); }")
                return True

            # enter cycle 1 via hash (single entry, then only real clicks)
            page.evaluate("() => { location.hash = '#scene=P-M07-RENEW'; }")
            fr = wait_scene('P-M07-RENEW', 15)
            assert fr, 'RENEW not ready'

            for i in range(1, 12):
                cyc = {'cycle': i}
                st = fr.evaluate(STATE_JS)
                cyc['renew_scene'] = {k: st[k] for k in ('scene', 'limit_entry', 'pay_button')}
                # extract quote window
                t = st['text']
                import re
                mm = re.search(r'起算日\s*\|\s*([0-9-]+) 至 ([0-9-]+)', t.replace('\n', ' | '))
                cyc['quote_window'] = [mm.group(1), mm.group(2)] if mm else None
                ok1 = click(fr, '去浏览器支付'); cyc['to_web'] = ok1
                fr2 = wait_scene('P-M07-RENEW-WEB')
                ok2 = fr2 is not None and click(fr2, '返回 Polo'); cyc['web_return'] = bool(ok2)
                fr3 = wait_scene('P-M07-RENEW-RETURN')
                cyc['order_no'] = None
                if fr3:
                    t3 = fr3.evaluate(STATE_JS)['text']
                    m3 = re.search(r'订单号\s*\|\s*(SUB-[0-9-]+)', t3.replace('\n', ' | '))
                    cyc['order_no'] = m3.group(1) if m3 else None
                ok3 = fr3 is not None and click(fr3, '查询原订单和资格'); cyc['query'] = bool(ok3)
                fr4 = wait_scene('P-M07-RENEW-RESULT')
                cyc['valid_to'] = None
                if fr4:
                    t4 = fr4.evaluate(STATE_JS)['text']
                    m4 = re.search(r'有效至\s*\|\s*([0-9-]+)', t4.replace('\n', ' | '))
                    cyc['valid_to'] = m4.group(1) if m4 else None
                ok4 = fr4 is not None and click(fr4, '返回我的圈子'); cyc['to_list'] = bool(ok4)
                fr5 = wait_scene('P-M07-LIST-RENEWED')
                cyc['list_scene'] = fr5 is not None
                ok5 = fr5 is not None and click(fr5, '查看详情', scope='晨星设计圈', exclude=['晨星增长圈', '数据工坊圈', '星河年度圈']); cyc['to_detail'] = bool(ok5)
                fr6 = wait_scene('P-M07-DETAIL-PAID')
                cyc['detail_scene'] = page.evaluate("() => document.body.dataset.currentScene") if not fr6 else 'P-M07-DETAIL-PAID'
                ok6 = fr6 is not None and click(fr6, '订阅'); cyc['to_sub_tab'] = bool(ok6)
                fr7 = wait_scene('P-M07-DETAIL-PAID-SUBSCRIPTION')
                cyc['sub_scene'] = page.evaluate("() => document.body.dataset.currentScene") if not fr7 else 'P-M07-DETAIL-PAID-SUBSCRIPTION'
                ok7 = fr7 is not None and click(fr7, '续费'); cyc['to_renew'] = bool(ok7)
                fr = wait_scene('P-M07-RENEW')
                cyc['renew_again'] = fr is not None
                out['cycles'].append(cyc)
                print(f"cycle {i}: steps web={ok1} ret={ok2} query={ok3} list={ok4} detail={ok5}(→{cyc['detail_scene']}) sub={ok6}(→{cyc['sub_scene']}) renew={ok7} back={cyc['renew_again']} | quote={cyc['quote_window']} order={cyc['order_no']} valid_to={cyc['valid_to']}", flush=True)
                if not all([ok1, ok2, ok3, ok4, ok5, ok6, ok7, fr]):
                    out['notes'].append(f'cycle {i} broken')
                    print(f"cycle {i} BROKEN", flush=True)
                    break

            # 12th renewal offer
            st = fr.evaluate(STATE_JS) if fr else None
            out['cap_state'] = st
            if st:
                print('cycle 12 offer: limit_entry=', st['limit_entry'], 'pay_button=', st['pay_button'], flush=True)
            cap_clicked = False
            if st and st['limit_entry'] and st['limit_entry']['visible'] and not st['limit_entry']['disabled']:
                cap_clicked = click(fr, '查看续费限制')
            fr_cap = wait_scene('P-M07-RENEW-LIMIT', 12)
            out['cap_scene'] = {
                'clicked': cap_clicked,
                'arrived': fr_cap is not None,
                'text': fr_cap.evaluate(STATE_JS)['text'] if fr_cap else None
            }
            print('cap click:', cap_clicked, 'arrived RENEW-LIMIT:', fr_cap is not None, flush=True)
            if fr_cap:
                print(fr_cap.evaluate(STATE_JS)['text'][:320].replace('\n', ' | '), flush=True)
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

(OUT / 'probe-renew-cap-replay.json').write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
print('saved probe-renew-cap-replay.json; cycles:', len(out['cycles']))
