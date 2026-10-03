from playwright.sync_api import sync_playwright
from pathlib import Path
import json,hashlib,time
r=Path.cwd(); out=Path('/tmp/polo-closure-semantic-candidate'); logs=[]
with sync_playwright() as p:
 b=p.chromium.launch(); page=b.new_page(viewport={'width':1600,'height':1100})
 page.goto((r/'docs/mvp-complete-flow-hifi/review.html').as_uri()+'#scene=P-M02-CONFIRM-PERSONAL');page.wait_for_timeout(500)
 print('functions',page.evaluate('typeof browseTo'))
 frame=page.frames[1]
 print('current',frame.locator('body').get_attribute('data-current-scene'))
 frame.locator('.scene.active').get_by_role('button',name='停止全部并切换',exact=True).click()
 page.wait_for_timeout(1250)
 logs.append({'case':'personal-switch-target-loading','scene':frame.locator('body').get_attribute('data-current-scene'),'text':frame.locator('.scene.active').inner_text()})
 page.screenshot(path=str(out/'personal-switch-loading.png'))
 page.wait_for_timeout(900)
 logs.append({'case':'personal-switch-final','scene':frame.locator('body').get_attribute('data-current-scene'),'text':frame.locator('.scene.active').inner_text()[:300]})
 (out/'probe-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2));print(json.dumps(logs,ensure_ascii=False))
 b.close()
