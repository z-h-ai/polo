#!/usr/bin/env python3
"""Execute source-bound POO-179 inputs against real components. Baseline is never Acceptance PASS."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

TOOL = Path(__file__).resolve().parent
REPO = TOOL.parents[4]

def encode(value): return json.dumps(value, ensure_ascii=False, indent=2) + '\n'
def snapshot(page): return page.evaluate('window.__LOCALIZATION_FIXTURE__.snapshot()')
def events(page): return page.evaluate('window.__LOCALIZATION_FIXTURE__.events')
def language(page, value):
    page.evaluate('(language) => window.__LOCALIZATION_FIXTURE__.changeLanguage(language)', value)
    page.wait_for_timeout(100)
def controls(page): return page.locator('[data-tutorial="permission-banner"]:visible button:visible')

def run_native(page, case, url):
    """Real actions and payloads. No translated component implementation is mirrored here."""
    kind, cid = case['execution']['native'], case['id']
    initial = snapshot(page)
    gaps = []
    extra = {}
    if kind == 'context':
        badge = page.get_by_role('button', name='90%', exact=True)
        badge.hover();page.get_by_role('tooltip').wait_for()
        if 'context used' in page.get_by_role('tooltip').inner_text(): gaps.append('original English context tooltip')
        page.evaluate('window.__LOCALIZATION_FIXTURE__.setProcessing(true)')
        assert badge.is_disabled()
        assert not [e for e in events(page) if e['action'] == 'sendMessage']
        page.evaluate('window.__LOCALIZATION_FIXTURE__.setProcessing(false)')
        badge.click()
        assert [e for e in events(page) if e['action'] == 'sendMessage'][-1]['args'][0] == '/compact'
    elif kind == 'permission':
        request = {'requestId':'localization-contract-request','sessionId':'localization-session','toolName':'Bash','type':'bash','command':'npm install fixture-package --ignore-scripts','description':'Fixture original description'}
        eligible = cid == 'P-eligible-claude'
        if cid != 'P-missing': request['canRememberForSession'] = eligible
        page.evaluate('(request) => window.__LOCALIZATION_FIXTURE__.arrangePermission(request)', request)
        page.locator('[data-tutorial="permission-banner"]:visible').wait_for()
        before = snapshot(page)
        language(page,'en');language(page,'zh-Hans')
        after = snapshot(page)
        assert before['permission'] == after['permission'] and before['draft'] == after['draft']
        count = controls(page).count()
        if count != (3 if eligible else 2): gaps.append(f'unsupported remember action still visible: {count} buttons')
        if 'Always Allow' in controls(page).all_inner_texts(): gaps.append('original English permission actions/hint')
        # The first and last existing actions retain allow and deny semantics.
        controls(page).first.click()
        actual = [e for e in events(page) if e['action']=='permissionResponse'][-1]['args']
        assert actual[:4] == ['localization-session',request['requestId'],True,False], actual
        page.evaluate('(request) => window.__LOCALIZATION_FIXTURE__.arrangePermission(request)',request)
        controls(page).last.click()
        actual = [e for e in events(page) if e['action']=='permissionResponse'][-1]['args']
        assert actual[:4] == ['localization-session',request['requestId'],False,False], actual
        if eligible:
            page.evaluate('(request) => window.__LOCALIZATION_FIXTURE__.arrangePermission(request)',request)
            controls(page).nth(1).click()
            actual = [e for e in events(page) if e['action']=='permissionResponse'][-1]['args']
            assert actual[:4] == ['localization-session',request['requestId'],True,True], actual
    elif kind == 'credential':
        mode = 'basic' if 'basic' in cid else 'multi-header' if 'multi-header' in cid else 'bearer'
        request = {'type':'credential','requestId':'localization-credential-contract','sessionId':'localization-session','sourceSlug':'fixture-api','sourceName':'Fixture API','mode':mode,'passwordRequired':cid=='A-input-basic-required'}
        if mode=='multi-header': request['headerNames']=['X-Fixture-Key','X-Fixture-Secret']
        page.evaluate('(request) => window.__LOCALIZATION_FIXTURE__.arrangeCredential(request)', request)
        if mode=='basic':
            page.locator('#credential-username:visible').fill('  fixture-user  ')
            page.locator('#credential-password:visible').fill(' fixture-password ' if request['passwordRequired'] else '')
        elif mode=='multi-header':
            page.locator('#credential-header-0:visible').fill('  fixture-first  ')
            page.locator('#credential-header-1:visible').fill('  fixture-second  ')
        else: page.locator('#credential-value:visible').fill('  fixture-token  ')
        before_inputs=page.locator('form input:visible').evaluate_all('(nodes)=>nodes.map(n=>({name:n.name,value:n.value,type:n.type}))')
        language(page,'en');language(page,'zh-Hans')
        assert before_inputs==page.locator('form input:visible').evaluate_all('(nodes)=>nodes.map(n=>({name:n.name,value:n.value,type:n.type}))')
        if 'Authentication Required' in page.locator('body').inner_text():gaps.append('original English credential templates')
        if cid=='A-input-cancel':page.locator('form:visible button[type="button"]').last.click()
        else:page.locator('form:visible button[type="submit"]').click()
        actual=[e for e in events(page) if e['action']=='credentialResponse'][-1]['args']
        assert actual[:2]==['localization-session',request['requestId']]
        value=actual[2]
        if cid=='A-input-cancel':assert value=={'type':'credential','cancelled':True}
        elif mode=='basic':
            assert value['username']=='fixture-user' and value['cancelled'] is False
            assert value['password']==('fixture-password' if request['passwordRequired'] else ''), 'existing helper trims required password and empties optional password'
        elif mode=='multi-header':assert value['headers']=={'X-Fixture-Key':'fixture-first','X-Fixture-Secret':'fixture-second'}
        else:assert value['value']=='fixture-token'
    elif kind == 'table':
        page.locator('table').hover();page.get_by_title('全屏查看',exact=True).click()
        before = snapshot(page)['table']
        language(page,'en');language(page,'zh-Hans')
        assert snapshot(page)['table']==before
        if 'Table' in page.locator('body').inner_text() or 'Yes' in page.locator('body').inner_text():gaps.append('original Table/boolean system labels')
        page.get_by_title('表格控制',exact=True).last.click()
        page.get_by_role('menuitem').filter(has_text='分组依据').hover()
        page.get_by_role('menuitem').filter(has_text='Date').first.wait_for(state='visible')
    elif kind == 'overlay':
        page.locator('[data-search-exclude="true"] > button').click()
        page.locator('[data-search-exclude="true"] [class~="group/row"]').click()
        path='/fixture/work/原名 Report.md'
        button=page.get_by_title(path,exact=True);button.click()
        text=page.get_by_role('menu').inner_text()
        if 'Reveal in Finder' in text:gaps.append('original English file path actions')
        page.get_by_role('menuitem').first.click()
        assert [e for e in events(page) if e['action']=='openFileExternal'][-1]['args']==[path]
        page.get_by_role('menu').wait_for(state='hidden')
        page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        button.click(button='right');page.get_by_role('menu').wait_for(state='visible');page.get_by_role('menuitem').last.click()
        assert [e for e in events(page) if e['action']=='revealInFinder'][-1]['args']==[path]
        language(page,'en');language(page,'zh-Hans')
        assert snapshot(page)['session']['messages']==initial['session']['messages']
        assert page.get_by_title(path,exact=True).is_visible()
    elif kind == 'turn':
        language(page,'en');language(page,'zh-Hans')
        assert snapshot(page)['session']['messages']==initial['session']['messages']
        assert snapshot(page)['draft']==initial['draft']
        if 'Todo List Updated' in page.locator('body').inner_text():gaps.append('original English todo system status')
    elif kind == 'settings':
        page.locator('[data-localization-case="settings-no-results"] button').click()
        field=page.get_by_role('dialog').locator('input');field.fill('no-match-179')
        language(page,'en');language(page,'zh-Hans');assert field.input_value()=='no-match-179'
        assert not [e for e in events(page) if e['action']=='settingValue']
        if 'No results found' in page.get_by_role('dialog').inner_text():gaps.append('original English settings empty state')
        menu=case['execution'].get('language_menu_actual')
        if menu:
            extra['settings_search_state']={'events':events(page),'final_snapshot':snapshot(page)}
            page.clock.set_fixed_time(datetime(2026,10,28,12,tzinfo=timezone.utc))
            page.goto(url+menu,wait_until='networkidle',timeout=60000)
            page.wait_for_function('Boolean(window.__LOCALIZATION_FIXTURE__)');page.evaluate('document.fonts.ready')
            wrapper=page.locator('[data-localization-case="settings-language"]')
            wrapper.locator('button:has-text("简体中文")').click()
            dialog=page.get_by_role('dialog');dialog.wait_for()
            dialog.locator('button').filter(has_text='English').click()
            page.wait_for_timeout(300)
            assert wrapper.locator('button:has-text("English")').count()==1
            assert page.get_by_text('Language',exact=True).count()==1 and page.get_by_text('语言',exact=True).count()==0
            assert page.evaluate("localStorage.getItem('i18nextLng')")=='en'
            assert not [e for e in events(page) if e['action']=='settingValue'],'real AppearanceSettingsPage menu drives i18n; fixture recorder must stay unused'
            extra['real_language_menu']={'scene':menu,'trigger':'简体中文→English','row_label':'Language','stored_language':'en','fixture_setting_value_events':0}
    elif kind == 'remote':
        page.get_by_role('dialog').wait_for()
        assert page.get_by_role('dialog').locator('input').input_value()=='/fixture/work'
        if 'No subdirectories.' in page.get_by_role('dialog').inner_text():gaps.append('original English directory empty state')
        language(page,'en');language(page,'zh-Hans')
        assert page.get_by_role('dialog').locator('input').input_value()=='/fixture/work'
    elif kind == 'reauth':
        page.locator('main button').first.click()
        fallback=page.locator('main [class~="border-destructive/20"]')
        fallback.wait_for(state='visible')
        if 'Login failed' in fallback.inner_text():gaps.append('original English non-Error reauthentication fallback')
        assert [e for e in events(page) if e['action']=='login']==[{'action':'login','args':[]}]
    else:raise ValueError('unknown native execution '+kind)
    return {'interaction_payload_checks':'passed','known_localization_gaps':gaps,'events':events(page),'final_snapshot':snapshot(page),**extra}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,default=TOOL/'localization-functional-cases.json')
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--mode',choices=['inventory','baseline','verify'],default='inventory')
    parser.add_argument('--frontend-url')
    parser.add_argument('--case',action='append')
    args=parser.parse_args();plan=json.loads(args.input.read_text());out=args.output_dir.resolve();out.mkdir(parents=True,exist_ok=True)
    selected=[c for c in plan['cases'] if not args.case or c['id'] in args.case]
    if args.case and {c['id'] for c in selected}!=set(args.case):raise ValueError('unknown case requested')
    declared_ids=[c['id'] for c in plan['cases']]
    selected_ids=[c['id'] for c in selected]
    selection_complete=not args.case and len(selected_ids)==len(declared_ids)
    rows=[];proc=None;log=None;browser=None
    try:
        if args.mode!='inventory' and any(c['execution']['kind']=='native' for c in selected):
            url=args.frontend_url
            if not url:
                url='http://127.0.0.1:43179';log=(out/'vite.log').open('wb')
                proc=subprocess.Popen([str(REPO/'node_modules/.bin/vite'),'--config','vite.config.mjs','--host','127.0.0.1','--port','43179','--strictPort'],cwd=TOOL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                (out/'service-owner.json').write_text(encode({'pid':proc.pid,'cwd':str(TOOL),'args':proc.args,'owner':'POO-179 native functional driver','release':'finally terminate/wait; no caller service stopped'}))
                for _ in range(150):
                    if proc.poll() is not None:raise RuntimeError('owned Vite exited')
                    try:urllib.request.urlopen(url+'/entries/baseline.html',timeout=1).close();break
                    except OSError:time.sleep(.2)
                else:raise RuntimeError('owned Vite did not become ready')
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True)
                try:
                    for case in selected:
                        if case['execution']['kind']!='native':continue
                        context=browser.new_context(viewport={'width':1280,'height':800},device_scale_factor=1,reduced_motion='reduce');page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                        row={'id':case['id'],'kind':'native','mode':args.mode}
                        try:
                            page.clock.set_fixed_time(datetime(2026,10,28,12,tzinfo=timezone.utc))
                            page.goto(url+case['execution']['actual'],wait_until='networkidle',timeout=60000)
                            page.wait_for_function('Boolean(window.__LOCALIZATION_FIXTURE__)');page.evaluate('document.fonts.ready')
                            row.update(run_native(page,case,url));assert not errors,errors
                            shot=out/(case['id']+'.png');page.screenshot(path=str(shot));row['screenshot']=str(shot);row['screenshot_sha256']=hashlib.sha256(shot.read_bytes()).hexdigest()
                            row['status']='known_requirement_gaps' if row['known_localization_gaps'] else 'passed'
                        except Exception as error:
                            row.update(status='failed',error=str(error),error_type=type(error).__name__)
                            shot=out/(case['id']+'-failed.png');page.screenshot(path=str(shot));row['failure_screenshot']=str(shot)
                            row['failure_dom']={'body':page.locator('body').inner_text()[:8000],'menus':page.get_by_role('menu').count(),'menuitems':page.get_by_role('menuitem').count()}
                        finally:row['page_errors']=errors;context.close();rows.append(row)
                finally:browser.close();browser=None
        contract_cache={}
        for case in selected:
            execution=case['execution']
            if args.mode=='inventory' or execution['kind']!='native':
                paths=execution.get('test_files',[]);missing=[name for name in paths if not (REPO/name).is_file()]
                # Backend/origin obligations remain explicit; this driver does not turn browser fixtures into authority proof.
                if args.mode=='verify' and execution['kind']=='contract_tests' and not missing:
                    argv=execution['argv'];key=tuple(argv)
                    if key not in contract_cache:
                        result=subprocess.run(argv,cwd=REPO,capture_output=True,text=True,check=False)
                        log_path=out/f'contract-{len(contract_cache)}.log'
                        log_path.write_text(result.stdout+'\n'+result.stderr)
                        import re
                        counts=re.findall(r'(\d+) pass',result.stdout+'\n'+result.stderr)
                        contract_cache[key]={'exit_code':result.returncode,'log':str(log_path),'nonzero_test_count':any(int(value)>0 for value in counts)}
                    result=contract_cache[key]
                    rows.append({'id':case['id'],'kind':execution['kind'],'status':'passed' if result['exit_code']==0 and result['nonzero_test_count'] else 'failed','argv':argv,'execution':result,'semantic_coverage':'exact case family still requires independent Review of these real tests; command success alone does not prove origin/permission authority'})
                else:
                    rows.append({'id':case['id'],'kind':execution['kind'],'status':'not_executed' if not missing else 'blocked_missing_planned_test','argv':execution.get('argv'),'missing':missing,'reason':'Baseline material preparation does not rerun unrelated API/unit layers. Verify executes exact implemented contracts; missing planned tests fail closed.'})
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid,signal.SIGTERM)
            try:proc.wait(timeout=15)
            except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=10)
        if log:log.close()
        if args.mode!='verify' or any(r['status']!='passed' for r in rows):verdict='inconclusive'
        elif selection_complete:verdict='passed'
        else:verdict='passed_selected_cases'
        report={'mode':args.mode,'input_sha256':hashlib.sha256(args.input.read_bytes()).hexdigest(),'cases':rows,'browser_closed':browser is None,'owned_service_exit':None if proc is None else proc.poll(),'scope':'real native interaction and case inventory; no Electron/backend/permission-memory Acceptance claim','verdict':verdict,
            'selection_scope':{'declared_case_ids':declared_ids,'selected_case_ids':selected_ids,'selection_complete':selection_complete,
                'verdict_scope':('all declared cases in this input' if selection_complete else 'selected_cases only; a partial-selection receipt never counts as a whole-card PASS and full business acceptance stays with the formal process')}}
        (out/'receipt.json').write_text(encode(report))
    print(json.dumps({'verdict':report['verdict'],'selection_complete':selection_complete,'declared':len(declared_ids),'selected':len(selected_ids),'statuses':{s:sum(r['status']==s for r in rows) for s in sorted({r['status'] for r in rows})}}))
    return 0 if args.mode!='verify' else 0 if report['verdict'] in ('passed','passed_selected_cases') else 2

if __name__=='__main__':raise SystemExit(main())
