from playwright.sync_api import sync_playwright
import json
from pathlib import Path
out=Path('/tmp/polo-final-objects')
with sync_playwright() as p:
 b=p.chromium.launch(); page=b.new_page(viewport={'width':1440,'height':1000});page.goto('http://127.0.0.1:8874/docs/mvp-complete-flow-hifi/review.html');page.wait_for_timeout(1000)
 print(page.locator('iframe').evaluate_all('(es)=>es.map(e=>({id:e.id,src:e.src,hidden:e.hidden}))'))
 print(page.locator('select').evaluate_all('(es)=>es.map(e=>({id:e.id,count:e.options.length}))'))
 print(page.get_by_role('button',name='登录 · 密码登录P-M01-LOGIN-PASSWORD · 复用',exact=True).evaluate('(e)=>e.outerHTML'));print(page.locator('iframe').evaluate('(e)=>e.outerHTML'))
 page.screenshot(path=str(out/'review-start.png'));b.close()
