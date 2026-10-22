from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path.cwd();O=R/'docs/mvp-complete-flow-hifi/evidence/r15-classic-style/independent';m=json.loads((R/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text());rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page(viewport={'width':1440,'height':900});q.set_default_timeout(3000)
 for surface in ['mvp','assistant']:
  path=R/('docs/mvp-complete-flow-hifi/prototype.html' if surface=='mvp' else 'design-demos/polo-client-source-baseline/prototype.html'); scenes=[s for s in m['scenes'] if s['surface']==surface];q.goto(path.as_uri()+'?scene='+scenes[0]['id']);q.wait_for_timeout(100)
  for n,s in enumerate(scenes):
   q.evaluate('(d)=>window.postMessage(d,"*")',{'type':'product-ui-prototype:show-scene','version':1,'session':'independent-availability','epoch':n+1,'scene':s['id'],'theme':'light','language':'zh-CN'});q.wait_for_timeout(15)
   shown=q.locator('[data-prototype-scene]:visible');actual=shown.get_attribute('data-prototype-scene');text=shown.inner_text();rows.append({'scene':s['id'],'actual':actual,'nonempty':bool(text.strip()),'passed':s['id']==actual and bool(text.strip())})
 for story in m['stories']:
  step=story['steps'][-1];url=(R/'docs/mvp-complete-flow-hifi/review.html').as_uri()+f"#story={story['id']}&step={len(story['steps'])}&scene={step['scene']}";q.goto(url);q.wait_for_timeout(80)
  rows.append({'story':story['id'],'url':q.url,'iframes':q.locator('iframe').count(),'step_count':len(story['steps'])})
 b.close()
(O/'availability-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('rows',len(rows),'failures',[r for r in rows if r.get('passed')==False])
