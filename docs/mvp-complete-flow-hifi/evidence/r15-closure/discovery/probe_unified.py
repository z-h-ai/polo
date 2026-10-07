from playwright.sync_api import sync_playwright
from pathlib import Path
import json,hashlib
ROOT=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'); OUT=Path('/tmp/polo-closure-discovery')
base=(ROOT/'docs/mvp-complete-flow-hifi/review.html').as_uri()
records=[]
with sync_playwright() as pw:
 b=pw.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(5000)
 def start(scene):page.goto(base+'#scene='+scene);page.wait_for_timeout(350)
 def active():return page.frame_locator('iframe[data-prototype-viewport]').locator('.scene.active')
 def snap(name):
  d={'name':name,'scene':page.frame_locator('iframe[data-prototype-viewport]').locator('body').get_attribute('data-current-scene'),'text':active().inner_text()};records.append(d);(OUT/'unified-browser-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));page.screenshot(path=str(OUT/('unified-'+name+'.png')),full_page=True);return d
 def click(text,exact=True):active().get_by_role('button',name=text,exact=exact).click();page.wait_for_timeout(140)
 start('P-M10-MENU');snap('creator-before');active().locator('.menu-row').filter(has_text='创作者工作台').click();snap('creator-after');click('取消');snap('creator-return')
 start('P-M11-CONTRACT');snap('contract-before');click('先用个人空间');snap('contract-after');active().locator('[data-app-key="growth"] [data-go]').click();snap('contract-app-open')
 start('P-M04-RUNTIME-PERSONAL');snap('report-before');click('停止');snap('report-stopped');click('后台任务');snap('report-running-again')
 start('P-M07-DETAIL-PAID-SUBSCRIPTION');click('退出圈子');snap('paid-leave-confirm');click('确认退出');snap('paid-leave-result');active().locator('[data-go="P-M03-HOME-PERSONAL"]').first.click();snap('paid-leave-home');active().locator('[data-app-key="brand"] [data-go]').click();snap('paid-leave-brand-open')
 start('P-M11-REOPEN-RECOVERY');snap('reopen-before')
 start('P-M11-OFFLINE-HOME');snap('offline-before');active().locator('[data-app-key="brand"] [data-go]').click();snap('offline-app-open')
 b.close()
(OUT/'unified-browser-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2))
(OUT/'fingerprints.json').write_text(json.dumps({str(f):hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in map(Path,['docs/client-journey-review/spec.md','docs/mvp-complete-flow-hifi/prototype.html','docs/mvp-complete-flow-hifi/prototype-manifest.json','docs/mvp-complete-flow-hifi/review.html'])},indent=2))
print(json.dumps(records,ensure_ascii=False,indent=2))
