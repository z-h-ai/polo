#!/usr/bin/env python3
"""Regression checks for copy hierarchy, legacy catalog paths and stop feedback."""
from pathlib import Path
import hashlib,json,os
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r15-copy-cleanup');E.mkdir(parents=True,exist_ok=True)
M=json.loads((B/'prototype-manifest.json').read_text());report={'revision':M['revision'],'artifacts':{str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']},'checks':[],'errors':[]}
def ck(name,ok):
 report['checks'].append({'name':name,'passed':bool(ok)})
 if not ok:print('FAIL',name,flush=True)
with sync_playwright() as pw:
 browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1600,'height':1100});page.set_default_timeout(7000);page.on('pageerror',lambda e:report['errors'].append(str(e)))
 def go(sid):
  page.evaluate('(s)=>location.hash="scene="+s',sid);page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
  f=page.locator('[data-assistant-viewport]' if sid.startswith('A-') else '[data-prototype-viewport]').element_handle().content_frame();f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid);return f
 def reset():page.locator('[data-reset]').evaluate('(e)=>e.click()');page.wait_for_timeout(70)
 catalogs=['P-M03-ALL-APPS-ZERO','P-M03-MANAGE-HOME','P-M03-CONTROLS','P-M03-ALL-APPS-ENT-EMPTY','P-M07-SOURCE-FALLBACK']
 for protocol,url in [('file',(B/'review.html').as_uri()),('http','http://localhost:9901/docs/mvp-complete-flow-hifi/review.html')]:
  page.goto(url+'#scene=P-M03-HOME-PERSONAL')
  for vp in M['target']['viewports']:
   page.locator('[data-viewport-select]').select_option(vp['id'],force=True)
   for sid in catalogs:
    reset();f=go(sid);main=f.locator('.scene.active .workspace-main');t=main.inner_text();tag=protocol+' '+vp['id']+' '+sid
    ck(tag+' no favorites configuration',all(v not in t for v in ['最多 5','上限 5','固定在首页','移出首页','添加到首页','管理常用','挑常用']))
    ck(tag+' full library controls',main.locator('h1').inner_text()=='我的应用' and main.locator('[data-library-search]').is_visible() and main.locator('[data-library-sort]').is_visible())
    ck(tag+' viewport fits',f.evaluate('document.documentElement.scrollWidth<=innerWidth+1'))
    ck(tag+' header controls fit',f.locator('.scene.active .workbench-bar').evaluate('(h)=>[...h.querySelectorAll(".space-indicator,#notification-button,#account-button")].every(e=>{const r=e.getBoundingClientRect(),b=h.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom})'))
    if sid=='P-M03-ALL-APPS-ENT-EMPTY':ck(tag+' enterprise empty isolation',main.locator('[data-app-key]').count()==1 and '尚未分发' in t and '晨星设计圈' not in t)
    if sid=='P-M07-SOURCE-FALLBACK':
     meeting=main.locator('[data-app-key="meeting"]');growth=main.locator('[data-app-key="growth"]');ck(tag+' remaining source usable',meeting.count()==1 and meeting.get_by_role('button',name='打开',exact=True).is_visible());ck(tag+' revoked source cannot open',growth.locator('[data-go="P-M04-APP-GROWTH"]').count()==0 and growth.get_by_role('button',name='重新加入',exact=True).is_visible())
     main.locator('[data-library-source]').select_option(label='晨星设计圈');ck(tag+' valid source filter',meeting.is_visible() and not growth.is_visible());main.locator('[data-library-source]').select_option('all')
    if protocol=='file':f.locator('.scene.active').screenshot(path=str(E/(sid+'-cleanup-'+vp['id']+'.png')))
   for sid in ['P-M07-DETAIL-FOCUS','P-M07-DETAIL-PAID','P-M07-DETAIL-DATA']:
    f=go(sid);main=f.locator('.scene.active .workspace-main');t=main.inner_text();ck(protocol+vp['id']+sid+' concise sections','这个圈子的' not in t and '应用' in main.locator('h2').all_text_contents() and t.count('安装到本机后，供 Polo 助手使用')<=1)
   for scope in ['personal','enterprise']:
    f=go('A-'+scope+'-skills')
    if f.get_by_role('button',name='返回技能列表',exact=True).is_visible():f.get_by_role('button',name='返回技能列表',exact=True).click()
    f.get_by_role('button',name='查看来源技能').click();detail=f.locator('.polo-skill-detail');name='资料研究' if scope=='personal' else '销售周报';ck(protocol+vp['id']+scope+' one detail title',detail.get_by_role('heading',name=name,exact=True).count()==1 and detail.locator('.source-navigator__header-title').count()==0)
    if protocol=='file':f.locator('[data-prototype-scene]:visible').screenshot(path=str(E/(scope+'-skill-cleanup-'+vp['id']+'.png')))
  for sid,term in [('P-M07-DETAIL-FOCUS-SUBSCRIPTION','长期有效'),('P-M07-DETAIL-DATA-SUBSCRIPTION','长期有效'),('P-M07-DETAIL-PAID-SUBSCRIPTION','2026-11-02'),('P-M07-YEAR-RESULT','2028-10-01')]:
   f=go(sid);main=f.locator('.scene.active .workspace-main');t=main.inner_text();ck(protocol+sid+' subscription fact once',t.count(term)==1);ck(protocol+sid+' exit retained',main.get_by_role('button',name='退出圈子',exact=True).count()==1)
   if sid=='P-M07-YEAR-RESULT':ck(protocol+' annual policy retained','已购买下一年度权益' in t and '进入下一年度周期后才可继续' in t and t.count('年度订阅')==1)
   if 'PAID-' in sid:
    ck(protocol+' monthly price retained','¥39 / 月' in t);main.get_by_role('button',name='续费',exact=True).click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M07-RENEW'")
  f=go('P-M03-MANAGE-HOME');f.locator('.scene.active').get_by_role('button',name='查看隐藏项').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-CONTROLS'");f=go('P-M03-CONTROLS');f.locator('.scene.active').get_by_role('button',name='恢复显示').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-PERSONAL'");f=go('P-M03-HOME-PERSONAL');ck(protocol+' hidden restoration returns usable app',f.locator('.scene.active [data-app-key="brand"]').is_visible())
  for sid in ['P-M10-SETTINGS','P-M10-SETTINGS-ENT']:
   f=go(sid);t=f.locator('.scene.active .workspace-main').inner_text();ck(protocol+sid+' useful settings boundaries retained','查看账号与身份' not in t and '设置当前设备' not in t and '退出只影响这台设备' in t and 'Polo 助手中设置' in t)
  reset();f=go('P-M02-STOPPING');page.wait_for_timeout(1300);ck(protocol+' review holds initial progress',f.locator('.scene.active [data-stop-count]').inner_text()=='0 / 3')
  f=go('P-M02-CONFIRM');f.evaluate('''()=>{window.stopSamples=[];const root=document.querySelector('[data-prototype-scene="P-M02-STOPPING"]');new MutationObserver(()=>{window.stopSamples.push({count:root.querySelector('[data-stop-count]').textContent,done:[...root.querySelectorAll('.row-state')].filter(e=>e.textContent==='已停止').length,progress:root.querySelector('[role=progressbar]').getAttribute('aria-valuenow')})}).observe(root,{subtree:true,childList:true,attributes:true})}''');f.locator('.scene.active .dialog [data-go="P-M02-STOPPING"]').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M03-HOME-PERSONAL'");samples=f.evaluate('window.stopSamples');ck(protocol+' stop counts reflect completed rows',all(int(s['count'].split('/')[0])==s['done']==int(s['progress']) for s in samples));ck(protocol+' full stop sequence observed',set(s['done'] for s in samples)=={0,1,2,3});f=go('P-M02-STOPPING');ck(protocol+' revisit clears stale progress',f.locator('.scene.active [data-stop-count]').inner_text()=='0 / 3')
 browser.close()
report['passed']=all(c['passed'] for c in report['checks']) and not report['errors'];(E/'copy-cleanup.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'errors':report['errors']},ensure_ascii=False));raise SystemExit(0 if report['passed'] else 1)
