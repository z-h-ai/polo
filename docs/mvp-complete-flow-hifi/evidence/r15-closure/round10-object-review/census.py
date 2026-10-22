#!/usr/bin/env python3
"""round10-object-review 全量渲染普查 v2：manifest 全部场景 x 3 个声明视口。
每场景独立 Reset 后经壳内 data-scene-link 导航，经 Playwright Frame API 采集可见文本与控件。
只读评审：除本评审目录外不写任何文件。"""
import json, sys
from playwright.sync_api import sync_playwright

ROOT = '/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'
OUT = f'{ROOT}/docs/mvp-complete-flow-hifi/evidence/r15-closure/round10-object-review'
RAW = f'{OUT}/raw'
SHOTS = f'{OUT}/screenshots'

manifest = json.load(open(f'{ROOT}/docs/mvp-complete-flow-hifi/prototype-manifest.json'))
scenes = [(s['id'], s.get('surface') or 'mvp', s['title']) for s in manifest['scenes']]
viewports = manifest['target']['viewports']

SCREENSHOT_SCENES = {
 'P-M01-LOGIN-PASSWORD','P-M01-PERSONAL-PREP','P-M01-PERSONAL-PREP-FAIL','P-M01-REOPEN',
 'P-M01-INVITE-BROWSER','P-M01-INVITE-PENDING','P-M01-REFRESH-FAIL','P-M01-COLD-START',
 'P-M02-SWITCHER','P-M02-CONFIRM','P-M02-STOPPING','P-M02-STOP-FAILED','P-M02-STOP-CANCEL',
 'P-M02-TARGET-LOADING','P-M02-TARGET-FAILED','P-M02-ACCESS-LOST',
 'P-M03-HOME-PERSONAL','P-M03-HOME-ZERO','P-M03-HOME-EMPTY-DIR','P-M03-HOME-LOAD-FAIL','P-M03-HOME-OFFLINE','P-M03-HOME-ENT','P-M03-ALL-APPS','P-M03-INSPECTOR','P-M03-CONTROLS',
 'P-M04-APP-VIEW','P-M04-PREPARE','P-M04-CLOSE-ACTIVE','P-M04-TERM-FAILED','P-M04-BACKGROUND','P-M04-PERM-DENIED','P-M04-RUNTIME',
 'P-M07-LIST','P-M07-EMPTY','P-M07-DETAIL-FOCUS','P-M07-JOIN-FREE','P-M07-DETAIL-PAID','P-M07-PAY-BROWSER','P-M07-PAY-RETURN','P-M07-PAY-RETURN-FAIL','P-M07-RENEW','P-M07-RENEW-RESULT','P-M07-RENEW-LIMIT','P-M07-RENEW-EXPIRED','P-M07-EXPIRED','P-M07-ACCOUNT-MISMATCH','P-M07-DETAIL-PAID-AFTER-LEAVE','P-M07-SOURCE-FALLBACK','P-M07-LIST-RENEWED',
 'P-M09-BROWSER-OWNER','P-M11-OFFLINE-RUNNING','P-M11-REOPEN-RECOVERY','P-M11-BLOCKED-EXPIRED','P-M11-GOVERNANCE-PAUSED-MANAGER','P-M11-SUPPORT-ACCOUNT-ADMIN',
 'A-personal-new','A-personal-skills','A-personal-detail','A-personal-conversation','A-enterprise-new','A-enterprise-skills',
 'A-personal-question','A-personal-answered','A-personal-transfer-export','A-personal-transfer-import','A-personal-transfer-preview',
 'A-enterprise-ownerblock','A-enterprise-ownerreturn','A-enterprise-budgetowner','A-personal-builtinoff',
}

CLICK_JS = """(sid) => {
  const esc = (window.CSS && CSS.escape) ? CSS.escape(sid) : sid.replace(/"/g,'\\\\"');
  const btn = document.querySelector('[data-scene-link="' + esc + '"]');
  if (!btn) return false;
  btn.click();
  return true;
}"""

RESET_JS = """() => {
  const rb = document.querySelector('[data-reset]');
  if (rb) { rb.click(); return true; }
  return false;
}"""

COLLECT_JS = """() => {
  const doc = document;
  const vis = el => { const st = doc.defaultView.getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') return false; const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
  const ctrls = [];
  for (const el of doc.querySelectorAll('button, a, input, select, textarea, [role=button], [role=tab], [role=menuitem]')) {
    if (!vis(el)) continue;
    const label = (el.getAttribute('aria-label') || el.textContent || el.value || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ').slice(0,90);
    ctrls.push({tag: el.tagName.toLowerCase(), label, disabled: !!(el.disabled || el.getAttribute('aria-disabled')==='true'), tr: el.getAttribute('data-transition')||null});
  }
  return {scene: doc.body.dataset.currentScene, text: (doc.body.innerText||'').replace(/\\n{3,}/g,'\\n\\n'), controls: ctrls};
}"""

def active_frame(page):
    """返回未隐藏的原型 Frame（Playwright 跨源安全）。"""
    for sel in ('[data-prototype-viewport]', '[data-assistant-viewport]'):
        for el in page.query_selector_all(sel):
            if el.get_attribute('hidden') is None:
                fr = el.content_frame()
                if fr is not None:
                    return fr
    return None

def frame_scene(fr):
    try:
        return fr.evaluate("() => (document.body && document.body.dataset.currentScene) || null")
    except Exception:
        return None

def main():
    jsonl = open(f'{RAW}/census.jsonl', 'w', encoding='utf-8')
    errlog = open(f'{RAW}/census-errors.log', 'w', encoding='utf-8')
    page_errors, external_requests = [], []
    obs_count, shot_count, click_actions = 0, 0, 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--allow-file-access-from-files'])
        try:
            for vp in viewports:
                ctx = browser.new_context(viewport={'width': 1500, 'height': 1000}, device_scale_factor=1)
                page = ctx.new_page()
                page.on('pageerror', lambda e, vp=vp: page_errors.append({'vp': vp['id'], 'error': str(e)[:300]}))
                page.on('request', lambda r, vp=vp: external_requests.append({'vp': vp['id'], 'url': r.url[:300]}) if r.url.startswith('http') else None)
                page.goto(f'file://{ROOT}/docs/mvp-complete-flow-hifi/review.html')
                page.wait_for_selector('[data-prototype-viewport]', timeout=30000)
                fr0 = None
                for _ in range(120):
                    fr0 = active_frame(page)
                    if fr0 and frame_scene(fr0):
                        break
                    page.wait_for_timeout(500)
                if not fr0 or not frame_scene(fr0):
                    print(f"FATAL: initial frame not ready for {vp['id']}", flush=True)
                    sys.exit(2)
                # 打开页面索引面板，使全部 data-scene-link 存在
                page.evaluate("() => { const b=document.querySelector('[data-panel-entry=\"index\"]'); if (b) b.click(); }")
                page.wait_for_function("() => document.querySelectorAll('[data-scene-link]').length > 100", timeout=30000)
                page.evaluate("""(vpid) => {
                    const sel = document.querySelector('[data-viewport-select]');
                    sel.value = vpid;
                    sel.dispatchEvent(new Event('change', {bubbles: true}));
                }""", vp['id'])
                page.wait_for_timeout(400)
                seen_assistant = False
                for idx, (sid, surface, title) in enumerate(scenes):
                    # 每场景前独立 Reset，避免上一场景演示状态泄漏
                    try:
                        page.evaluate(RESET_JS)
                    except Exception:
                        pass
                    ok = False
                    try:
                        ok = page.evaluate(CLICK_JS, sid)
                    except Exception as e:
                        errlog.write(json.dumps({'vp': vp['id'], 'scene': sid, 'click_error': str(e)[:200]}, ensure_ascii=False) + '\n')
                    row = {'viewport': vp['id'], 'scene': sid, 'surface': surface, 'title': title, 'nav_ok': bool(ok)}
                    if ok:
                        click_actions += 1
                        need = 25000 if (surface == 'assistant' and not seen_assistant) else 7000
                        observed = None
                        elapsed = 0
                        while elapsed < need:
                            fr = active_frame(page)
                            observed = frame_scene(fr) if fr else None
                            if observed == sid:
                                break
                            page.wait_for_timeout(60)
                            elapsed += 60
                        if observed == sid:
                            if surface == 'assistant':
                                seen_assistant = True
                            data = fr.evaluate(COLLECT_JS)
                            row['observed_scene'] = data['scene']
                            row['text'] = data['text']
                            row['controls'] = data['controls']
                            row['n_controls'] = len(data['controls'])
                            obs_count += 1
                            if vp['id'] == 'desktop-1440x900' and sid in SCREENSHOT_SCENES:
                                try:
                                    fr.locator('body').screenshot(path=f'{SHOTS}/{sid}@1440.png', timeout=10000)
                                    shot_count += 1
                                except Exception as e:
                                    errlog.write(json.dumps({'vp': vp['id'], 'scene': sid, 'screenshot_error': str(e)[:200]}, ensure_ascii=False) + '\n')
                        else:
                            row['nav_ok'] = False
                            row['nav_reason'] = 'timeout'
                            row['observed_scene'] = observed
                            errlog.write(json.dumps({'vp': vp['id'], 'scene': sid, 'nav': 'timeout', 'observed': observed}, ensure_ascii=False) + '\n')
                    else:
                        row['nav_reason'] = 'no-scene-link'
                        errlog.write(json.dumps({'vp': vp['id'], 'scene': sid, 'nav': 'no-scene-link'}, ensure_ascii=False) + '\n')
                    jsonl.write(json.dumps(row, ensure_ascii=False) + '\n')
                    if (idx + 1) % 50 == 0:
                        print(f"[{vp['id']}] {idx+1}/{len(scenes)} obs={obs_count} shots={shot_count}", flush=True)
                ctx.close()
        finally:
            jsonl.close(); errlog.close()
            try:
                browser.close()
            except Exception:
                pass
    summary = {
        'scene_viewport_observations': obs_count,
        'scenes_total': len(scenes),
        'viewports': [v['id'] for v in viewports],
        'screenshots': shot_count,
        'scene_link_clicks': click_actions,
        'page_errors': page_errors,
        'external_requests': external_requests,
        'page_error_count': len(page_errors),
        'external_request_count': len(external_requests),
    }
    json.dump(summary, open(f'{RAW}/census-summary.json', 'w'), ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k not in ('page_errors', 'external_requests')}, ensure_ascii=False))

if __name__ == '__main__':
    main()
