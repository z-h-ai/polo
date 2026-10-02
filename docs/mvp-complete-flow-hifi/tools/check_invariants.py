#!/usr/bin/env python3
"""Behavior regressions for accepted isolation/recovery rules, across real frames."""
import json,hashlib
from pathlib import Path
import os
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';O=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r12');M=json.loads((B/'prototype-manifest.json').read_text())
results=[]
def check(name,ok):
 results.append({'check':name,'passed':bool(ok)});print(name,ok,flush=True)
def shown(p):return p.locator('[data-assistant-viewport]' if p.evaluate('document.body.dataset.currentScene').startswith('A-') else '[data-prototype-viewport]').element_handle().content_frame()
def wait(p,s):
 p.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=s);f=shown(p);f.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=s);return f
def go(p,s):p.evaluate('(s)=>location.hash="scene="+s',s);return wait(p,s)
def clear(p):p.locator('[data-reset]').evaluate('(e)=>e.click()');p.wait_for_timeout(50)
def click(p,key,target):
 f=shown(p);f.locator('[data-transition$="-'+key+'"]').evaluate('(e)=>e.click()');return wait(p,target)
with sync_playwright() as pw:
 b=pw.chromium.launch();p=b.new_page(viewport={'width':1440,'height':980});p.goto((B/'review.html').as_uri()+'#scene=A-personal-conversation');wait(p,'A-personal-conversation')
 f=shown(p);f.get_by_role('textbox',name='消息',exact=True).fill('原会话已保存消息');click(p,'send','A-personal-generating');f=click(p,'new','A-personal-new');check('new conversation excludes prior messages','原会话已保存消息' not in f.locator('.mvp-transcript').inner_text());check('new conversation empty draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='')
 f.get_by_role('textbox',name='消息',exact=True).fill('新会话消息');f=click(p,'send','A-personal-generating');check('new conversation has no old fixture','请整理这份资料' not in f.locator('.mvp-transcript').inner_text())
 f=click(p,'sessions','A-personal-conversation');check('original conversation kept','原会话已保存消息' in f.locator('.mvp-transcript').inner_text() and '新会话消息' not in f.locator('.mvp-transcript').inner_text())
 for state in ['offline','preblock','cut']:
  clear(p);go(p,'A-personal-'+state);f=click(p,'files','A-personal-files');f.get_by_role('textbox',name='消息',exact=True).fill('不能绕过限制');check(state+' file navigation keeps send blocked',f.get_by_role('button',name='发送消息').is_disabled());f=click(p,'new','A-personal-new');f.get_by_role('textbox',name='消息',exact=True).fill('仍然受限');check(state+' new conversation keeps send blocked',f.get_by_role('button',name='发送消息').is_disabled())
 clear(p);f=go(p,'A-personal-deleted');check('deleted session no file access',f.get_by_role('button',name='查看会话文件').count()==0);f=click(p,'original','A-personal-conversation');check('deleted session no old content','请整理这份资料' not in f.locator('.mvp-transcript').inner_text())
 for scope in ['personal','enterprise']:
  clear(p);go(p,f'A-{scope}-restricted');f=click(p,'remove',f'A-{scope}-restricted-remove');check(scope+' removal keeps revoked authorization','已失效' in f.locator('dl').inner_text());f=click(p,'cancel',f'A-{scope}-restricted');check(scope+' cancel remains revoked','已失效' in f.locator('dl').inner_text())
  go(p,f'A-{scope}-installed');f=click(p,'detail',f'A-{scope}-legacy-detail-100-0-1');check(scope+' detail does not enable','未启用' in f.locator('dl').inner_text());f=click(p,'update',f'A-{scope}-legacy-detail-110-0-1');check(scope+' update retains disabled','未启用' in f.locator('dl').inner_text() and '1.1.0' in f.locator('dl').inner_text());f=click(p,'remove',f'A-{scope}-legacy-remove-110-0-1');f=click(p,'cancel',f'A-{scope}-legacy-detail-110-0-1');check(scope+' cancel retains version','1.1.0' in f.locator('dl').inner_text())
 clear(p);f=go(p,'A-personal-sourceauth');check('empty credential cannot connect',f.get_by_role('button',name='保存并连接').is_disabled());f=click(p,'cancel','A-personal-sourcedisconnected');check('cancel is not successful connection','未连接' in f.locator('dl').inner_text())
 clear(p);f=go(p,'A-personal-missing');before=f.locator('.mvp-question').inner_text();check('replacement requires file picker',f.get_by_label('重新选择文件').get_attribute('type')=='file');f.get_by_label('重新选择文件').set_input_files({'name':'新文件.txt','mimeType':'text/plain','buffer':b'content'});f=wait(p,'A-personal-reselected');check('replacement names selected file','新文件.txt' in f.locator('.mvp-question').inner_text())
 clear(p);go(p,'A-personal-cut');click(p,'recharge','P-M09-BROWSER-STREAM');shown(p).get_by_role('button',name='返回 Polo').click();wait(p,'A-personal-returnstream');f=click(p,'notnow','A-personal-cut');check('not yet preserves interrupted output','已整理第一部分' in f.locator('.mvp-transcript').inner_text())
 clear(p);go(p,'A-enterprise-budgetowner');click(p,'manage','P-M09-BROWSER-BUDGET');shown(p).get_by_role('button',name='返回 Polo').click();wait(p,'A-enterprise-budgetreturn');f=click(p,'query','A-enterprise-budgetchecking');check('budget queries budget','正在查询企业预算' in f.locator('.mvp-notice').inner_text());f=go(p,'A-enterprise-ownerresumed');f.get_by_role('textbox',name='消息',exact=True).fill('仍受预算阻断');check('credit recovery does not clear budget',f.get_by_role('button',name='发送消息').is_disabled())
 clear(p);go(p,'A-personal-new');f=shown(p);f.get_by_role('textbox',name='消息',exact=True).fill('视图切换保留');go(p,'P-M03-HOME-PERSONAL');f=go(p,'A-personal-new');check('surface switch keeps draft',f.get_by_role('textbox',name='消息',exact=True).input_value()=='视图切换保留')
 for old,new in M['aliases'].items():go(p,old) if False else None;p.evaluate('(s)=>location.hash="scene="+s',old);wait(p,new)
 check('all compatibility links',True)

 clear(p);go(p,'A-personal-restricted');click(p,'skills','A-personal-skills');click(p,'discover','A-personal-discover');f=click(p,'detail','A-personal-acquire');check('catalogue navigation cannot reauthorize','已失效' in f.locator('dl').inner_text() and f.locator('[data-transition$="-enable"]').is_disabled())
 clear(p);go(p,'A-personal-builtinoff');click(p,'discover','A-personal-discover');f=click(p,'detail','A-personal-acquire');check('catalogue preserves builtin preference','已停用' in f.locator('dl').inner_text())
 clear(p);go(p,'A-personal-uninstalled-110-0-0');f=click(p,'install','A-personal-installing');check('device preparation preserves flags',all(x in f.locator('dl').inner_text() for x in ['1.1.0','未启用','已停用','准备中']))
 clear(p);go(p,'A-personal-offline');f=click(p,'retry','A-personal-restored');f.get_by_role('textbox',name='消息',exact=True).fill('由我发起恢复');check('network retry really unlocks send',not f.get_by_role('button',name='发送消息').is_disabled())
 clear(p);go(p,'A-personal-preblock');click(p,'new','A-personal-new');click(p,'recovery','A-personal-availability');f=click(p,'credit-pre','A-personal-preblock');check('navigation retains recovery route','积分不足' in f.locator('.mvp-notice').inner_text())
 clear(p);go(p,'A-enterprise-budget');click(p,'notify','A-enterprise-budgetnotified');f=click(p,'query','A-enterprise-budgetmemberchecking');check('member budget query is not recharge','企业预算' in f.locator('.mvp-notice').inner_text())
 clear(p);go(p,'A-enterprise-ownerblock');f=click(p,'query','A-enterprise-ownerchecking');check('owner query retains role','企业充值' in f.locator('.mvp-notice').inner_text())
 clear(p);go(p,'A-personal-conversation');click(p,'new','A-personal-new');f=click(p,'files','A-personal-files');check('empty conversation has no fixture files','当前会话暂无文件' in f.locator('.mvp-transcript').inner_text() and '项目资料.pdf' not in f.locator('.mvp-transcript').inner_text())
 for sid in ['A-personal-empty-skills','A-personal-empty-sources']:
  clear(p);f=go(p,sid);check(sid+' empty navigator',f.locator('.source-navigator button').count()==0)

 clear(p);go(p,'A-personal-conversation');click(p,'new','A-personal-new');f=shown(p);f.get_by_label('附加文件',exact=True).set_input_files({'name':'仅附件.txt','mimeType':'text/plain','buffer':b'attachment only'});f=click(p,'files','A-personal-files');check('attachment alone creates no generated file','生成文件' not in f.locator('.mvp-question').inner_text() and f.locator('[data-transition$="-view"]').is_disabled());f=click(p,'attachment','A-personal-attachment');check('attachment viewer shows selected text','attachment only' in f.locator('.mvp-question').inner_text())
 for key,text in [('sourcefailed','连接失败'),('sourcedenied','未获得访问权限')]:
  clear(p);go(p,'A-personal-'+key);f=click(p,'sources','A-personal-sources');check(key+' list navigation retains connection failure',text in f.locator('dl').inner_text())
 # A standalone old MVP deep link and product home click must reach new assistant.
 direct=b.new_page();direct.goto((B/'prototype.html').as_uri()+'#scene=P-M05-CHAT');direct.wait_for_url('**/polo-client-source-baseline/prototype.html?scene=A-enterprise-generating');check('standalone legacy deep link',True)
 direct.goto((B/'prototype.html').as_uri()+'#scene=P-M03-HOME-PERSONAL');direct.locator('.scene.active [data-go="A-personal-new"]').first.click();direct.wait_for_url('**/polo-client-source-baseline/prototype.html?scene=A-personal-new');check('standalone home enters new assistant',True)
 b.close()
report={'passed':all(x['passed'] for x in results),'checks':results,'artifacts':{str(x.relative_to(R)):hashlib.sha256(x.read_bytes()).hexdigest() for x in [B/'prototype-manifest.json',B/'review.html',B/'prototype.html',R/'design-demos/polo-client-source-baseline/prototype.html']}}
(O/'invariants.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');raise SystemExit(0 if report['passed'] else 1)
