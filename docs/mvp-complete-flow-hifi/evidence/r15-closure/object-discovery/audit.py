from playwright.sync_api import sync_playwright
from pathlib import Path
import json,time
out=Path('/tmp/polo-final-objects'); root=Path.cwd(); m=json.loads((root/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text())
with sync_playwright() as p:
 b=p.chromium.launch();context=b.new_context(viewport={'width':1440,'height':1000});context.tracing.start(screenshots=True,snapshots=True,sources=True);page=context.new_page();page.set_default_timeout(5000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://127.0.0.1:8874/docs/mvp-complete-flow-hifi/review.html');page.wait_for_timeout(250)
 def frame():
  return next(f for f in page.frames[1:] if f.frame_element().is_visible())
 def go(s):
  page.locator('[data-scene-link="'+s+'"]').evaluate('(e)=>e.click()');page.wait_for_timeout(75);return frame()
 rows=[]
 for s in m['scenes']:
  try:
   f=go(s['id']);r=f.locator('body').evaluate('e=>({text:e.innerText,controls:[...e.querySelectorAll("button,input,select,a")].filter(x=>x.getClientRects().length).map(x=>({tag:x.tagName,text:x.innerText||x.getAttribute("aria-label"),disabled:x.disabled,go:x.dataset.go}))})');rows.append({'id':s['id'],'module':s['module'],**r})
  except Exception as e:rows.append({'id':s['id'],'error':str(e)})
 (out/'browser-scene-inventory.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));(out/'page-errors.json').write_text(json.dumps(errors,ensure_ascii=False,indent=2));context.tracing.stop(path=str(out/'inventory-trace.zip'));print({'scenes':len(rows),'failures':sum('error' in x for x in rows),'page_errors':len(errors)});b.close()
