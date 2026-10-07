from playwright.sync_api import sync_playwright
from pathlib import Path
import json,time,hashlib
r=Path.cwd();o=Path('/tmp/polo-closure-semantic-candidate');logs=[]
with sync_playwright() as p:
 b=p.chromium.launch();pg=b.new_page(viewport={'width':1600,'height':1100})
 def load(scene):
  pg.goto((r/'docs/mvp-complete-flow-hifi/review.html').as_uri()+'#scene='+scene);pg.wait_for_timeout(220)
  f=next(f for f in pg.frames[1:] if ('source-baseline' in f.url)==scene.startswith('A-'))
  f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=scene);return f
 def frame():return next(f for f in pg.frames[1:] if f.locator('[data-prototype-scene]:visible').count())
 def record(case):
  f=frame();loc=f.locator('[data-prototype-scene]:visible');logs.append({'case':case,'scene':f.locator('body').get_attribute('data-current-scene'),'text':loc.inner_text()});pg.screenshot(path=str(o/(case+'.png')));(o/'risk-probe-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2))
 f=load('P-M07-RENEW-RETURN');f.locator('.scene.active').get_by_role('button',name='查询原订单和资格',exact=True).click();pg.wait_for_timeout(80);record('renew-result')
 frame().locator('.scene.active').get_by_role('button',name='返回我的圈子',exact=True).click();pg.wait_for_timeout(80);record('renew-list')
 frame().locator('.scene.active [data-circle-kind="design"]').get_by_role('button',name='查看详情',exact=True).click();pg.wait_for_timeout(80);record('renew-detail')
 frame().locator('.scene.active').get_by_role('button',name='返回我的圈子',exact=True).click();pg.wait_for_timeout(80)
 frame().locator('.scene.active').get_by_role('button',name='返回首页',exact=True).click();pg.wait_for_timeout(80)
 frame().locator('.scene.active').get_by_role('button',name='我的圈子',exact=True).click();pg.wait_for_timeout(80);record('renew-reenter-list')
 dialogs=[]
 pg.on('dialog',lambda d:(dialogs.append(d.message),d.dismiss()))
 f=load('A-personal-preferences');f.get_by_role('button',name='回答偏好',exact=True).click();f.get_by_role('textbox',name='助手如何称呼你',exact=True).fill('未保存测试');f.get_by_role('button',name='返回助手',exact=True).click();pg.wait_for_timeout(100);record('preferences-return');logs[-1]['dialogs']=dialogs[:]
 f=load('A-personal-installed');f.get_by_role('button',name='查看内置技能').click();record('builtin-before');f.get_by_role('button',name='停用内置技能',exact=True).click();pg.wait_for_timeout(100);record('builtin-after');f.get_by_role('button',name='查看来源技能').click();record('circle-after-builtin')
 (o/'risk-probe-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2));b.close()
for x in logs:print(x['case'],x['scene'],x.get('dialogs'),x['text'][-800:])
