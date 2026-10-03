#!/usr/bin/env python3
"""Spec 13.11: real scoped UI operations, system progress and review boundaries."""
import hashlib,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r15-ui-refinement');E.mkdir(parents=True,exist_ok=True)
M=json.loads((B/'prototype-manifest.json').read_text());by={s['id']:s for s in M['scenes']}
report={'revision':M['revision'],'checks':[],'errors':[],'screenshots':[],'limitations':['Existing assistant screens remain behavior illustrations, not current Renderer UI or full-page visual acceptance. Only explicit deltas are implementation requirements.','System delays and membership changes are local prototype fixtures; no actual task processes, servers or payments are changed.']}
def check(name,ok,detail=None):
 report['checks'].append({'name':name,'passed':bool(ok),'detail':detail})
 if not ok:print('FAIL',name,detail,flush=True)
with sync_playwright() as pw:
 b=pw.chromium.launch();page=b.new_page(viewport={'width':1600,'height':1100});page.set_default_timeout(7000);page.on('pageerror',lambda e:report['errors'].append(str(e)));page.goto((B/'review.html').as_uri()+'#scene=P-M03-HOME-PERSONAL')
 def frame(s):return page.locator('[data-assistant-viewport]' if s.startswith('A-') else '[data-prototype-viewport]').element_handle().content_frame()
 def go(s):
  page.evaluate('(s)=>location.hash="scene="+s',s);page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=s);f=frame(s);f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=s);return f
 def scene():return page.evaluate('document.body.dataset.currentScene')
 def click(f,target):
  modal=f.locator('.scene.active .modal-layer [data-go="'+target+'"]');control=modal if modal.count() else f.locator('.scene.active [data-go="'+target+'"]');control.first.click();page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=target);return frame(target)
 def reset():page.locator('[data-reset]').evaluate('(e)=>e.click()');page.wait_for_timeout(100)
 def snap(f,s,w):
  path=E/(s+'-refinement-'+str(w)+'.png');f.locator('[data-prototype-scene]:visible').screenshot(path=str(path));report['screenshots'].append(str(path.relative_to(R)))
 keys=['backgroundColor','borderRadius','boxShadow','paddingTop','paddingRight','fontSize','display','gap','height']
 style='(e,keys)=>{const c=getComputedStyle(e);return Object.fromEntries(keys.map(k=>[k,c[k]]))}'
 for vp in M['target']['viewports']:
  reset();w=vp['width'];page.locator('[data-viewport-select]').select_option(vp['id'],force=True)
  f=go('P-M03-HOME-PERSONAL');root=f.locator('.scene.active');card=root.locator('[data-app-key="meeting"]');base={sel:card.locator(sel).evaluate(style,keys) for sel in ['.card-heading','.app-art','.card-title h3','.card-action']};canvas=f.evaluate('getComputedStyle(document.body).backgroundColor')
  check(str(w)+' home title',root.locator('h1').inner_text()=='我的应用');check(str(w)+' no corner labels',root.locator('.product-card .status-line>.status').count()==0);check(str(w)+' one shared work card',card.count()==1 and '有效来源' not in card.inner_text());snap(f,'P-M03-HOME-PERSONAL',w)
  f=click(f,'P-M07-LIST');root=f.locator('.scene.active');check(str(w)+' no desktop join',root.locator('.workspace-main [data-go="P-M07-JOIN-FREE"]').count()==0);check(str(w)+' consistent circle buttons',root.locator('.circle-card>button:visible').all_text_contents()==['查看详情']*4);check(str(w)+' consistent circle structure',root.locator('.circle-card>.circle-card-copy>.circle-meta').count()==4)
  snap(f,'P-M07-LIST',w);f=click(f,'P-M07-DETAIL-FOCUS');root=f.locator('.scene.active');check(str(w)+' no prominent redundant entries',all(x not in root.inner_text() for x in ['退出圈子','查看全部应用','管理本机技能']));check(str(w)+' shared work exists in distributing circle',root.locator('.circle-app-grid .product-card').count()==2)
  circle=root.locator('.circle-app-grid .product-card').filter(has_text='会议纪要整理');actual={sel:circle.locator(sel).evaluate(style,keys) for sel in base};check(str(w)+' app cards use identical component styles',actual==base,{'home':base,'circle':actual} if actual!=base else None);snap(f,'P-M07-DETAIL-FOCUS',w)
  for stem,target in [('FOCUS','P-M07-LEAVE'),('PAID','P-M07-LEAVE-PAID')]:
   f=go('P-M07-DETAIL-'+stem+'-SUBSCRIPTION');root=f.locator('.scene.active');check(str(w)+' '+stem+' exit only inside subscription',root.get_by_role('button',name='退出圈子',exact=True).count()==1);click(f,target)
  for sid in ['P-M07-DETAIL-DATA','P-M07-YEAR-RESULT','P-M07-DETAIL-DATA-SUBSCRIPTION']:
   f=go(sid);check(str(w)+' '+sid+' no overflow',f.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));snap(f,sid,w)
  f=go('A-personal-new');assistant=f.locator('.mvp-root').evaluate('(e)=>getComputedStyle(e).backgroundColor');panel=f.locator('.source-content-panel').evaluate('(e)=>getComputedStyle(e).backgroundColor');check(str(w)+' same home and assistant canvas',canvas==assistant==panel,{'home':canvas,'assistant':assistant,'panel':panel});check(str(w)+' existing assistant scope visible only in review',page.locator('[data-assistant-scope-note]').is_visible() and '不作为 UI 重做依据' in page.locator('[data-assistant-scope-note]').inner_text() and '重做依据' not in f.locator('.mvp-root').inner_text())
  f=go('A-personal-skills');check(str(w)+' skills remain review focus','本轮评审：技能管理' in page.locator('[data-assistant-scope-note]').inner_text());snap(f,'A-personal-skills',w)
 # Exit confirmation cancels safely, then removes only that circle's source.
 reset();f=go('P-M07-DETAIL-DATA');f=click(f,'P-M07-DETAIL-DATA-SUBSCRIPTION');f=click(f,'P-M07-LEAVE-DATA');f=click(f,'P-M07-DETAIL-DATA-SUBSCRIPTION');f=go('P-M07-LIST');check('cancel exit retains membership',f.locator('.scene.active [data-circle-kind="data"]').is_visible())
 f=go('P-M07-LEAVE-DATA');f.locator('.scene.active [data-leave-circle="data"]').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M07-LIST'");f=frame('P-M07-LIST');check('confirmed exit removes data membership',not f.locator('.scene.active [data-circle-kind="data"]').is_visible());f.locator('.scene.active [data-circle-search]').fill('数据');check('search cannot restore exited circle',f.locator('.scene.active .circle-card:visible').count()==0);f=go('P-M03-HOME-PERSONAL');check('last data source cannot open without touching shared apps',f.locator('.scene.active [data-app-key="report"] button').is_disabled() and not f.locator('.scene.active [data-app-key="meeting"] button').is_disabled());f.locator('.scene.active [data-library-search]').fill('报表');check('search cannot restore unauthorized app',f.locator('.scene.active [data-app-key="report"] button').is_disabled())
 reset();f=go('P-M07-LEAVE-YEAR');f.locator('.scene.active [data-leave-circle="year"]').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M07-LIST'");f=frame('P-M07-LIST');check('annual exit preserves other three circles',f.locator('.scene.active .circle-card:visible').count()==3 and f.locator('.scene.active [data-circle-kind="data"]').is_visible());reset()
 # Automatic sequence, direct-review hold, cancellation, reset and stale callbacks.
 f=go('P-M02-STOPPING');page.wait_for_timeout(2100);check('direct progress entry is held for review',scene()=='P-M02-STOPPING');check('progress has no repeated confirmation',f.locator('.scene.active .dialog-footer button').all_text_contents()==['取消切换'])
 f=go('P-M02-CONFIRM');click(f,'P-M02-STOPPING');page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-PERSONAL'");check('single confirmation automatically switches',True)
 for mode in ['cancel','reset','browse-and-return','cross-surface']:
  f=go('P-M02-CONFIRM');f=click(f,'P-M02-STOPPING');page.wait_for_timeout(80)
  if mode=='cancel':click(f,'P-M02-STOP-CANCEL');expected='P-M02-STOP-CANCEL'
  elif mode=='reset':reset();expected=scene()
  elif mode=='browse-and-return':go('P-M02-TARGET-LOADING');go('P-M02-STOPPING');expected='P-M02-STOPPING'
  else:go('A-personal-skills');page.wait_for_timeout(200);go('P-M02-STOPPING');expected='P-M02-STOPPING'
  page.wait_for_timeout(2200);check(mode+' invalidates old callbacks',scene()==expected,scene())
 # Real assistant simulation acknowledgement must precede the target space commit.
 reset();f=go('A-enterprise-new');f.get_by_role('textbox',name='消息',exact=True).fill('切换前保留的任务');f.get_by_role('button',name='发送消息',exact=True).click();page.wait_for_function("()=>document.body.dataset.currentScene==='A-enterprise-generating'");f=go('P-M02-CONFIRM');click(f,'P-M02-STOPPING');page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-PERSONAL'");f=go('A-enterprise-activity');check('switch stops original assistant activity','当前没有运行' in f.locator('.polo-preferences').inner_text())
 # Fresh fixture blocks the stop request before any app listener is registered.
 # This exercises a missing protocol ACK without replacing product logic.
 page.close();page=b.new_page(viewport={'width':1600,'height':1100});page.set_default_timeout(8000);page.on('pageerror',lambda e:report['errors'].append(str(e)))
 page.add_init_script("window.addEventListener('message',e=>{if(e.data?.type==='product-ui-prototype:peer'&&e.data?.payload?.kind==='stop-assistant-scope')e.stopImmediatePropagation()},true)")
 page.goto((B/'review.html').as_uri()+'#scene=A-enterprise-new')
 f=go('A-enterprise-new');f.get_by_role('textbox',name='消息',exact=True).fill('无停止回执');f.get_by_role('button',name='发送消息',exact=True).click();page.wait_for_function("()=>document.body.dataset.currentScene==='A-enterprise-generating'");f=go('P-M02-CONFIRM');click(f,'P-M02-STOPPING');page.wait_for_function("()=>document.body.dataset.currentScene==='P-M02-STOP-FAILED'",timeout=8000);f=frame('P-M02-STOP-FAILED');check('missing acknowledgement retains original space','晨星科技' in f.locator('.scene.active #space-name').inner_text());snap(f,'P-M02-STOP-FAILED',800)
 b.close()
report['passed']=not report['errors'] and all(c['passed'] for c in report['checks']);report['artifacts']={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']};(E/'ui-refinement.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'errors':report['errors']}));raise SystemExit(0 if report['passed'] else 1)
