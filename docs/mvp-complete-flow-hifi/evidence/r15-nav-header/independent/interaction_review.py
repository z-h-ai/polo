from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path.cwd();OUT=ROOT/'docs/mvp-complete-flow-hifi/evidence/r15-nav-header/independent'; URL=(ROOT/'docs/mvp-complete-flow-hifi/review.html').as_uri();rows=[]
JS='''()=>{const s=[...document.querySelectorAll('[data-prototype-scene]')].find(x=>x.getClientRects().length);const h=s.querySelector('.workbench-bar,.polo-host-bar');return{scene:s.dataset.prototypeScene,innerWidth,innerHeight,header:h?{scrolled:h.dataset.scrolled,border:getComputedStyle(h).borderBottomColor,top:h.getBoundingClientRect().top,bottom:h.getBoundingClientRect().bottom}:null,scrollers:[...s.querySelectorAll('*')].filter(x=>x.clientHeight&&x.scrollHeight>x.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(x).overflowY)).map(x=>({cls:x.className,top:x.scrollTop,ch:x.clientHeight,sh:x.scrollHeight}))}}'''
def frame(page):return next(f for f in page.frames[1:] if f.frame_element().is_visible())
def await_scene(page,s):
 page.wait_for_function('(s)=>location.hash.includes(s)',arg=s)
 for _ in range(60):
  f=frame(page)
  try:
   if f.locator('[data-prototype-scene="'+s+'"]').is_visible():return f
  except:pass
  page.wait_for_timeout(50)
 raise Exception('scene not reached '+s)
def snap(page,label):
 page.wait_for_timeout(80);r=frame(page).evaluate(JS);r['label']=label;rows.append(r);return r
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000})
 for width,height in [(1440,900),(1024,768),(800,600)]:
  vp=f'desktop-{width}x{height}'
  def enter(s):
   page.goto(URL+'#scene='+s);page.locator('[data-viewport-select]').select_option(vp,force=True);return await_scene(page,s)
  for scope,scene in [('personal','P-M03-HOME-PERSONAL'),('enterprise','P-M03-HOME-ENT')]:
   f=enter(scene);snap(page,vp+' '+scope+' home at top')
   f.locator('.scene.active [data-app-key=assistant]').get_by_text('管理技能',exact=True).click();f=await_scene(page,'A-'+scope+'-skills');snap(page,vp+' '+scope+' manage skill entry')
   f.get_by_role('button',name='查看来源技能',exact=True).click();snap(page,vp+' '+scope+' detail opened')
   f.locator('.polo-skill-detail').evaluate('(x)=>x.scrollTop=x.scrollHeight');r=snap(page,vp+' '+scope+' nested detail scroll');assert r['header']['scrolled']=='false'
   page.screenshot(path=str(OUT/(vp+'-'+scope+'-skills-detail.png')))
   f.get_by_role('button',name='首页',exact=True).click();f=await_scene(page,scene);snap(page,vp+' '+scope+' home return')
   if scope=='personal':
    f.locator('.scene.active .home-circle-entry').click();f=await_scene(page,'P-M07-LIST');snap(page,vp+' circles ordinary entry')
    f.locator('.scene.active').get_by_text('返回首页',exact=True).click();f=await_scene(page,scene);snap(page,vp+' circles return')
   f.locator('.scene.active [data-app-key=assistant]').get_by_text('打开助手',exact=True).click();f=await_scene(page,'A-'+scope+'-new');r=snap(page,vp+' '+scope+' assistant tab preserved');assert f.locator('.polo-host-tab').is_visible()
  for scene in ['P-M03-HOME-PERSONAL','P-M10-SETTINGS','A-personal-preferences','A-personal-skills','A-personal-conversation']:
   f=enter(scene);before=snap(page,vp+' '+scene+' top')
   main=f.locator('[data-prototype-scene="'+scene+'"] .workspace-main,[data-prototype-scene="'+scene+'"] .polo-preferences,[data-prototype-scene="'+scene+'"] .polo-skill-manager')
   if main.count():
    size=main.evaluate('(x)=>({h:x.clientHeight,sh:x.scrollHeight})');main.evaluate('(x)=>x.scrollTop=x.scrollHeight');after=snap(page,vp+' '+scene+' main scroll');st=main.evaluate('(x)=>x.scrollTop')
    assert after['header']['scrolled']==str(st>0 and size['sh']>size['h']+1).lower(),after
    assert after['header']['top']==before['header']['top']
    if st>0:page.screenshot(path=str(OUT/(vp+'-'+scene+'-scrolled.png')))
    main.evaluate('(x)=>x.scrollTop=0');after=snap(page,vp+' '+scene+' returned top');assert after['header']['scrolled']=='false'
   else:
    f.evaluate('''()=>{for(const x of document.querySelectorAll('*'))if(x.clientHeight&&x.scrollHeight>x.clientHeight&&['auto','scroll'].includes(getComputedStyle(x).overflowY))x.scrollTop=x.scrollHeight}''');after=snap(page,vp+' '+scene+' internal scroll');assert after['header']['scrolled']=='false'
   assert before['innerWidth']==width and before['innerHeight']==height
  print(vp,'done',flush=True)
 b.close()
(OUT/'interaction-trace.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('observations',len(rows))
