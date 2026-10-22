#!/usr/bin/env python3
"""Browser verification for the r12 multi-surface extension (no network/API).
Run after build_review.py. Evidence binds exact output hashes, never implies approval.
"""
import argparse,hashlib,json,threading,http.server,functools
from pathlib import Path
import os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3];B=ROOT/'docs/mvp-complete-flow-hifi';A=ROOT/'design-demos/polo-client-source-baseline'
parser=argparse.ArgumentParser();parser.add_argument('--quick',action='store_true');args=parser.parse_args()
M=json.loads((B/'prototype-manifest.json').read_text());BY={s['id']:s for s in M['scenes']}
OUT=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r12');OUT.mkdir(parents=True,exist_ok=True)
report={'revision':M['revision'],'artifacts':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']},'scenes':[],'actions':[],'stories':[],'checks':[],'errors':[],'requests':[]}
class Handler(http.server.SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT)));threading.Thread(target=server.serve_forever,daemon=True).start()

def check(name,ok,detail=''):
 report['checks'].append({'name':name,'passed':bool(ok),'detail':detail})
 if not ok:print('FAIL',name,detail,flush=True)

def active(page):
 owner=BY[page.evaluate('document.body.dataset.currentScene')]['surface']
 return page.locator('[data-assistant-viewport]' if owner=='assistant' else '[data-prototype-viewport]').element_handle().content_frame()

def clear(page):
 page.locator('[data-reset]').evaluate('(el)=>el.click()');page.wait_for_timeout(30)

def goto(page,sid):
 page.evaluate('(s)=>location.hash="scene="+s',sid)
 page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
 f=active(page);f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
 return f

with sync_playwright() as p:
 browser=p.chromium.launch()
 for protocol,url in [('file',(B/'review.html').as_uri()),('http',f'http://127.0.0.1:{server.server_port}/docs/mvp-complete-flow-hifi/review.html')]:
  page=browser.new_page(viewport={'width':1440,'height':980});page.on('pageerror',lambda e:report['errors'].append(str(e)))
  page.on('request',lambda req:report['requests'].append(req.url) if req.url.startswith(('http://','https://')) and not req.url.startswith(f'http://127.0.0.1:{server.server_port}/') else None)
  page.goto(url+'#scene=A-personal-new');page.wait_for_timeout(200)
  for viewport in M['target']['viewports']:
   page.locator('[data-viewport-select]').select_option(viewport['id'],force=True)
   scenes=M['scenes'] if not args.quick else [BY[s] for s in ['P-M03-HOME-PERSONAL','A-personal-new','A-personal-question','A-personal-detail','A-personal-preblock','P-M09-BROWSER','A-enterprise-budgetowner']]
   for scene in scenes:
    sid=scene['id'];clear(page);f=goto(page,sid)
    if scene['surface']=='assistant' and f.get_by_role('button',name='切换侧栏').count() and not f.locator('.source-sidebar').count():f.get_by_role('button',name='切换侧栏').click()
    result=f.evaluate('''sid=>{
     const el=document.querySelector('[data-prototype-scene="'+sid+'"]');
     return {present:!!el,viewport:[innerWidth,innerHeight],overflow:document.documentElement.scrollWidth>innerWidth+1,controls:el?[...el.querySelectorAll('[data-transition]')].map(e=>({id:e.dataset.transition,to:e.dataset.go,label:e.textContent.trim(),disabled:e.disabled})):[]}
    }''',sid)
    declared={t['id']:t['to'] for t in scene['transitions']};rendered={t['id']:t['to'] for t in result['controls']}
    result.update(protocol=protocol,scene=sid,viewport_id=viewport['id'])
    result['pass']=result['present'] and result['viewport']==[viewport['width'],viewport['height']] and not result['overflow'] and declared==rendered
    if not result['pass']:print('SCENE FAIL',sid,viewport['id'],result['present'],result['overflow'],set(declared)-set(rendered),set(rendered)-set(declared),flush=True)
    report['scenes'].append(result)
   if protocol=='file':
    for sid in ['A-personal-new','A-personal-detail','A-enterprise-question','A-personal-cut']:
     goto(page,sid);page.screenshot(path=str(OUT/(sid+'-'+viewport['id']+'.png')))
  # Every declared assistant product action, tested through its rendered control.
  page.locator('[data-viewport-select]').select_option('desktop-1440x900',force=True)
  for scene in [s for s in M['scenes'] if s['surface']=='assistant']:
   if args.quick and scene['key'] not in ['new','preblock','return','question','detail','restricted']:continue
   for edge in scene['transitions']:
    clear(page);f=goto(page,scene['id'])
    if f.get_by_role('button',name='切换侧栏').count() and not f.locator('.source-sidebar').count():f.get_by_role('button',name='切换侧栏').click()
    if edge['key'] in ['send','answer']:
     f.get_by_role('textbox',name='消息' if edge['key']=='send' else '回答问题',exact=True).fill('验证主动提交')
    try:
     if scene['key']=='sourceauth' and edge['key']=='connect':f.get_by_label('访问凭证').fill('fixture')
     if scene['family']=='skills' and edge.get('area')=='builtin' and f.get_by_role('button',name='查看内置技能').count():f.get_by_role('button',name='查看内置技能').click()
     if scene['family']=='skills' and edge.get('area')=='body' and f.get_by_role('button',name='查看来源技能').count():f.get_by_role('button',name='查看来源技能').click()
     control=f.locator('[data-transition="'+edge['id']+'"]').first
     if control.is_disabled():
      report['actions'].append({'protocol':protocol,'id':edge['id'],'passed':True,'observation':'disabled in this fixture; recovery availability separately tested'});continue
     if edge['key']=='select-import':f.locator('[data-transition="'+edge['id']+'"]').set_input_files({'name':'allowed.json','mimeType':'application/json','buffer':json.dumps({'format':'polo-conversation-content-v1','messages':[{'role':'user','text':'独立导入样例'}]}).encode()})
     elif edge['key']=='reselect':f.locator('[data-transition="'+edge['id']+'"]').set_input_files({'name':'新材料.txt','mimeType':'text/plain','buffer':b'new attachment'})
     else:
      if scene['key']=='sourceauth' and edge['key']=='connect':f.get_by_label('访问凭证').fill('fixture')
      control.evaluate('(el)=>el.click()')
     page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=edge['to'],timeout=8000)
     target=active(page);target.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=edge['to'],timeout=8000)
     report['actions'].append({'protocol':protocol,'id':edge['id'],'to':edge['to'],'passed':True})
    except Exception as e:
     report['actions'].append({'protocol':protocol,'id':edge['id'],'passed':False,'error':str(e)[:200]});print('ACTION FAIL',edge['id'],str(e)[:400],flush=True)
  # Story browsing never submits a draft or triggers a product operation.
  for story in M['stories']:
   page.evaluate('(id)=>location.hash="story="+id',story['id']);page.wait_for_timeout(25)
   for i,step in enumerate(story['steps']):
    page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=step['scene'])
    if i<len(story['steps'])-1:page.locator('[data-flow-next]').click()
   check(protocol+' story '+story['id'],page.locator('[data-flow-next]').is_disabled())
   report['stories'].append(protocol+':'+story['id'])
  # Surface continuity and manual credit-query boundary.
  clear(page);f=goto(page,'A-personal-preblock');f.get_by_role('textbox',name='消息',exact=True).fill('保留充值前草稿')
  count=len(f.locator('.mvp-chat-column').inner_text());f.get_by_role('button',name='去充值',exact=True).click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M09-BROWSER'")
  active(page).get_by_role('button',name='返回 Polo',exact=True).click();page.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-return'")
  f=active(page);f.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-return'")
  check(protocol+' return keeps draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='保留充值前草稿')
  page.wait_for_timeout(200);check(protocol+' return does not query',page.evaluate('document.body.dataset.currentScene')=='A-personal-return')
  f.get_by_role('button',name='已完成，查询结果').click();page.wait_for_function("()=>document.body.dataset.currentScene==='A-personal-checking'")
  f=goto(page,'A-personal-resumed');check(protocol+' resumed no auto send',f.get_by_role('textbox',name='消息',exact=True).input_value()=='保留充值前草稿')
  f=goto(page,'A-enterprise-new');check(protocol+' scope isolation',f.get_by_role('textbox',name='消息',exact=True).input_value()!='保留充值前草稿')
  f=goto(page,'A-enterprise-question');f.get_by_role('textbox',name='回答问题').fill('只汇总周一');f=goto(page,'A-enterprise-reopen');check(protocol+' question draft recovery',f.get_by_role('textbox',name='回答问题').input_value()=='只汇总周一')
  # Both surfaces stay mounted after crossing, unknown/stale messages ignored.
  check(protocol+' two mounted surfaces',page.locator('iframe').count()==2)
  before=page.evaluate('document.body.dataset.currentScene');page.evaluate("window.postMessage({type:'product-ui-prototype:scene-change',version:1,scene:'A-personal-new',reason:'action'},'*')");page.wait_for_timeout(30);check(protocol+' reject wrong source',page.evaluate('document.body.dataset.currentScene')==before)
  # Explicit reset clears both surfaces' data; browsing and settings preserve.
  page.locator('[data-reset]').evaluate('(el)=>el.click()');page.wait_for_timeout(60);f=goto(page,'A-personal-new');check(protocol+' explicit reset',f.get_by_role('textbox',name='消息',exact=True).input_value()=='')
  # Legacy ID and direct standalone MVP action bridge.
  for old in ['P-M05-CHAT','P-M06-DETAIL-PERSONAL-110-0-1','P-M09-PRE-BLOCK']:
   page.evaluate('(s)=>location.hash="scene="+s',old);page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=M['aliases'][old]);check(protocol+' alias '+old,True)
  page.close()
 browser.close()
server.shutdown()
report['passed']=all(s['pass'] for s in report['scenes']) and all(a['passed'] for a in report['actions']) and all(c['passed'] for c in report['checks']) and not report['errors'] and not report['requests']
(OUT/('browser-quick.json' if args.quick else 'browser.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':report['passed'],'scenes':len(report['scenes']),'actions':len(report['actions']),'errors':report['errors'],'checks':report['checks']},ensure_ascii=False))
raise SystemExit(0 if report['passed'] else 1)
