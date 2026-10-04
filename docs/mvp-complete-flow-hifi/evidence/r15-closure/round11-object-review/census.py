#!/usr/bin/env python3
"""Independent census: render every manifest scene x 3 declared viewports.
Reviewer: zcode-subagent-object-final-r15c-v2 (object/permission/lifecycle perspective).
Only reads allowed inputs; writes only into its own evidence dir.
"""
import json, subprocess, sys, time, os, re
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'
PORT = 8931
BASE = f'http://127.0.0.1:{PORT}'
REVIEW = f'{BASE}/docs/mvp-complete-flow-hifi/review.html'

manifest = json.load(open(ROOT / 'docs/mvp-complete-flow-hifi/prototype-manifest.json'))
scenes = manifest['scenes']
scene_ids = [s['id'] for s in scenes]
surface_of = {s['id']: (s.get('surface') or 'mvp') for s in scenes}

VIEWPORTS = [('desktop-1440x900', 1440, 900), ('desktop-1024x768', 1024, 768), ('desktop-800x600', 800, 600)]

# key scenes for screenshots (probe-relevant + representative states per module)
KEY_PAT = [
    r'^P-M01-(LOGIN|PERSONAL-PREP|INVITE|REFRESH|COLD|CREATE|RETURN|ENTERPRISE)',
    r'^P-M02-', r'^P-M03-', r'^P-M04-(APP-VIEW|PREPARE|CLOSE|TERM|RUNTIME|REPORT|PERM)',
    r'^P-M07-', r'^P-M09-', r'^P-M10-', r'^P-M11-',
    r'^A-personal-(skills|discover|acquire|enabledpending|installing|installfailed|installed|enabled|detail|updated|updatefailed|remove|uninstalled|denied|restricted|fallback|reauthorized|builtinoff|builtinon|question|reopen|answered|deferred|expired|deleted|preblock|cut|checking|notyet|queryfailed|resumed|return|transfer-|legacy-isolation|close|closefailed|files|missing|reselected)',
    r'^A-enterprise-(skills|restricted|fallback|reauthorized|preblock|cut|notify|notified|budget|ownerreturn|ownerblock|ownerresumed|transfer-import|transfer-preview|transfer-done|legacy-isolation)',
]
KEY_RE = re.compile('|'.join(KEY_PAT))

from playwright.sync_api import sync_playwright

server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
                          cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

jsonl_path = OUT / 'census.jsonl'
screens_dir = OUT / 'screenshots'
jsonl = open(jsonl_path, 'w', encoding='utf-8')

stats = {'scene_viewport_observations': 0, 'page_errors': 0, 'external_requests': 0,
         'console_errors': 0, 'timeouts': 0, 'screenshots': 0}
error_samples = []
external_samples = []

GET_ACTIVE_JS = "() => { const el = document.querySelector('.scene.active[data-prototype-scene]'); if (el) return el.getAttribute('data-prototype-scene'); const el2 = document.querySelector('[data-prototype-scene]'); return el2 ? el2.getAttribute('data-prototype-scene') : ''; }"

EXTRACT_JS = """
() => {
  const doc = document;
  const sceneEl = doc.querySelector('.scene.active[data-prototype-scene]') || doc.querySelector('[data-prototype-scene]');
  if (!sceneEl) return {ok:false, reason:'no-scene-el'};
  const sceneAttr = sceneEl.getAttribute('data-prototype-scene')||'';
  const text = (sceneEl ? sceneEl.innerText : doc.body.innerText) || '';
  const ctrls = [];
  const root = sceneEl || doc.body;
  const nodes = root.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [role="link"], summary');
  for (const el of nodes) {
    if (ctrls.length >= 300) break;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    ctrls.push({
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g,' ').slice(0,140),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      checked: (el.getAttribute('aria-checked') !== null ? el.getAttribute('aria-checked') : (typeof el.checked === 'boolean' ? String(el.checked) : null)),
      role: el.getAttribute('role'),
      type: el.getAttribute('type')
    });
  }
  return {ok:true, sceneAttr, text: text.slice(0,14000), controls: ctrls};
}
"""

def wait_scene(page, frame, sid, deadline_s=8):
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            cur = page.evaluate("() => document.body.dataset.currentScene")
            if cur == sid:
                st = frame.evaluate(GET_ACTIVE_JS)
                if st == sid:
                    return True
        except Exception:
            pass
        time.sleep(0.08)
    return False

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for vp_name, w, h in VIEWPORTS:
        page = browser.new_page(viewport={'width': w, 'height': h})
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)[:300]))
        console_errors = []
        page.on('console', lambda m: console_errors.append(m.text[:200]) if m.type == 'error' else None)
        external = []
        def on_request(req):
            u = req.url
            if not u.startswith(BASE):
                external.append(u[:300])
        page.on('request', on_request)
        page.on('dialog', lambda d: d.dismiss())
        page.goto(REVIEW, wait_until='networkidle', timeout=30000)
        page.wait_for_selector('[data-prototype-viewport]', timeout=15000)
        time.sleep(1.5)
        for sid in scene_ids:
            # reset demo state, then navigate via hash router
            try:
                page.evaluate("() => { const b = document.querySelector('[data-reset]'); if (b) b.click(); }")
            except Exception:
                pass
            time.sleep(0.12)
            page.evaluate(f"() => {{ location.hash = '#scene={sid}'; }}")
            owner = surface_of[sid]
            frame = None
            for f in page.frames:
                if owner == 'assistant' and 'polo-client-source-baseline/prototype.html' in f.url:
                    frame = f; break
                if owner == 'mvp' and re.search(r'/docs/mvp-complete-flow-hifi/prototype\.html', f.url):
                    frame = f; break
            ok = wait_scene(page, frame, sid) if frame else False
            rec = {'viewport': vp_name, 'scene': sid, 'surface': owner, 'rendered': bool(ok)}
            if ok:
                data = frame.evaluate(EXTRACT_JS, owner)
                rec['iframe_scene'] = data.get('sceneAttr')
                rec['text'] = data.get('text','')
                rec['controls'] = data.get('controls', [])
                stats['scene_viewport_observations'] += 1
            else:
                rec['text'] = ''; rec['controls'] = []
                stats['timeouts'] += 1
                rec['note'] = 'timeout waiting for scene'
            if page_errors:
                rec['pageerror_count'] = len(page_errors)
            jsonl.write(json.dumps(rec, ensure_ascii=False) + '\n')
            if stats['scene_viewport_observations'] % 25 == 0:
                jsonl.flush()
            if KEY_RE.match(sid):
                shot = screens_dir / vp_name / f'{sid}.png'
                shot.parent.mkdir(parents=True, exist_ok=True)
                try:
                    page.screenshot(path=str(shot), full_page=False)
                    stats['screenshots'] += 1
                except Exception:
                    pass
        stats['page_errors'] += len(page_errors)
        stats['console_errors'] += len(console_errors)
        stats['external_requests'] += len(external)
        error_samples.extend([{'viewport': vp_name, 'error': e} for e in page_errors[:10]])
        external_samples.extend([{'viewport': vp_name, 'url': u} for u in external[:10]])
        page.close()
    browser.close()

server.terminate()
try:
    server.wait(timeout=5)
except Exception:
    server.kill()

jsonl.close()
summary = {'scenes_in_manifest': len(scene_ids), 'viewports': len(VIEWPORTS),
           'expected_observations': len(scene_ids)*len(VIEWPORTS), **stats,
           'pageerror_samples': error_samples, 'external_request_samples': external_samples}
(OUT / 'census-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
