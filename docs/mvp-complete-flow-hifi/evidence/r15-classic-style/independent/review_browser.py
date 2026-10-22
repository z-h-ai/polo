from pathlib import Path
import json
from playwright.sync_api import sync_playwright
ROOT=Path.cwd(); OUT=ROOT/'docs/mvp-complete-flow-hifi/evidence/r15-classic-style/independent'
SCENES=['P-M03-HOME-PERSONAL','P-M03-HOME-ENT','P-M03-HOME-EMPTY-DIR','P-M03-HOME-LOAD-FAIL','P-M03-INSPECTOR','P-M07-LIST','P-M07-DETAIL-PAID-SUBSCRIPTION','P-M10-SETTINGS-DEVICE','P-M02-CONFIRM','P-M04-CLOSE-ACTIVE','A-personal-new','A-personal-skills','A-personal-detail','A-personal-updatefailed','A-personal-preferences','A-personal-remove','A-enterprise-skills']
PATHS={'mvp':ROOT/'docs/mvp-complete-flow-hifi/prototype.html','assistant':ROOT/'design-demos/polo-client-source-baseline/prototype.html'}
METRICS='''() => {const s=document.querySelector('[data-prototype-scene].active')||[...document.querySelectorAll('[data-prototype-scene]')].find(e=>e.getClientRects().length); if(!s)return {missing:true};let h=s.querySelector('.workbench-bar,.polo-host-bar');return {scene:s.dataset.prototypeScene,text:s.innerText,body:{width:document.documentElement.scrollWidth,client:innerWidth},header:h?{scroll:h.dataset.scrolled,border:getComputedStyle(h).borderBottomColor}:null,styles:[...s.querySelectorAll('.workspace-main,.product-card,.button.primary,.dialog,.circle-card,.mvp-action.primary,.source-input')].slice(0,12).map(e=>{let c=getComputedStyle(e);return {selector:e.className,color:c.color,background:c.backgroundColor,radius:c.borderRadius,shadow:c.boxShadow,font:c.fontSize}}),controls:[...s.querySelectorAll('button,a,input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText||e.placeholder||e.ariaLabel,go:e.dataset.go,transition:e.dataset.transition,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))}}'''
logs=[]
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page();page.on('pageerror',lambda err:logs.append({'pageerror':str(err)}))
 for w,h in [(1440,900),(1024,768),(800,600)]:
  page.set_viewport_size({'width':w,'height':h})
  for scene in SCENES:
   path=PATHS['assistant' if scene.startswith('A-') else 'mvp'];page.goto(path.as_uri()+'?scene='+scene);page.wait_for_timeout(120)
   data=page.evaluate(METRICS);data.update(viewport=f'{w}x{h}',version='current');logs.append(data)
   page.screenshot(path=str(OUT/f'current-{scene}-{w}.png'))
 for scene in ['P-M03-HOME-PERSONAL','P-M07-LIST','P-M02-CONFIRM','P-M04-CLOSE-ACTIVE','A-personal-new','A-personal-detail','A-personal-remove']:
  page.set_viewport_size({'width':1440,'height':900});path=OUT/('baseline-assistant.html' if scene.startswith('A-') else 'baseline-mvp.html');page.goto(path.as_uri()+'?scene='+scene);page.wait_for_timeout(120)
  data=page.evaluate(METRICS);data.update(viewport='1440x900',version='b82fa1e5');logs.append(data);page.screenshot(path=str(OUT/f'baseline-{scene}.png'))
 b.close()
(OUT/'render-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2))
print('rendered',len(logs),'rows')
