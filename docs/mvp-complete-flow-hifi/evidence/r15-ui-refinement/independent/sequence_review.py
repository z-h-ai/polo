from pathlib import Path
from playwright.sync_api import sync_playwright
import json
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/independent';rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def cur():return q.locator('.scene.active').get_attribute('data-prototype-scene')
 def start(scene='P-M02-CONFIRM'):
  q.goto((R/'docs/mvp-complete-flow-hifi/prototype.html').as_uri()+'?scene='+scene);q.wait_for_timeout(50)
 def command(scene,kind='show-scene',epoch=1):
  q.evaluate('(d)=>postMessage(d,"*")',{'type':'product-ui-prototype:'+kind,'version':1,'session':'independent-sequence','epoch':epoch,'scene':scene});q.wait_for_timeout(40)
 def play():q.locator('.scene.active').get_by_text('停止全部并切换',exact=True).click()
 def save(case,w,expected):
  actual=cur();rows.append({'case':case,'viewport':w,'expected':expected,'actual':actual,'passed':actual==expected});(O/'sequence-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));assert actual==expected,(case,w,actual,expected)
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  start();play();q.wait_for_timeout(2100);save('confirmation-automatic-completion',w,'P-M03-HOME-PERSONAL')
  start('P-M02-STOPPING');q.wait_for_timeout(2100);save('direct-review-progress-stays-static',w,'P-M02-STOPPING')
  start();play();q.wait_for_timeout(100);command('P-M02-TARGET-LOADING');command('P-M02-STOPPING',epoch=2);q.wait_for_timeout(2100);save('leave-and-reenter-progress-cancels-old-callback',w,'P-M02-STOPPING')
  start();play();q.wait_for_timeout(100);command('P-M02-STOPPING',kind='reset');q.wait_for_timeout(2100);save('reset-progress-cancels-old-callback',w,'P-M02-STOPPING')
  start();play();q.wait_for_timeout(100);q.locator('.scene.active').get_by_text('取消切换',exact=True).click();q.wait_for_timeout(2100);save('cancel-progress-keeps-original-space',w,'P-M02-STOP-CANCEL')
  start();play();q.wait_for_timeout(100);command('P-M02-CONFIRM');q.wait_for_timeout(2100);save('review-navigation-away-cancels',w,'P-M02-CONFIRM')
  start();command('P-M02-CONFIRM');play();q.wait_for_timeout(100);command('P-M02-STOPPING',kind='suspend');q.wait_for_timeout(2100);save('surface-suspend-cancels',w,'P-M02-STOPPING')
 # stop must await actual running assistant ack; a withheld ack cannot become success
 start();command('P-M02-CONFIRM');q.evaluate('''()=>postMessage({type:'product-ui-prototype:peer',version:1,session:'independent-sequence',channel:'polo-workbench',payload:{kind:'assistant-activity',states:{enterprise:{running:true}}}},'*')''');q.wait_for_timeout(40);play();q.wait_for_timeout(4800);save('missing-real-assistant-stop-ack-blocks-switch',800,'P-M02-STOP-FAILED')
 # review-shell echo must not break real automatic progress
 q.set_viewport_size({'width':1440,'height':900});q.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri()+'#scene=P-M02-CONFIRM');q.wait_for_timeout(250);f=[f for f in q.frames if 'prototype.html' in f.url and 'mvp-complete-flow' in f.url][0];f.locator('.scene.active').get_by_text('停止全部并切换',exact=True).click();q.wait_for_timeout(2400);actual=q.locator('body').get_attribute('data-current-scene');rows.append({'case':'review-shell-product-flow-with-echo','actual':actual,'expected':'P-M03-HOME-PERSONAL','passed':actual=='P-M03-HOME-PERSONAL'});assert actual=='P-M03-HOME-PERSONAL';q.screenshot(path=str(O/'automatic-switch-shell.png'))
 b.close()
(O/'sequence-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('checks',len(rows))
