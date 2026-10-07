#!/usr/bin/env python3
"""Review-only controls must preserve mounted product state and never send."""
import hashlib,json
from pathlib import Path
import os
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';O=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r12');checks=[]
def check(name,ok):checks.append({'check':name,'passed':bool(ok)});print(name,ok)
with sync_playwright() as pw:
 browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':900});page.goto((B/'review.html').as_uri()+'#story=AS-personal&step=AS-personal-2&scene=P-M03-HOME-ENT');page.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-new'")
 f=page.locator('[data-assistant-viewport]').element_handle().content_frame();f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-new'")
 check('step wins over mismatched scene','scene=A-personal-new' in page.url)
 f.get_by_role('textbox',name='消息',exact=True).fill('只浏览，不发送这段草稿')
 page.locator('[data-flow-next]').click();page.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-generating'");f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-generating'")
 check('next does not send','只浏览，不发送这段草稿' not in f.locator('.mvp-transcript').inner_text());page.locator('[data-flow-prev]').click();f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-new'");check('prev keeps draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='只浏览，不发送这段草稿')
 page.locator('[data-scene-link="P-M03-HOME-ENT"]').evaluate('(e)=>e.click()');page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-ENT'");check('off-flow return available',page.locator('[data-branch-return]').is_visible());page.locator('[data-branch-return]').click();f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-new'");check('return to flow retains draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='只浏览，不发送这段草稿')
 page.set_viewport_size({'width':800,'height':600});page.locator('[data-viewport-select]').select_option('desktop-800x600',force=True);page.wait_for_timeout(100)
 check('800x600 actual frame',f.evaluate('[innerWidth,innerHeight]')==[800,600])
 page.locator('[data-inspector-tab="settings"]').evaluate('(e)=>e.click()');count=page.locator('iframe').count();check('narrow inspector keeps flow visible',page.locator('[data-flow-position]').is_visible());page.keyboard.press('Escape');check('narrow inspector keeps frames mounted',page.locator('iframe').count()==count);check('narrow panel keeps draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='只浏览，不发送这段草稿')
 if not f.locator('.source-sidebar').count():f.get_by_role('button',name='切换侧栏').click()
 check('narrow sidebar drawer reachable',f.locator('.source-sidebar').is_visible());f.get_by_role('button',name='切换侧栏').click();check('narrow sidebar closes',f.locator('.source-sidebar').count()==0)
 page.screenshot(path=str(O/'review-800x600.png'))
 # Keep a data-source form through an actual surface roundtrip.
 page.set_viewport_size({'width':1440,'height':900});page.evaluate("location.hash='scene=A-personal-sourceauth'");f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-sourceauth'");f.get_by_label('访问凭证').fill('fixture-form-value');page.evaluate("location.hash='scene=P-M03-HOME-PERSONAL'");page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-PERSONAL'");page.evaluate("location.hash='scene=A-personal-sourceauth'");f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-sourceauth'");check('surface roundtrip keeps form',f.get_by_label('访问凭证').input_value()=='fixture-form-value')
 # Unknown/stale parent messages are rejected even from the expected window.
 before=f.evaluate('document.body.dataset.currentScene');page.evaluate("document.querySelector('[data-assistant-viewport]').contentWindow.postMessage({type:'product-ui-prototype:show-scene',version:1,session:'forged',epoch:0,scene:'A-enterprise-new'},'*')");page.wait_for_timeout(100);check('wrong session rejected',f.evaluate('document.body.dataset.currentScene')==before)
 browser.close()
report={'passed':all(c['passed'] for c in checks),'checks':checks,'artifacts':{str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'review.html',B/'prototype.html',R/'design-demos/polo-client-source-baseline/prototype.html']}}
(O/'review-continuity.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');raise SystemExit(0 if report['passed'] else 1)
