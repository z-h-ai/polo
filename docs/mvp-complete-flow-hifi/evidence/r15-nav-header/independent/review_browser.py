from pathlib import Path
from playwright.sync_api import sync_playwright
import json,time
ROOT=Path.cwd(); OUT=ROOT/'docs/mvp-complete-flow-hifi/evidence/r15-nav-header/independent'
M=json.loads((ROOT/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text())
PATHS={'mvp':ROOT/'docs/mvp-complete-flow-hifi/prototype.html','assistant':ROOT/'design-demos/polo-client-source-baseline/prototype.html'}
rows=[];errors=[]
JS='''() => {const visible=x=>!!x.getClientRects().length;const s=[...document.querySelectorAll('[data-prototype-scene]')].find(visible);if(!s)return {missing:true};const h=s.querySelector('.workbench-bar,.polo-host-bar');const main=s.querySelector('.workspace-main,.polo-preferences,.polo-skill-manager');return {scene:s.dataset.prototypeScene,header:h?{scrolled:h.dataset.scrolled,border:getComputedStyle(h).borderBottomColor,top:h.getBoundingClientRect().top,bottom:h.getBoundingClientRect().bottom,tabs:[...h.querySelectorAll('nav')].map(n=>({label:n.getAttribute('aria-label'),text:n.innerText}))}:null,secondaryNav:[...s.querySelectorAll('.r14-primary-nav,.polo-resource-nav')].map(n=>({text:n.innerText,visible:visible(n)})),main:main?{class:main.className,scrollTop:main.scrollTop,height:main.clientHeight,scrollHeight:main.scrollHeight}:null,assistCards:[...s.querySelectorAll('[data-app-key=assistant]')].map(c=>({controls:[...c.querySelectorAll('[data-go]')].map(x=>({label:x.innerText,to:x.dataset.go,transition:x.dataset.transition,rect:x.getBoundingClientRect().toJSON()}))})),circleEntries:[...s.querySelectorAll('.home-circle-entry')].map(x=>({label:x.innerText,to:x.dataset.go,insideHeader:!!x.closest('header')})),horizontalOverflow:document.documentElement.scrollWidth>innerWidth,controlIds:[...s.querySelectorAll('[data-transition]')].map(x=>x.dataset.transition)}}'''
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 for vp in M['target']['viewports']:
  page.set_viewport_size({k:vp[k] for k in ['width','height']})
  for surface in ['mvp','assistant']:
   scenes=[x for x in M['scenes'] if x['surface']==surface]
   page.goto(PATHS[surface].as_uri()+'?scene='+scenes[0]['id']);page.wait_for_timeout(100)
   for i,s in enumerate(scenes):
    page.evaluate('''d=>window.postMessage({type:'product-ui-prototype:show-scene',version:1,session:'independent-nav-header',epoch:d.epoch,scene:d.scene,theme:'light',language:'zh-CN'},'*')''',{'epoch':i+1,'scene':s['id']})
    page.wait_for_function('(id)=>[...document.querySelectorAll("[data-prototype-scene]")].some(x=>x.dataset.prototypeScene===id&&x.getClientRects().length)',arg=s['id'])
    page.evaluate('''()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))''')
    row=page.evaluate(JS);row['viewport']=vp['id'];rows.append(row)
   print(vp['id'],surface,len(scenes),flush=True)
 b.close()
(OUT/'all-scene-header-dom.json').write_text(json.dumps({'rows':rows,'browser_errors':errors},ensure_ascii=False,indent=2))
print('rows',len(rows),'errors',errors,'badnav',[(x['scene'],x['viewport']) for x in rows if x.get('secondaryNav')], 'overflow',[(x['scene'],x['viewport']) for x in rows if x.get('horizontalOverflow')],flush=True)
