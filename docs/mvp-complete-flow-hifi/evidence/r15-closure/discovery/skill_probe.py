from playwright.sync_api import sync_playwright
from pathlib import Path
import json
root=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');out=Path('/tmp/polo-closure-discovery')
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1440,'height':1000});page.set_default_timeout(5000);result=[]
 for scene in ['P-M07-DETAIL-FOCUS','P-M07-DETAIL-PAID','P-M07-DETAIL-FOCUS-UPDATES','P-M07-DETAIL-PAID-UPDATES','P-M07-DETAIL-DATA','P-M07-YEAR-RESULT']:
  page.goto((root/'docs/mvp-complete-flow-hifi/prototype.html').as_uri()+'?scene='+scene)
  el=page.locator('.scene.active');txt=el.inner_text();controls=el.locator('[data-go^="A-"]:visible').evaluate_all('els=>els.map(e=>({text:e.innerText,to:e.dataset.go,context:e.parentElement.innerText}))')
  result.append({'scene':scene,'controls':controls,'text':txt})
  if scene=='P-M07-DETAIL-FOCUS':
   page.screenshot(path=str(out/'skill-circle-selected.png'));el.locator('[data-go="A-personal-acquire"]:visible').click();page.wait_for_timeout(250)
   result.append({'after':'focus-acquire','url':page.url,'text':page.locator('body').inner_text()});page.screenshot(path=str(out/'skill-circle-detail.png'))
 (out/'circle-skill-object.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2));b.close()
