import json
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'); O=Path('/tmp/polo-final-journeys');log=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True);p=b.new_page(viewport={'width':1700,'height':1100});p.set_default_timeout(4000);p.on('dialog',lambda d:d.dismiss())
 def frame():return p.locator('iframe:not([hidden])').element_handle().content_frame()
 def snap(label):
  f=frame(); row={'label':label,'scene':p.locator('body').get_attribute('data-current-scene'),'text':f.locator('body').inner_text(),'controls':f.locator('button:visible,input:visible,textarea:visible').evaluate_all('(es)=>es.map(e=>({text:e.innerText||e.getAttribute("aria-label")||"",go:e.dataset.go,tr:e.dataset.transition,disabled:e.disabled}))')};log.append(row);(O/'circle-consumers.json').write_text(json.dumps(log,ensure_ascii=False,indent=2));return row
 def fresh(scene):
  p.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri());p.wait_for_timeout(350);p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(250);snap('entry '+scene)
 def click(text,wait=150):
  frame().get_by_role('button',name=text,exact=True).last.click();p.wait_for_timeout(wait);snap('click '+text)
 def go(scene):p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(200);snap('review entry '+scene)
 def shot(name):frame().locator('body').screenshot(path=str(O/(name+'.png')))

 fresh('P-M07-DETAIL-PAID-SUBSCRIPTION');click('退出圈子');click('确认退出');click('重新加入圈子');snap('rejoin without purchase facts');shot('paid-rejoin')
 click('返回我的圈子');frame().locator('[data-go="P-M07-DETAIL-FOCUS"]:visible').click();p.wait_for_timeout(150);snap('growth detail after design left');click('订阅');click('退出圈子');click('确认退出');snap('last source exit feedback');shot('last-source-feedback')
 click('我的圈子');snap('all remaining circles');
 b.close()
