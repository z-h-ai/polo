from pathlib import Path
from playwright.sync_api import sync_playwright
import json
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/independent';M=json.loads((R/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text());rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(3000)
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for surface in ['mvp','assistant']:
   scenes=[s['id'] for s in M['scenes'] if s['surface']==surface];path=R/('docs/mvp-complete-flow-hifi/prototype.html' if surface=='mvp' else 'design-demos/polo-client-source-baseline/prototype.html');q.goto(path.as_uri()+'?scene='+scenes[0]);q.wait_for_timeout(100)
   for i,s in enumerate(scenes):
    q.evaluate('(d)=>postMessage(d,"*")',{'type':'product-ui-prototype:show-scene','version':1,'session':'independent-all-scenes','epoch':i+1,'scene':s});q.wait_for_timeout(12);actual=q.locator('[data-prototype-scene]:visible').get_attribute('data-prototype-scene');nonempty=bool(q.locator('[data-prototype-scene]:visible').inner_text().strip());overflow=q.evaluate('document.documentElement.scrollWidth>innerWidth');rows.append({'scene':s,'viewport':f'{w}x{h}','actual':actual,'nonempty':nonempty,'document_horizontal_overflow':overflow,'passed':actual==s and nonempty and not overflow})
 b.close()
(O/'availability-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('pairs',len(rows),'failures',[r for r in rows if not r['passed']])
