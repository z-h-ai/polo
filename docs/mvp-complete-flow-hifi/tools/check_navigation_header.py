#!/usr/bin/env python3
"""Exercise home entry placement and scroll-dependent fixed header dividers."""
import hashlib,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline'
E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r15-nav-header');E.mkdir(parents=True,exist_ok=True)
M=json.loads((B/'prototype-manifest.json').read_text());by={s['id']:s for s in M['scenes']}
report={'revision':M['revision'],'artifacts':{str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']},'checks':[],'errors':[],'screenshots':[],'limitations':['Long-home scroll checks extend existing cards as layout fixtures; no real product data or services.']}
def check(name,ok,detail=None):
 report['checks'].append({'name':name,'passed':bool(ok),'detail':detail})
 if not ok:print('FAIL',name,detail,flush=True)
def frame(page,sid):return page.locator('[data-assistant-viewport]' if by[sid]['surface']=='assistant' else '[data-prototype-viewport]').element_handle().content_frame()
def goto(page,sid):
 page.evaluate('(s)=>location.hash="scene="+s',sid);page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
 f=frame(page,sid);f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid);return f
def snap(f,selector,name):
 path=E/(name+'.png');f.locator(selector).screenshot(path=str(path));report['screenshots'].append(str(path.relative_to(R)))
def header(f):return f.locator('[data-prototype-scene]:visible').locator('.workbench-bar,.polo-host-bar').first
def transparent(f):return header(f).evaluate('(e)=>getComputedStyle(e).borderBottomColor') in ['rgba(0, 0, 0, 0)','transparent']
with sync_playwright() as p:
 browser=p.chromium.launch();page=browser.new_page(viewport={'width':1600,'height':1100});page.set_default_timeout(8000)
 page.on('pageerror',lambda error:report['errors'].append(str(error)))
 page.goto((B/'review.html').as_uri()+'#scene=P-M03-HOME-PERSONAL');page.wait_for_timeout(150)
 for viewport in M['target']['viewports']:
  label=viewport['id'];page.locator('[data-viewport-select]').select_option(label,force=True)
  for scope,sid in [('personal','P-M03-HOME-PERSONAL'),('enterprise','P-M03-HOME-ENT')]:
   f=goto(page,sid);active=f.locator('.scene.active');main=active.locator('.workspace-main');main.evaluate('(e)=>e.scrollTop=0');page.wait_for_timeout(50)
   card=active.locator('[data-app-key="assistant"]');skill=card.get_by_role('button',name='管理技能',exact=True);open_app=card.get_by_role('button',name='打开助手',exact=True)
   check(label+' '+scope+' two adjacent card actions',skill.is_visible() and open_app.is_visible() and skill.evaluate('(e)=>e.parentElement') is not None)
   check(label+' '+scope+' one navigation tier',active.locator('.r14-primary-nav,.polo-resource-nav').count()==0)
   check(label+' '+scope+' header no line at top',transparent(f))
   check(label+' '+scope+' no horizontal overflow',f.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
   check(label+' '+scope+' circle entry ownership',active.locator('.home-circle-entry:visible').count()==(1 if scope=='personal' else 0))
   snap(f,'.scene.active',scope+'-home-'+label)
   skill.click();target='A-'+scope+'-skills';page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=target);f=frame(page,target)
   check(label+' '+scope+' skill manager opens',f.locator('.polo-skill-manager').is_visible() and f.locator('.polo-resource-nav').count()==0)
   check(label+' '+scope+' open assistant remains available',f.get_by_role('button',name='打开 Polo 助手',exact=True).is_visible())
   snap(f,'[data-prototype-scene]:visible',scope+'-skills-'+label)
   f.get_by_role('button',name='首页',exact=True).click();page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid);f=frame(page,sid)
   if scope=='personal':
    f.locator('.scene.active .home-circle-entry').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M07-LIST'");f=frame(page,'P-M07-LIST')
    check(label+' circles open without extra tab row',f.locator('.scene.active h1').inner_text()=='我的圈子' and f.locator('.scene.active .r14-primary-nav').count()==0)
    snap(f,'.scene.active','circles-'+label)
    f.get_by_role('button',name='返回首页',exact=True).click();page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
  # Real scroller with scale fixture, preserving fixed header position.
  f=goto(page,'P-M03-HOME-PERSONAL');main=f.locator('.scene.active .workspace-main')
  main.evaluate('''e=>{const grid=e.querySelector('.r14-app-grid'),card=grid.querySelector('[data-app-key="report"]');for(let i=0;i<18;i++){const copy=card.cloneNode(true);copy.dataset.scrollFixture='true';copy.removeAttribute('data-app-key');copy.querySelectorAll('[data-transition]').forEach(b=>{b.removeAttribute('data-transition');b.removeAttribute('data-go')});grid.append(copy)}e.scrollTop=0}''')
  page.wait_for_timeout(60);top=header(f).bounding_box();check(label+' long page initially borderless',transparent(f))
  main.evaluate('(e)=>e.scrollTop=240');page.wait_for_timeout(80)
  check(label+' line appears only after scroll',main.evaluate('(e)=>e.scrollTop')>0 and not transparent(f))
  check(label+' header stays fixed',header(f).bounding_box()==top)
  snap(f,'.scene.active','home-scrolled-'+label)
  main.evaluate('(e)=>e.scrollTop=0');page.wait_for_timeout(60);check(label+' line disappears on return to top',transparent(f))
  main.evaluate('(e)=>e.querySelectorAll("[data-scroll-fixture]").forEach(x=>x.remove())')
  f=goto(page,'A-personal-preferences');container=f.locator('.polo-preferences');container.evaluate('(e)=>e.scrollTop=0');page.wait_for_timeout(60)
  check(label+' assistant top is borderless',transparent(f))
  # Preference page has genuine long content at short viewports; extend only if needed.
  fixture=container.evaluate('''e=>{if(e.scrollHeight<=e.clientHeight+1){const spacer=document.createElement('div');spacer.dataset.scrollFixture='true';spacer.style.height='900px';e.append(spacer);return true}return false}''')
  container.evaluate('(e)=>e.scrollTop=160');page.wait_for_timeout(60);check(label+' assistant page scroll reveals line',not transparent(f))
  container.evaluate('(e)=>{e.scrollTop=0;e.querySelectorAll("[data-scroll-fixture]").forEach(x=>x.remove())}');page.wait_for_timeout(60);check(label+' assistant scroll back removes line',transparent(f))
  f=goto(page,'A-personal-skills');pane=f.locator('.polo-skill-detail');pane.evaluate('(e)=>e.scrollTop=100');page.wait_for_timeout(60);check(label+' nested panel scroll does not mark page header',transparent(f))
 browser.close()
report['passed']=not report['errors'] and all(c['passed'] for c in report['checks']);(E/'navigation-header.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'errors':report['errors']}));raise SystemExit(0 if report['passed'] else 1)
