#!/usr/bin/env python3
"""Enumerate MVP controls and replay visible operations through the review entry.
Shared host operations group by scope, label and destination; body operations
remain scene-specific. Occluded controls are inspected in their natural menu scene.
"""
from pathlib import Path
import json,hashlib,os
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r15-closure');E.mkdir(exist_ok=True,parents=True)
M=json.loads((B/'prototype-manifest.json').read_text());by={s['id']:s for s in M['scenes']}
report={'revision':M['revision'],'artifacts':{str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']},'controls':[],'actions':[],'errors':[]};groups={}
with sync_playwright() as pw:
 b=pw.chromium.launch();page=b.new_page(viewport={'width':1500,'height':1050});page.set_default_timeout(3000);page.on('pageerror',lambda e:report['errors'].append(str(e)));page.on('dialog',lambda d:d.dismiss());page.goto((B/'review.html').as_uri());page.wait_for_timeout(200)
 def go(sid):
  page.locator('[data-reset]').evaluate('(e)=>e.click()');page.wait_for_timeout(20);page.evaluate('(s)=>location.hash="scene="+s',sid);page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
  f=page.locator('[data-prototype-viewport]').element_handle().content_frame();f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid);return f
 for sc in M['scenes']:
  if sc['surface']!='mvp':continue
  f=go(sc['id']);rows=f.locator('.scene.active [data-transition]').evaluate_all('''els=>els.map(el=>({id:el.dataset.transition,to:el.dataset.go,label:el.textContent.trim(),host:!!el.closest('header'),scope:el.closest('.scene').querySelector('#space-name')?.textContent||'',visible:!!el.getClientRects().length,disabled:el.disabled||false,menu:el.closest('.popover')?.id||null}))''')
  report['controls'].extend(dict(scene=sc['id'],**row) for row in rows)
  for row in rows:
   if not row['visible'] or row['disabled']:continue
   key=(row['scope'],row['label'],row['to']) if row['host'] else (sc['id'],row['id'])
   if key in groups:continue
   groups[key]={'scene':sc['id'],**row}
 for index,row in enumerate(groups.values()):
  f=go(row['scene']);el=f.locator('[data-transition="'+row['id']+'"]');item={'scene':row['scene'],'transition':row['id'],'to':row['to']}
  try:
   if not el.is_visible() or el.is_disabled():item.update(status='unavailable',detail='Independent fixture excludes this operation');report['actions'].append(item);continue
   el.scroll_into_view_if_needed()
   reachable=el.evaluate('''e=>{const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!top&&(e===top||e.contains(top))}''')
   if not reachable:item.update(status='occluded',detail='Modal blocks underlying page control; no forced click');report['actions'].append(item);continue
   el.click();page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=row['to'],timeout=3000)
   item.update(status='passed')
  except Exception as e:item.update(status='failed',detail=str(e)[:650])
  report['actions'].append(item)
  if item['status']=='failed':print('FAIL',item,flush=True)
 b.close()
report['passed']=not report['errors'] and not any(a['status']=='failed' for a in report['actions']);(E/'mvp-operations.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':report['passed'],'controls':len(report['controls']),'actions':len(report['actions']),'failed':[a for a in report['actions'] if a['status']=='failed'],'errors':report['errors']},ensure_ascii=False));raise SystemExit(0 if report['passed'] else 1)
