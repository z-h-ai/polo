from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/independent';M=json.loads((R/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text())
scenes=[s['id'] for s in M['scenes'] if s['id'].startswith(('P-M03-HOME','P-M02-','P-M07-DETAIL','P-M07-LIST')) or s['id'] in ['P-M07-LEAVE-DATA','P-M07-LEAVE-YEAR','P-M07-EMPTY','P-M07-YEAR-RESULT','A-personal-skills','A-enterprise-skills','A-personal-new','A-personal-detail','A-enterprise-new']]
rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.on('pageerror',lambda e:rows.append({'error':str(e)}))
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for scene in scenes:
   path=R/('design-demos/polo-client-source-baseline/prototype.html' if scene.startswith('A-') else 'docs/mvp-complete-flow-hifi/prototype.html');q.goto(path.as_uri()+'?scene='+scene);q.wait_for_timeout(300)
   d=q.locator('[data-prototype-scene]:visible').evaluate('''s=>({actual:s.dataset.prototypeScene,text:s.innerText,overflow:document.documentElement.scrollWidth>innerWidth,bg:getComputedStyle(s.querySelector('.mvp-root')||s).backgroundColor,controls:[...s.querySelectorAll('button,a,input,select')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText||e.ariaLabel||e.placeholder,go:e.dataset.go,transition:e.dataset.transition})),cards:[...s.querySelectorAll('.product-card,.circle-card')].map(e=>({classes:e.className,childClasses:[...e.children].map(x=>x.className),text:e.innerText,font:getComputedStyle(e).fontSize,radius:getComputedStyle(e).borderRadius,width:e.getBoundingClientRect().width}))})''');d.update(scene=scene,viewport=f'{w}x{h}');rows.append(d);q.screenshot(path=str(O/f'{scene}-{w}.png'),animations='disabled')
 # review scope shows outside product iframe at all sizes
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for scene in ['A-personal-skills','A-personal-new']:
   q.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri()+'#scene='+scene);q.wait_for_timeout(120);note=q.locator('[data-assistant-scope-note]');rows.append({'check':'assistant-boundary','scene':scene,'viewport':f'{w}x{h}','visible':note.is_visible(),'text':note.inner_text()});q.screenshot(path=str(O/f'review-{scene}-{w}.png'))
 b.close()
(O/'render-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('scenes',len(scenes),'rows',len(rows),'overflow',[d.get('scene') for d in rows if d.get('overflow')],'errors',[d for d in rows if 'error'in d])
