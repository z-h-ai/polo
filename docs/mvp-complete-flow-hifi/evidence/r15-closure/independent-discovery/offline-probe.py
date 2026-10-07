from playwright.sync_api import sync_playwright
from pathlib import Path
import json
r=Path.cwd();o=Path('/tmp/polo-closure-semantic-candidate');logs=[]
with sync_playwright() as p:
 b=p.chromium.launch();pg=b.new_page(viewport={'width':1600,'height':1100});pg.goto((r/'docs/mvp-complete-flow-hifi/review.html').as_uri()+'#scene=P-M11-OFFLINE-HOME');pg.wait_for_timeout(250)
 f=pg.frames[1];f.locator('.scene.active').get_by_role('button',name='管理技能',exact=True).click();pg.wait_for_timeout(250)
 a=next(f for f in pg.frames[1:] if 'source-baseline' in f.url);logs.append({'step':'offline-to-skills','scene':a.locator('body').get_attribute('data-current-scene')})
 a.get_by_role('button',name='打开 Polo 助手',exact=True).click();pg.wait_for_timeout(120);a.get_by_role('textbox',name='消息',exact=True).fill('离线时不应发送的新任务');btn=a.get_by_role('button',name='发送消息',exact=True);logs.append({'step':'offline-send-control','enabled':btn.is_enabled(),'scene':a.locator('body').get_attribute('data-current-scene')})
 if btn.is_enabled():btn.click();pg.wait_for_timeout(120)
 logs.append({'step':'after-send','scene':a.locator('body').get_attribute('data-current-scene'),'text':a.locator('[data-product-surface]').inner_text()});pg.screenshot(path=str(o/'offline-via-skills.png'));(o/'offline-probe-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2));print(json.dumps(logs,ensure_ascii=False));b.close()
