from pathlib import Path
from playwright.sync_api import sync_playwright
import json,hashlib
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-copy-cleanup/independent';m=json.loads((R/'docs/mvp-complete-flow-hifi/prototype-manifest.json').read_text());rows=[]
scenes=['P-M07-SOURCE-FALLBACK','P-M03-MANAGE-HOME','P-M03-CONTROLS','P-M03-ALL-APPS-ZERO','P-M03-ALL-APPS-ENT-EMPTY','P-M03-ALL-APPS','P-M03-ALL-APPS-ENT','P-M07-DETAIL-FOCUS','P-M07-DETAIL-PAID','P-M07-DETAIL-FOCUS-SUBSCRIPTION','P-M07-DETAIL-PAID-SUBSCRIPTION','P-M07-DETAIL-DATA-SUBSCRIPTION','P-M07-YEAR-RESULT','P-M10-SETTINGS','P-M10-SETTINGS-DEVICE','P-M02-STOPPING','A-personal-detail','A-enterprise-detail','A-personal-remove','A-enterprise-remove']
paths=['docs/mvp-complete-flow-hifi/prototype-manifest.json','docs/mvp-complete-flow-hifi/prototype.html','docs/mvp-complete-flow-hifi/review.html','design-demos/polo-client-source-baseline/prototype.html','docs/client-journey-review/spec.md','.agents/skills/polo-ai-design-system/SKILL.md'];(O/'checked-inputs.json').write_text(json.dumps({p:hashlib.sha256((R/p).read_bytes()).hexdigest() for p in paths},indent=2))
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.on('pageerror',lambda e:rows.append({'error':str(e)}))
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for scene in scenes:
   q.goto((R/('design-demos/polo-client-source-baseline/prototype.html' if scene.startswith('A-') else 'docs/mvp-complete-flow-hifi/prototype.html')).as_uri()+'?scene='+scene);q.wait_for_timeout(300)
   if scene.startswith('A-') and w==800:q.get_by_role('button',name='查看来源技能').click();q.wait_for_timeout(80)
   s=q.locator('[data-prototype-scene]:visible');data=s.evaluate('''s=>({text:s.innerText,overflow:document.documentElement.scrollWidth>innerWidth,controls:[...s.querySelectorAll('button,a,input,select')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText||e.ariaLabel||e.placeholder,go:e.dataset.go,transition:e.dataset.transition,disabled:e.disabled})),headings:[...s.querySelectorAll('h1,h2,h3')].filter(e=>e.getClientRects().length).map(e=>e.innerText)})''');data.update(scene=scene,viewport=f'{w}x{h}');rows.append(data);q.screenshot(path=str(O/f'{scene}-{w}.png'),animations='disabled')
 b.close()
(O/'render-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('rows',len(rows),'overflow',[r.get('scene') for r in rows if r.get('overflow')],'errors',[r for r in rows if 'error'in r])
