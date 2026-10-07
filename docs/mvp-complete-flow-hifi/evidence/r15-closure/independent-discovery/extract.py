from playwright.sync_api import sync_playwright
from pathlib import Path
import json
root=Path.cwd()
with sync_playwright() as p:
 b=p.chromium.launch(); page=b.new_page();page.goto((root/'docs/mvp-complete-flow-hifi/prototype.html').as_uri())
 rows=page.locator('[data-prototype-scene]').evaluate_all('els=>els.map(e=>{const c=e.cloneNode(true);c.querySelectorAll("header,.connection-banner").forEach(n=>n.remove());return {id:e.dataset.prototypeScene,text:c.textContent.replace(/\\s+/g," ").trim(),controls:[...c.querySelectorAll("button,a,input,select")].map(b=>({label:b.textContent.trim(),to:b.dataset.go,action:b.dataset.action}))}})')
 Path('/tmp/polo-closure-semantic-candidate/mvp-static.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
 b.close()
print(len(rows))
for x in rows:
 if any(x['id'].startswith('P-'+m) for m in ['M01','M02','M03','M04']):print(x['id'],x['text'])
