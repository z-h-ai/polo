from pathlib import Path
from playwright.sync_api import sync_playwright
import json
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-copy-cleanup/independent';rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def active():return q.locator('[data-prototype-scene]:visible')
 def go(s):q.goto((R/('design-demos/polo-client-source-baseline/prototype.html' if s.startswith('A-') else 'docs/mvp-complete-flow-hifi/prototype.html')).as_uri()+'?scene='+s);q.wait_for_timeout(80);return active()
 def command(s,kind='show-scene',epoch=1):q.evaluate('(d)=>postMessage(d,"*")',{'type':'product-ui-prototype:'+kind,'version':1,'session':'independent-cleanup','epoch':epoch,'scene':s});q.wait_for_timeout(50)
 def record(case,w,**kw):rows.append({'case':case,'viewport':w,**kw});(O/'interaction-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  s=go('P-M07-SOURCE-FALLBACK');assert s.locator('[data-app-key=meeting]').count()==1;meeting=s.locator('[data-app-key=meeting]');assert meeting.get_attribute('data-app-source')=='晨星设计圈';assert meeting.get_by_text('打开',exact=True).is_enabled();assert s.locator('[data-app-key=growth]').get_by_text('重新加入',exact=True).is_enabled();assert s.locator('[data-app-key=growth]').get_by_text('打开',exact=True).count()==0;meeting.get_by_text('打开',exact=True).click();assert active().get_attribute('data-prototype-scene')=='P-M04-APP-VIEW-PERSONAL';go('P-M07-SOURCE-FALLBACK').get_by_text('重新加入',exact=True).click();assert active().get_attribute('data-prototype-scene')=='P-M07-JOIN-FREE';record('fallback-dedup-and-authorization',w,shared_opens=True,revoked_only_rejoin=True)
  s=go('P-M03-MANAGE-HOME');assert s.locator('[data-app-key=brand]').count()==0;s.get_by_text('查看隐藏项',exact=True).click();assert active().get_attribute('data-prototype-scene')=='P-M03-CONTROLS';active().get_by_text('恢复显示',exact=True).click();assert active().get_attribute('data-prototype-scene')=='P-M03-HOME-PERSONAL';assert active().locator('[data-app-key=brand]').get_by_text('打开',exact=True).is_visible();record('hidden-item-restoration',w,result='P-M03-HOME-PERSONAL')
  for sid in ['P-M03-ALL-APPS-ZERO','P-M03-ALL-APPS','P-M03-ALL-APPS-ENT']:
   s=go(sid);search=s.get_by_placeholder('名称或用途');search.fill('不存在的应用');assert s.locator('[data-app-key]:visible').count()==0;search.fill('');assert s.locator('[data-app-key]:visible').count()>1;s.locator('[data-library-sort]').select_option('name');keys=s.locator('[data-app-key]:visible').evaluate_all('(es)=>es.map(e=>e.dataset.appKey)');assert len(keys)==len(set(keys));record('complete-directory-search-sort',w,scene=sid,keys=keys)
  s=go('P-M03-ALL-APPS-ENT-EMPTY');assert s.locator('[data-app-key]:visible').count()==1;assert s.get_by_text('企业尚未分发应用。管理员分发后会显示在这里。',exact=True).is_visible();s.get_by_text('管理技能',exact=True).click();assert active().get_attribute('data-prototype-scene')=='A-enterprise-skills';record('enterprise-empty-preserves-assistant',w)
  for scope,name in [('personal','资料研究'),('enterprise','销售周报')]:
   s=go('A-'+scope+'-detail')
   if w==800:s.get_by_role('button',name='查看来源技能').click()
   detail=s.locator('.polo-skill-detail');assert detail.get_by_text(name,exact=True).evaluate_all('(es)=>es.filter(e=>e.getClientRects().length).length')==1;assert detail.get_by_text('整理材料与进展，形成可核对的报告草稿',exact=True).evaluate_all('(es)=>es.filter(e=>e.getClientRects().length).length')==1
   if w==800:detail.get_by_text('返回技能列表',exact=True).click()
   s.get_by_role('button',name='查看内置技能').click();assert s.locator('.polo-skill-detail').get_by_text('资料研究',exact=True).evaluate_all('(es)=>es.some(e=>e.getClientRects().length)');assert 'Polo 内置' in s.locator('.polo-skill-detail').inner_text();record('skill-single-title-separate-built-in',w,scope=scope)
  go('P-M02-STOPPING');q.wait_for_timeout(2000);assert '已停止 0 / 3 项' in active().locator('.dialog').inner_text();record('direct-progress-static',w)
  go('P-M02-CONFIRM');active().get_by_text('停止全部并切换',exact=True).click();observed=[]
  for delay,n in [(50,0),(370,1),(370,2)]:
   q.wait_for_timeout(delay);d=active().locator('.dialog');text=d.inner_text();assert f'已停止 {n} / 3 项' in text;(observed.append({'n':n,'text':text}));assert d.locator('.row-state').all_text_contents().count('已停止')==n
  q.wait_for_timeout(1400);assert active().get_attribute('data-prototype-scene')=='P-M03-HOME-PERSONAL';record('count-row-progress-and-auto-completion',w,samples=observed)
  go('P-M02-CONFIRM');active().get_by_text('停止全部并切换',exact=True).click();q.wait_for_timeout(450);active().get_by_text('取消切换',exact=True).click();q.wait_for_timeout(1800);assert active().get_attribute('data-prototype-scene')=='P-M02-STOP-CANCEL';record('stop-cancel-no-late-switch',w)
  go('P-M02-CONFIRM');active().get_by_text('停止全部并切换',exact=True).click();q.wait_for_timeout(450);command('P-M02-STOPPING',kind='reset');q.wait_for_timeout(1800);assert active().get_attribute('data-prototype-scene')=='P-M02-STOPPING';assert '已停止 0 / 3 项' in active().locator('.dialog').inner_text();record('reset-clears-count-and-callback',w)
 b.close()
print('checks',len(rows))
