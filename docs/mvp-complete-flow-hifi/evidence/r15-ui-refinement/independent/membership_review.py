from pathlib import Path
from playwright.sync_api import sync_playwright
import json
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/independent';rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def active():return q.locator('.scene.active')
 def command(scene,reset=False):
  q.evaluate('(d)=>postMessage(d,"*")',{'type':'product-ui-prototype:'+('reset' if reset else 'show-scene'),'version':1,'session':'independent-membership','epoch':1,'scene':scene});q.wait_for_timeout(70)
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for key,kind,name in [('data','data','数据工坊圈'),('year','annual','星河年度圈')]:
   q.goto((R/'docs/mvp-complete-flow-hifi/prototype.html').as_uri()+'?scene=P-M07-LIST');q.wait_for_timeout(80);active().locator('[data-circle-kind='+kind+']').get_by_text('查看详情',exact=True).click()
   if key=='data':active().get_by_text('订阅',exact=True).click()
   active().get_by_text('退出圈子',exact=True).click();assert name in active().locator('.dialog').inner_text();dialogtext=active().locator('.dialog').inner_text();active().locator('.dialog').get_by_text('取消',exact=True).click();assert q.evaluate('(key)=>window.poloCircleMemberships[key]',key)==True
   active().get_by_text('退出圈子',exact=True).click();active().locator('.dialog').get_by_text('确认退出',exact=True).click();assert active().get_attribute('data-prototype-scene')=='P-M07-LIST';assert not active().locator('[data-circle-kind='+kind+']').is_visible()
   active().get_by_placeholder('圈子或创作者名称').fill(name);assert not active().locator('[data-circle-kind='+kind+']').is_visible();active().get_by_placeholder('圈子或创作者名称').fill('');assert not active().locator('[data-circle-kind='+kind+']').is_visible();assert active().locator('[data-circle-kind=growth]').is_visible() and active().locator('[data-circle-kind=design]').is_visible()
   active().get_by_text('返回首页',exact=True).click();report_visible=active().locator('[data-app-key=report]').is_visible();assert report_visible==(key!='data');assert active().locator('[data-app-key=minutes]').is_visible() if active().locator('[data-app-key=minutes]').count() else True
   command('P-M07-LIST',True);assert active().locator('[data-circle-kind='+kind+']').is_visible();command('P-M03-HOME-PERSONAL');assert active().locator('[data-app-key=report]').is_visible()
   rows.append({'key':key,'viewport':w,'cancel_preserves':True,'confirm_removes_only_this_circle':True,'search_does_not_restore':True,'report_visibility_after_exit':report_visible,'reset_restores':True,'dialog_text':dialogtext});(O/'membership-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
 b.close()
print('checks',len(rows))
