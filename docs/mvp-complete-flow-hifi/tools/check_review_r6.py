#!/usr/bin/env python3
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
B=Path(__file__).resolve().parents[1];ROOT=B.parents[1]
sys.path.insert(0,str(Path.home()/'.agents/skills/product-ui-prototype/scripts'))
from quality_report import snapshot,fingerprints
m=json.loads((B/'prototype-manifest.json').read_text());out={'artifacts':snapshot(B,ROOT,m),'fingerprints':fingerprints(),'checks':[]}
with sync_playwright() as p:
 br=p.chromium.launch();page=br.new_page(viewport={'width':1680,'height':1000});page.goto((B/'review.html').as_uri()+'#scene=P-M05-NEW');page.wait_for_selector('iframe');f=page.frames[1];f.wait_for_selector('.scene.active textarea');f.locator('.scene.active textarea').fill('保留这段草稿')
 before=f.evaluate('()=>[innerWidth,innerHeight]');page.locator('[data-panel-entry="index"]').click();page.locator('[data-inspector-tab="settings"]').click();page.locator('[data-zoom-select]').select_option(label='100%');page.locator('[data-inspector-toggle]').click()
 out['checks'].append({'name':'panel-and-zoom-preserve-iframe-and-draft','passed':f.evaluate('()=>[innerWidth,innerHeight]')==before and f.locator('.scene.active textarea').input_value()=='保留这段草稿'})
 page.locator('[data-panel-entry="index"]').click();page.locator('[data-inspector-tab="settings"]').click();page.locator('[data-viewport-select]').select_option('desktop-1024x768');page.locator('[data-inspector-toggle]').click();f.wait_for_function('()=>innerWidth===1024&&innerHeight===768');out['checks'].append({'name':'real-css-viewport-1024','passed':f.locator('.scene.active textarea').input_value()=='保留这段草稿'})
 page.set_viewport_size({'width':800,'height':820});page.locator('[data-panel-entry="index"]').click();out['checks'].append({'name':'narrow-panel-keeps-frame-and-flow-navigation','passed':len(page.frames)==2 and page.locator('[data-flow-nav]').is_visible()});page.locator('[data-inspector-toggle]').click();out['checks'].append({'name':'resize-preserves-draft','passed':f.locator('.scene.active textarea').input_value()=='保留这段草稿'})
 page.set_viewport_size({'width':1680,'height':1000});page.locator('[data-panel-entry="index"]').click();page.locator('[data-inspector-tab="settings"]').click();page.locator('[data-reset]').click();page.wait_for_function('()=>document.body.dataset.currentScene==="P-M03-HOME-ENT"');out['checks'].append({'name':'reset-enters-default-story','passed':True})
 page.goto((B/'review.html').as_uri()+'#story=S-LOCAL-SKILLS&step=S-LOCAL-SKILLS-06&scene=P-M03-HOME-ENT');page.wait_for_function('()=>document.body.dataset.currentScene==="P-M06-ENABLED-PERSONAL"');out['checks'].append({'name':'deep-link-step-wins-over-conflicting-scene','passed':True});page.screenshot(path=str(B/'build/ux-r6/review-console.png'))
 br.close()
out['status']='passed' if all(x['passed'] for x in out['checks']) else 'failed';(B/'build/ux-r6/review-shell-raw.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':out['status'],'checks':out['checks']},ensure_ascii=False))
