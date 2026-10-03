import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'); OUT=Path('/tmp/polo-final-journeys')
m=json.loads((ROOT/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text())
with sync_playwright() as p:
 b=p.chromium.launch(headless=True);page=b.new_page(viewport={'width':1700,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto((ROOT/'docs/mvp-complete-flow-hifi/review.html').as_uri());page.wait_for_timeout(1500)
 rows=[]
 for i,s in enumerate(m['scenes']):
  page.locator('[data-scene-link="'+s['id']+'"]').evaluate('(e)=>e.click()');page.wait_for_timeout(80)
  f=page.locator('iframe:not([hidden])').element_handle().content_frame()
  row={'id':s['id'],'module':s['module'],'title':s['title'],'surface':s.get('surface'),'text':f.locator('body').inner_text(),'controls':f.locator('button:visible,input:visible,select:visible,textarea:visible,a:visible').evaluate_all('(es)=>es.map(e=>({tag:e.tagName,text:e.innerText||e.getAttribute("aria-label")||"",transition:e.dataset.transition,go:e.dataset.go,type:e.type,disabled:e.disabled,value:e.value}))')}
  rows.append(row)
  if i%50==0: print('captured',i,flush=True)
 (OUT/'all-scenes-dom.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));(OUT/'browser-errors.json').write_text(json.dumps(errors,indent=2));b.close()
