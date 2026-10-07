from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview');O=R/'docs/mvp-complete-flow-hifi/evidence/r15-ui-refinement/independent';rows=[]
with sync_playwright() as p:
 b=p.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def go(scene):q.goto((R/('design-demos/polo-client-source-baseline/prototype.html' if scene.startswith('A-') else 'docs/mvp-complete-flow-hifi/prototype.html')).as_uri()+'?scene='+scene);q.wait_for_timeout(70);return q.locator('[data-prototype-scene]:visible')
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for home in ['P-M03-HOME-PERSONAL','P-M03-HOME-ENT']:
   s=go(home);assert s.locator('h1').inner_text()=='我的应用';assert s.locator('.product-card .status').count()==0
   style=s.locator('.product-card').last.evaluate('(e)=>({width:e.getBoundingClientRect().width,radius:getComputedStyle(e).borderRadius,padding:getComputedStyle(e).padding,font:getComputedStyle(e).fontSize})');rows.append({'check':'home-title-and-no-bottom-tags','scene':home,'viewport':w,'card_style':style,'creator_lines':s.locator('.product-card .source-line').all_text_contents()})
  for sid in ['P-M07-LIST','P-M07-LIST-RENEWED','P-M07-EMPTY']:
   s=go(sid);assert s.get_by_text('使用分享链接加入',exact=True).count()==0 and s.locator('input[placeholder*="链接"]').count()==0
   if 'EMPTY' not in sid:
    btns=s.locator('.circle-card button');assert all(x=='查看详情' for x in btns.all_text_contents());count=btns.count();assert count==4;s.get_by_placeholder('圈子或创作者名称').fill('不存在圈子');assert s.get_by_text('没有匹配的圈子。调整搜索或状态筛选后再试。').is_visible();s.get_by_placeholder('圈子或创作者名称').fill('');assert s.locator('.circle-card:visible').count()==4
   rows.append({'check':'circle-no-desktop-join-consistent-controls-search-recovery','scene':sid,'viewport':w})
  for sid in ['P-M07-DETAIL-FOCUS','P-M07-DETAIL-PAID','P-M07-DETAIL-DATA']:
   s=go(sid);assert s.get_by_text('退出圈子',exact=True).count()==0;assert s.get_by_text('查看全部应用',exact=True).count()==0;assert s.get_by_text('管理本机技能',exact=True).count()==0
   rows.append({'check':'circle-cards-and-no-top-exit','scene':sid,'viewport':w,'app_cards':s.locator('.product-card').count(),'grid':s.locator('.home-app-grid').count(),'card_style':s.locator('.product-card').first.evaluate('(e)=>({width:e.getBoundingClientRect().width,radius:getComputedStyle(e).borderRadius,padding:getComputedStyle(e).padding,font:getComputedStyle(e).fontSize})')})
  for sid in ['A-personal-new','A-enterprise-new','A-personal-skills']:
   s=go(sid);color=q.locator('.mvp-root').evaluate('(e)=>getComputedStyle(e).getPropertyValue("--background").trim()');assert color=='#fbfbfa';assert '既有助手行为示意' not in s.inner_text();rows.append({'check':'assistant-canvas-and-clean-product-surface','scene':sid,'viewport':w,'background_token':color})
 b.close()
(O/'content-log.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print('checks',len(rows))
