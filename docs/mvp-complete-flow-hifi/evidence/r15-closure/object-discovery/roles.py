from playwright.sync_api import sync_playwright
from pathlib import Path
import json
out=Path('/tmp/polo-final-objects');logs=[]
with sync_playwright() as p:
 b=p.chromium.launch();ctx=b.new_context(viewport={'width':1440,'height':1000});ctx.tracing.start(screenshots=True,snapshots=True,sources=True);page=ctx.new_page();page.set_default_timeout(4000)
 def reset():page.goto('http://127.0.0.1:8874/docs/mvp-complete-flow-hifi/review.html');page.wait_for_timeout(400)
 def f():return next(x for x in page.frames[1:] if x.frame_element().is_visible())
 def go(s):page.locator('[data-scene-link="'+s+'"]').evaluate('(e)=>e.click()');page.wait_for_timeout(200)
 def click(label):f().get_by_role('button',name=label,exact=True).filter(visible=True).first.click();page.wait_for_timeout(200)
 def snap(label):
  body=f().locator('body');r={'step':label,'text':body.inner_text(),'controls':body.locator('button:visible').evaluate_all('(xs)=>xs.map(x=>({text:x.innerText,disabled:x.disabled,go:x.dataset.go}))')};logs.append(r);page.screenshot(path=str(out/(label+'.png')));print(label,r['text'][:90],flush=True)
 def run(name,fn):
  try:reset();fn()
  except Exception as e:logs.append({'case':name,'error':str(e)});print(name,'ERROR',str(e)[:150],flush=True)
 def revoke():
  go('P-M11-REVOKE');click('回到空间切换');snap('revoked-switcher');
  f().locator('button:visible').evaluate_all('(xs)=>xs.map(x=>x.innerText)')
  for dest in ['P-M03-HOME-ENT','P-M03-HOME-ENT-AFTER-CANCEL']:
   loc=f().locator('[data-go="'+dest+'"]:visible')
   if loc.count():loc.first.click();page.wait_for_timeout(250);snap('revoked-returned-enterprise');break
 def billing():
  go('P-M10-MENU-NOPRIV');f().locator('[data-go="P-M09-BROWSER-MENU-ENT"]:visible').click();page.wait_for_timeout(200);snap('member-billing-handoff')
 run('revoke',revoke);run('billing',billing)
 ctx.tracing.stop(path=str(out/'role-trace.zip'));(out/'role.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2));b.close()
