#!/usr/bin/env python3
"""Real offline browser checks; distinguishes rendered clicks from hidden DOM dispatch."""
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
B=Path(__file__).resolve().parents[1];ROOT=B.parents[1];OUT=B/'build/ux-r6';M=json.loads((B/'prototype-manifest.json').read_text())
sys.path.insert(0,str(Path.home()/'.agents/skills/product-ui-prototype/scripts'))
from quality_report import snapshot,fingerprints
report={'kind':'browser','artifacts':snapshot(B,ROOT,M),'fingerprints':fingerprints(),'render':[],'actions':[],'stories':[],'flows':[],'errors':[],'screenshots':[]}
with sync_playwright() as p:
 br=p.chromium.launch();page=br.new_page(viewport={'width':1440,'height':900});page.on('pageerror',lambda err:report['errors'].append(str(err)))
 page.goto((B/'prototype.html').as_uri());epoch=0
 def activate(sid):
  global epoch
  epoch+=1;page.evaluate("([sid,epoch])=>window.postMessage({type:'product-ui-prototype:show-scene',version:1,session:'r6-browser',epoch,scene:sid,theme:'light',language:'zh-CN'},'*')",[sid,epoch]);page.wait_for_function('(sid)=>document.body.dataset.currentScene===sid',arg=sid)
 shots=['P-M01-LOGIN-PASSWORD','P-M03-HOME-ENT','P-M04-APP-CONTRACT','P-M06-SKILLS-PERSONAL','P-M06-ENABLED-PERSONAL','P-M06-DISCOVER-ENT','P-M07-DETAIL-FOCUS']
 for vp in M['target']['viewports']:
  page.set_viewport_size({'width':vp['width'],'height':vp['height']})
  for s in M['scenes']:
   activate(s['id'])
   data=page.evaluate('''()=>{const s=document.querySelector('.scene.active');return {horizontalOverflow:s.scrollWidth>s.clientWidth+2||document.documentElement.scrollWidth>innerWidth+2, controls:[...s.querySelectorAll('button,input,select,textarea,a')].map((e,i)=>({id:e.dataset.transition||s.dataset.prototypeScene+'-local-'+i,selector:e.dataset.transition?'[data-transition="'+e.dataset.transition+'"]':e.tagName.toLowerCase(),label:e.getAttribute('aria-label')||e.innerText||e.placeholder||'',visible:!!e.getClientRects().length,disabled:e.disabled||false})),text:s.innerText}}''')
   report['render'].append({'scene':s['id'],'viewport':vp['id'],**data})
   if s['id'] in shots:
    path=OUT/(s['id']+'-'+vp['id']+'.png');page.screenshot(path=str(path));report['screenshots'].append(str(path.relative_to(ROOT)))
 # Every declared edge: DOM dispatch only, explicitly record whether actually visible.
 page.set_viewport_size({'width':1440,'height':900})
 for s in M['scenes']:
  for edge in s['transitions']:
   activate(s['id']);page.locator('.scene.active textarea').first.fill('请汇总材料') if page.locator('.scene.active textarea').count() else None;data=page.evaluate('''tid=>{const el=document.querySelector('[data-transition="'+tid+'"]');const visible=!!el.getClientRects().length;el.click();return {visible,actual:document.body.dataset.currentScene}}''',edge['id'])
   report['actions'].append({'scene':s['id'],'id':edge['id'],'expected':edge['to'],'method':'DOM-dispatch',**data})
 # User-style visible clicks on core new flows (no evaluation click).
 for storyid in ['S-DESKTOP','S-LOCAL-SKILLS','S-TEAM-SKILLS','S-TEAM-SHARE','S-CAPABILITY']:
  story=next(x for x in M['stories'] if x['id']==storyid);page.goto((B/'prototype.html').as_uri());activate(story['steps'][0]['scene'])
  for a,b in zip(story['steps'],story['steps'][1:]):
   if b.get('arrival')=='review':activate(b['scene']);report['flows'].append({'story':storyid,'from':a['scene'],'to':b['scene'],'method':'review-entry'});continue
   locator=page.locator('.scene.active [data-go="'+b['scene']+'"]');visible=[locator.nth(i) for i in range(locator.count()) if locator.nth(i).is_visible()]
   if not visible:report['flows'].append({'story':storyid,'from':a['scene'],'to':b['scene'],'error':'no visible product control'});activate(b['scene']);continue
   visible[-1].click(timeout=3000);actual=page.get_attribute('body','data-current-scene');report['flows'].append({'story':storyid,'from':a['scene'],'to':b['scene'],'actual':actual,'method':'pointer-click'})
 # Real local search.
 activate('P-M06-SKILLS-PERSONAL');page.get_by_role('searchbox').fill('不存在');report['search_empty']=page.locator('.scene.active [data-search-empty]').is_visible();page.get_by_role('searchbox').fill('资料');report['search_result_count']=page.locator('.scene.active [data-search-text]:visible').count()
 # Review console stories through real next/previous controls.
 shell=br.new_page(viewport={'width':1680,'height':1000});shell.on('pageerror',lambda err:report['errors'].append(str(err)))
 for story in M['stories']:
  shell.goto((B/'review.html').as_uri()+'#story='+story['id']+'&step=0');shell.wait_for_selector('[data-prototype-viewport]');shell.wait_for_function('()=>!!document.body.dataset.currentScene')
  actual=[]
  for i,step in enumerate(story['steps']):
   shell.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=step['scene']);actual.append(shell.get_attribute('body','data-current-scene'))
   if i<len(story['steps'])-1:shell.locator('[data-flow-next]').click()
  report['stories'].append({'id':story['id'],'actual':actual,'last_next_disabled':shell.locator('[data-flow-next]').is_disabled()})
 br.close()
report['status']='passed' if not(report['errors'] or any(x['horizontalOverflow'] for x in report['render']) or any(x['actual']!=x['expected'] for x in report['actions']) or any(x.get('error') or ('actual'in x and x['actual']!=x['to']) for x in report['flows'])) else 'failed'
(OUT/'browser-raw.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':report['status'],'scene_viewports':len(report['render']),'edges':len(report['actions']),'real_clicks':len([x for x in report['flows'] if x.get('method')=='pointer-click']),'stories':len(report['stories']),'overflow':[x['scene']+'@'+x['viewport'] for x in report['render'] if x['horizontalOverflow']],'bad_edges':[x for x in report['actions'] if x['actual']!=x['expected']],'bad_flows':[x for x in report['flows'] if x.get('error')],'errors':report['errors']},ensure_ascii=False))
