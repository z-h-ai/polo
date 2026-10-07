from pathlib import Path
import json
from playwright.sync_api import sync_playwright
R=Path.cwd();O=R/'docs/mvp-complete-flow-hifi/evidence/r15-classic-style/independent';logs=[]
P={'mvp':R/'docs/mvp-complete-flow-hifi/prototype.html','assistant':R/'design-demos/polo-client-source-baseline/prototype.html'}
def record(name,**kw):logs.append({'check':name,**kw});(O/'interaction-log.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2))
with sync_playwright() as pw:
 b=pw.chromium.launch();q=b.new_page();q.set_default_timeout(4000)
 def go(scene):
  q.goto(P['assistant' if scene.startswith('A-') else 'mvp'].as_uri()+'?scene='+scene);q.wait_for_timeout(100);return q.locator('[data-prototype-scene]:visible')
 def current():return q.locator('[data-prototype-scene]:visible').get_attribute('data-prototype-scene')
 for w,h in [(1440,900),(1024,768),(800,600)]:
  q.set_viewport_size({'width':w,'height':h})
  for scope,home in [('personal','P-M03-HOME-PERSONAL'),('enterprise','P-M03-HOME-ENT')]:
   s=go(home);cards=s.locator('.product-card').filter(has_text='Polo 助手');assert cards.get_by_text('管理技能',exact=True).count()==1 and cards.get_by_text('打开助手',exact=True).count()==1
   assert s.locator('.resource-nav,.polo-resource-nav').count()==0
   record('home-layout',viewport=w,scene=home,same_card_actions=True,circle_count=s.get_by_text('我的圈子',exact=True).count())
   s.get_by_text('管理技能',exact=True).click();q.wait_for_timeout(130);assert current()==f'A-{scope}-skills';record('home-skill-navigation',viewport=w,scene=home,result=current())
   if w==800:
    q.get_by_role('button',name='查看来源技能').click();assert q.locator('.polo-skill-detail').is_visible();q.locator('.polo-skill-detail').evaluate('(e)=>e.scrollTop=e.scrollHeight');q.wait_for_timeout(100);q.screenshot(path=str(O/f'skill-detail-open-{scope}-800.png'));record('narrow-skills-detail',scene=current(),visible_text=q.locator('.polo-skill-detail').inner_text(),header_scroll=q.locator('.polo-host-bar').get_attribute('data-scrolled'));q.get_by_text('返回技能列表',exact=True).click();assert q.locator('.polo-skill-results').is_visible()
   q.get_by_role('button',name='首页',exact=True).click();q.wait_for_timeout(130);assert current()==home;record('skills-return-home',viewport=w,scope=scope,result=current())
  s=go('P-M03-HOME-PERSONAL');s.get_by_text('我的圈子',exact=True).click();assert current()=='P-M07-LIST';q.locator('[data-prototype-scene]:visible').get_by_text('返回首页',exact=True).click();assert current()=='P-M03-HOME-PERSONAL';record('circle-round-trip',viewport=w,result=current())
  for scene,scrollsel,header in [('P-M03-HOME-PERSONAL','.workspace-main','.workbench-bar'),('P-M10-SETTINGS-DEVICE','.workspace-main','.workbench-bar'),('A-personal-preferences','.polo-preferences','.polo-host-bar')]:
   s=go(scene);hnode=s.locator(header);scroll=s.locator(scrollsel);initial=hnode.get_attribute('data-scrolled');sizes=scroll.evaluate('(e)=>[e.scrollHeight,e.clientHeight]');scroll.evaluate('(e)=>e.scrollTop=e.scrollHeight');q.wait_for_timeout(100);after=hnode.get_attribute('data-scrolled');top=scroll.evaluate('(e)=>e.scrollTop');assert initial=='false';assert after==('true' if top>0 else 'false');scroll.evaluate('(e)=>e.scrollTop=0');q.wait_for_timeout(100);assert hnode.get_attribute('data-scrolled')=='false';record('header-scroll',viewport=w,scene=scene,initial=initial,after=after,scrollTop=top,sizes=sizes)
  s=go('A-personal-skills');q.get_by_placeholder('名称或用途').fill('不存在的技能');assert q.get_by_text('没有匹配的技能。请调整搜索或筛选。').is_visible();q.get_by_placeholder('名称或用途').fill('');assert q.get_by_role('button',name='查看来源技能').is_visible();record('skill-search-recovery',viewport=w)
  s=go('P-M02-CONFIRM');s.get_by_text('取消切换',exact=True).click();record('dialog-cancel',viewport=w,result=current())
 # all scene/story IDs remain reachable in the review shell's embedded inventory
 q.goto((R/'docs/mvp-complete-flow-hifi/review.html').as_uri());q.wait_for_timeout(200)
 record('review-shell-open',url=q.url,title=q.title(),iframes=q.locator('iframe').count(),text=q.locator('body').inner_text()[:1600])
 b.close()
print('checks',len(logs))
