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
 def imports():
  go('A-personal-transfer-import')
  for n in [1,2]:
   if n==2:go('A-personal-transfer-import')
   data=json.dumps({'format':'polo-conversation-content-v1','title':'同名材料','messages':[{'role':'user','text':f'独立对象{n}金色鹦鹉'}]})
   f().get_by_label('选择导出文件').set_input_files({'name':'same.json','mimeType':'application/json','buffer':data.encode()});page.wait_for_timeout(150);snap(f'import-{n}-preview');click('确认导入');snap(f'import-{n}-result');click('打开导入对话');snap(f'import-{n}-opened');click('所有会话');snap(f'import-{n}-all-sessions');click('查看会话文件');click('导入对话内容');snap(f'import-{n}-return-import')
 run('imports',imports)
 ctx.tracing.stop(path=str(out/'import-recovery-trace.zip'));(out/'import-recovery.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2));b.close()
