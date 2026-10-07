from pathlib import Path
import json,hashlib
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-circle-copy/independent';rows=[]
paths=['docs/mvp-complete-flow-hifi/prototype-manifest.json','docs/mvp-complete-flow-hifi/prototype.html','docs/mvp-complete-flow-hifi/review.html','design-demos/polo-client-source-baseline/prototype.html','docs/client-journey-review/spec.md']
(O/'checked-inputs.json').write_text(json.dumps({p:hashlib.sha256((R/p).read_bytes()).hexdigest() for p in paths},indent=2))
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def go(s):q.goto((R/'docs/mvp-complete-flow-hifi/prototype.html').as_uri()+'?scene='+s);q.wait_for_timeout(180);return q.locator('[data-prototype-scene]:visible')
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for sid in ['P-M07-LIST','P-M07-LIST-RENEWED']:
   s=go(sid);text=s.inner_text();assert s.get_by_role('heading',name='我的圈子',exact=True).count()==1;assert s.get_by_text('查看圈子内容，管理订阅',exact=True).count()==1;assert '已加入的圈子' not in text and '看看每个圈子带来的 App 和技能' not in text
   assert s.locator('.circle-card:visible').count()==4;targets=s.locator('.circle-card button').evaluate_all('(es)=>es.map(e=>({label:e.innerText,to:e.dataset.go}))');assert all(t['label']=='查看详情' for t in targets);assert len(set(t['to'] for t in targets))==4
   overflow=q.evaluate('document.documentElement.scrollWidth>innerWidth');assert not overflow;q.screenshot(path=str(O/f'{sid}-{w}.png'),animations='disabled')
   s.get_by_placeholder('圈子或创作者名称').fill('数据工坊');assert s.locator('.circle-card:visible').count()==1 and '数据工坊圈' in s.locator('.circle-card:visible').inner_text();s.get_by_placeholder('圈子或创作者名称').fill('');assert s.locator('.circle-card:visible').count()==4
   s.get_by_role('combobox',name='圈子状态').select_option('restore');assert s.locator('.circle-card:visible').count()==0 and s.get_by_text('没有匹配的圈子。调整搜索或状态筛选后再试。').is_visible();s.get_by_role('combobox',name='圈子状态').select_option('all');assert s.locator('.circle-card:visible').count()==4
   s.locator('[data-circle-kind=data]').get_by_text('查看详情',exact=True).click();assert q.locator('.scene.active').get_attribute('data-prototype-scene')=='P-M07-DETAIL-DATA';q.locator('.scene.active').get_by_text('返回我的圈子',exact=True).click();assert q.locator('.scene.active').get_attribute('data-prototype-scene')=='P-M07-LIST';q.locator('.scene.active').get_by_text('返回首页',exact=True).click();assert q.locator('.scene.active').get_attribute('data-prototype-scene')=='P-M03-HOME-PERSONAL'
   rows.append({'scene':sid,'viewport':f'{w}x{h}','title_and_subtitle_once':True,'old_copy_removed':True,'row_count':4,'targets':targets,'search_restore':True,'status_filter_restore':True,'detail_and_home_navigation':True,'overflow':overflow})
 q.set_viewport_size({'width':1024,'height':768})
 for sid in ['P-M07-DETAIL-DATA-SUBSCRIPTION','P-M07-DETAIL-PAID-SUBSCRIPTION','P-M07-YEAR-RESULT','P-M10-SETTINGS-DEVICE']:
  s=go(sid);rows.append({'review_only_example':sid,'text':s.inner_text()});q.screenshot(path=str(O/f'example-{sid}.png'),animations='disabled')
 b.close()
(O/'browser-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('checks',len(rows))
