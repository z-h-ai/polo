import json
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'); O=Path('/tmp/polo-final-journeys');log=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True);p=b.new_page(viewport={'width':1700,'height':1100});p.on('dialog',lambda d:d.dismiss())
 def frame():return p.locator('iframe:not([hidden])').element_handle().content_frame()
 def snap(label):
  f=frame(); row={'label':label,'scene':p.locator('body').get_attribute('data-current-scene'),'text':f.locator('body').inner_text(),'controls':f.locator('button:visible,input:visible,textarea:visible').evaluate_all('(es)=>es.map(e=>({text:e.innerText||e.getAttribute("aria-label")||"",go:e.dataset.go,tr:e.dataset.transition,disabled:e.disabled}))')};log.append(row);(O/'probes.json').write_text(json.dumps(log,ensure_ascii=False,indent=2));return row
 def fresh(scene):
  p.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri());p.wait_for_timeout(350);p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(250);snap('entry '+scene)
 def click(text,wait=150):
  frame().get_by_role('button',name=text,exact=True).last.click();p.wait_for_timeout(wait);snap('click '+text)
 def go(scene):p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(200);snap('review entry '+scene)
 def shot(name):frame().locator('body').screenshot(path=str(O/(name+'.png')))
 for name,fn in [
 ('revocation',lambda:(fresh('P-M11-REVOKE'),click('回到空间切换'),shot('revocation-switcher'))),
 ('first-login',lambda:(fresh('P-M01-LOGIN-PASSWORD'),click('继续'),click('进入首页'),shot('first-home'))),
 ('circle-data',lambda:(fresh('P-M07-LEAVE-DATA'),click('取消'),click('退出圈子'),click('确认退出'),click('首页'),shot('data-left-home'))),
 ('switch',lambda:(fresh('P-M02-CONFIRM'),click('停止全部并切换',2200),shot('switched-personal'))),
 ('offline',lambda:(fresh('P-M11-OFFLINE-HOME'),shot('offline'),click('重新连接'),shot('reconnected'))),
 ('contract',lambda:(fresh('P-M11-CONTRACT'),click('稍后处理'),click('下载并安装'),shot('contract-download'))),
 ('renewal',lambda:(fresh('P-M07-RENEW-RETURN'),click('查询原订单和资格'),click('返回我的圈子'),click('首页'),click('我的圈子'),shot('renewed-list'))),
 ('source-restore',lambda:(fresh('A-personal-sourceauth'),click('取消'),shot('source-cancel')))
 ]:
  try:fn()
  except Exception as e:log.append({'probe':name,'error':str(e)});(O/'probes.json').write_text(json.dumps(log,ensure_ascii=False,indent=2))
 b.close()
