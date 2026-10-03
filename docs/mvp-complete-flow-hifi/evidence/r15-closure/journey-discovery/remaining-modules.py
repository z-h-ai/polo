import json
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'); O=Path('/tmp/polo-final-journeys');log=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(headless=True);p=b.new_page(viewport={'width':1700,'height':1100});p.set_default_timeout(3500);p.on('dialog',lambda d:d.dismiss())
 def frame():return p.locator('iframe:not([hidden])').element_handle().content_frame()
 def snap(label):
  f=frame(); row={'label':label,'scene':p.locator('body').get_attribute('data-current-scene'),'text':f.locator('body').inner_text(),'controls':f.locator('button:visible,input:visible,textarea:visible').evaluate_all('(es)=>es.map(e=>({text:e.innerText||e.getAttribute("aria-label")||"",go:e.dataset.go,tr:e.dataset.transition,disabled:e.disabled}))')};log.append(row);(O/'remaining-modules.json').write_text(json.dumps(log,ensure_ascii=False,indent=2));return row
 def fresh(scene):
  p.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri());p.wait_for_timeout(350);p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(250);snap('entry '+scene)
 def click(text,wait=150):
  frame().get_by_role('button',name=text,exact=True).last.click();p.wait_for_timeout(wait);snap('click '+text)
 def go(scene):p.locator('[data-scene-link="'+scene+'"]').evaluate('(e)=>e.click()');p.wait_for_timeout(200);snap('review entry '+scene)
 def shot(name):frame().locator('body').screenshot(path=str(O/(name+'.png')))

 for scene in ['A-personal-question','A-personal-files','A-personal-preblock','P-M10-SETTINGS-DEVICE','P-M01-INVITE-PENDING','P-M01-RETURN','P-M04-PERM-DENIED','P-M09-APP-BANNER']:
  try:
   fresh(scene)
   if scene.endswith('question'):
    frame().locator('textarea').first.fill('上周');snap('answer draft');click('提交回答');snap('answer submitted');click('首页');click('打开助手');snap('new session does not receive old answer')
   if scene.endswith('-files'):click('查看生成文件');click('回到原对话');snap('file returns original conversation')
   if scene.endswith('preblock'):
    frame().locator('textarea').first.fill('新的请求');snap('blocked draft');click('去充值');click('返回 Polo');snap('no auto query');click('还没有');snap('draft retained')
   if scene=='P-M10-SETTINGS-DEVICE':
    frame().locator('select[data-global-pref]').first.select_option(index=1);snap('settings edited');click('首页');snap('cancel navigation keeps settings draft')
   if scene=='P-M01-INVITE-PENDING':click('进入我的空间')
   if scene=='P-M01-RETURN':click('查询企业资格')
   if scene=='P-M04-PERM-DENIED':click('稍后再说')
   if scene=='P-M09-APP-BANNER':click('通知管理员');click('通知所有者');snap('App insufficient credits recipient')
  except Exception as e:
   log.append({'probe':scene,'error':str(e)});(O/'remaining-modules.json').write_text(json.dumps(log,ensure_ascii=False,indent=2))
 b.close()
