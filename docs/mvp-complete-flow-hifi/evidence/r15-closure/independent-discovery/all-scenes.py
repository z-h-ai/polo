from playwright.sync_api import sync_playwright
from pathlib import Path
import json,hashlib,time
r=Path.cwd();out=Path('/tmp/polo-closure-semantic-candidate');m=json.loads((r/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text());rows=[]
paths=json.loads((out/'input-initial.json').read_text());hashes={p:hashlib.sha256((r/p).read_bytes()).hexdigest() for p in paths}
(out/'input-static-browser.json').write_text(json.dumps(hashes,indent=2))
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1600,'height':1100});page.goto((r/'docs/mvp-complete-flow-hifi/review.html').as_uri());page.wait_for_timeout(300)
 for i,s in enumerate(m['scenes']):
  page.locator('[data-scene-link="'+s['id']+'"]').evaluate('(e)=>e.click()')
  owner=s.get('surface','mvp');f=next((f for f in page.frames[1:] if ('source-baseline' in f.url)==(owner=='assistant')),None)
  if not f:
   page.wait_for_timeout(200);f=next(f for f in page.frames[1:] if ('source-baseline' in f.url)==(owner=='assistant'))
  f.wait_for_function('(id)=>document.body.dataset.currentScene===id',arg=s['id'])
  loc=f.locator('[data-prototype-scene="'+s['id']+'"]')
  row={'id':s['id'],'surface':owner,'module':s['module'],'text':loc.inner_text(),'controls':loc.locator('button,input,select,a,textarea').evaluate_all('els=>els.map(e=>({label:e.getAttribute("aria-label")||e.textContent.trim(),id:e.dataset.transition||null,to:e.dataset.go||null,tag:e.tagName,hidden:!e.getClientRects().length,disabled:e.disabled||false}))')}
  rows.append(row)
 (out/'all-scene-rendered.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));b.close()
print('scenes',len(rows),'controls',sum(len(x['controls']) for x in rows))
for x in rows:
 if x['surface']=='assistant' and not any(t in x['id'] for t in ['legacy-','uninstalled-','enterprise-']):print(x['id'],x['text'].replace('\n',' ')[:1100])
