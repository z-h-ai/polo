#!/usr/bin/env python3
"""R13 cross-end return, subscription and support recovery checks for the offline prototype."""
from pathlib import Path
import json,hashlib,os
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/closure-r13');m=json.loads((B/'prototype-manifest.json').read_text());by={x['id']:x for x in m['scenes']}
report={'revision':m['revision'],'actions':[],'checks':[],'errors':[],'network':[]}
with sync_playwright() as pw:
 browser=pw.chromium.launch();page=browser.new_page(viewport={'width':1440,'height':900})
 page.on('pageerror',lambda e:report['errors'].append(str(e)))
 page.on('request',lambda r:report['network'].append(r.url) if r.url.startswith(('http://','https://')) else None)
 page.goto((B/'review.html').as_uri());page.wait_for_timeout(300)
 def go(id):
  page.locator('[data-scene-link="'+id+'"]').evaluate('(el)=>el.click()');page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=id)
  f=page.locator('[data-prototype-viewport]').element_handle().content_frame();f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=id);return f
 for vp in m['target']['viewports']:
  page.locator('[data-viewport-select]').select_option(vp['id'],force=True)
  for id in m['change']['changed_scenes']:
   if id not in by or by[id]['surface']!='mvp':continue
   f=go(id)
   for edge in by[id]['transitions']:
    if 'R13' not in edge['id']:continue
    f=go(id);control=f.locator('[data-transition="'+edge['id']+'"]')
    if not control.is_visible():
     report.setdefault('unexercised_inherited_controls',[]).append({'scene':id,'transition':edge['id'],'reason':'retained control in closed menu; outside closure delta'});continue
    if edge['label']=='复制问题信息':
     f.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('fixture denied')}}})")
    control.scroll_into_view_if_needed();control.click(force=True)
    page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=edge['to'])
    if edge['label']=='复制问题信息':f.wait_for_function("()=>document.querySelector('.scene.active [data-copy-status]').textContent.includes('手动复制')")
    report['actions'].append({'viewport':vp['id'],'from':id,'transition':edge['id'],'to':edge['to'],'passed':True})
  for id in ['P-M07-RENEW-RESULT','P-M07-LIST-RENEWED','P-M07-LIST','P-M07-LOGIN-CODE','P-M11-SUPPORT-ACCOUNT-ADMIN','P-M07-RETURN','P-M01-ENTERPRISE-READY','P-M07-SUPPORT','P-M07-SUPPORT-LOAD-FAIL','P-M11-SUPPORT-MEMBER','P-M07-RENEW-YEAR']:
   f=go(id);page.screenshot(path=str(E/(id+'-'+vp['id']+'.png')))
 # Actual boundaries: returning doesn't query; clipboard fallback doesn't navigate or create a ticket.
 f=go('P-M07-PUBLIC-WEB');f.get_by_role('button',name='返回 Polo',exact=True).click()
 page.wait_for_function("()=>document.body.dataset.currentScene==='P-M07-RETURN'");page.wait_for_timeout(350)
 assert page.evaluate('document.body.dataset.currentScene')=='P-M07-RETURN';report['checks'].append('circle return does not query')
 f=go('P-M01-INVITE-BROWSER');f.get_by_role('button',name='返回 Polo 核对企业').click();page.wait_for_function("()=>document.body.dataset.currentScene==='P-M01-RETURN'")
 assert '待审批' in go('P-M01-INVITE-PENDING').locator('.scene.active').inner_text();report['checks'].append('enterprise pending retained')
 f=go('P-M11-SUPPORT-MEMBER');txt=f.locator('.scene.active [data-support-info]').input_value();assert 'SUB-' not in txt and '¥' not in txt;report['checks'].append('member support no financial details')
 assert not any(x['id']=='P-M07-JOIN-PENDING' for x in m['scenes']);report['checks'].append('circle approval removed')
 for id in ['P-M07-SUPPORT','P-M07-SUPPORT-LOAD-FAIL']:
  txt=go(id).locator('.scene.active').inner_text();assert '已创建' not in txt and '已受理' not in txt;report['checks'].append(id+' no ticket created')
 # Critical consumer fixtures: login returns to original circle and renewal preserves original order.
 for id,expected in [('P-M07-RENEW-RETURN','SUB-20261002-0183'),('P-M07-RENEW-RESULT','2026-12-02'),('P-M07-LIST-RENEWED','2026-12-02'),('P-M07-LIST','星河年度圈'),('P-M11-SUPPORT-ACCOUNT-ADMIN','ACC-0182'),('P-M11-SUPPORT-BROWSER','客户资料核验')]:
  f=go(id);assert expected in f.locator('.scene.active').inner_text() or (f.locator('.scene.active textarea').count() and expected in f.locator('.scene.active textarea').input_value());report['checks'].append(id+' original object retained')
 f=go('P-M07-LOGIN-CODE');f.get_by_role('button',name='继续',exact=True).click();page.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg='P-M07-RETURN');report['checks'].append('phone login preserves original circle target')
 browser.close()
report['passed']=not report['errors'] and not report['network']
report['artifacts']={str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',R/'design-demos/polo-client-source-baseline/prototype.html']}
(E/'closure-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('closure checks',len(report['actions']),report['checks'],report['passed'])

