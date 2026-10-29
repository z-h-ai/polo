#!/usr/bin/env python3
"""Freeze actual Markdown/datatable/GenUI states for POO-171 component smoke."""
from __future__ import annotations
import argparse
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_reference', Path(__file__).with_name('export-conversation-references.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
SKILL, REPO, PREFIX = shared.SKILL, shared.REPO, shared.PREFIX
OUTPUT = SKILL / 'assets/prototypes/interview-table'
VIEWPORTS = shared.VIEWPORTS
CASES = [
    *[{'id':f'table-{mode}', 'scene':f'interview-table-{mode}', 'state':'long'} for mode in ('terminal','minimal','full')],
    {'id':'table-short','scene':'interview-table-full','state':'short'},
    {'id':'table-datatable','scene':'interview-table-datatable','state':'inline'},
    {'id':'table-expanded','scene':'interview-table-datatable','state':'expanded'},
    {'id':'table-genui','scene':'interview-table-genui','state':'file-backed'},
]


def route(case):
    return f'/entries/baseline.html?scene={case["scene"]}&pure=1'+('&short=1' if case['state']=='short' else '')


def steps(case):
    return [{'action':'click','selector':'button[title="全屏查看"]'}] if case['state']=='expanded' else []


def expected_outputs(evidence):
    baseline=json.loads((SKILL/'assets/source-baseline/baseline-manifest.json').read_text())
    source=SKILL/'assets/source-baseline/entries/baseline.html'
    if shared.sha(source.read_bytes())!=baseline['files']['entries/baseline.html']:raise ValueError('baseline export hash mismatch')
    files,records={},[]
    with shared.sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        try:
            for case in CASES:
                for viewport in VIEWPORTS:
                    page=browser.new_page(viewport={k:viewport[k] for k in ('width','height')},device_scale_factor=1)
                    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                    try:
                        page.clock.set_fixed_time(datetime(2026,10,28,12,tzinfo=timezone.utc))
                        page.emulate_media(reduced_motion='reduce')
                        page.goto(source.as_uri()+'?'+route(case).split('?',1)[1],wait_until='load')
                        page.locator('tbody tr').first.wait_for(state='visible')
                        for step in steps(case):page.locator(step['selector']).click()
                        if case['state']=='expanded':page.locator('[role="dialog"] table').wait_for(state='visible')
                        page.wait_for_timeout(500);page.evaluate('document.fonts.ready')
                        table=page.locator('[role="dialog"] table' if case['state']=='expanded' else 'table').first
                        metrics=table.evaluate('(t)=>({rows:t.tBodies[0].rows.length,columns:t.tHead.rows[0].cells.length,headerPosition:getComputedStyle(t.tHead.rows[0].cells[0]).position,width:t.getBoundingClientRect().width})')
                        expected_rows=2 if case['state']=='short' else 100
                        expected_columns=3 if case['state']=='short' else 21 if case['id']=='table-genui' else 20
                        if metrics['rows']!=expected_rows or metrics['columns']!=expected_columns:raise ValueError(f'{case["id"]}: {metrics}')
                        if errors:raise ValueError(errors)
                        html,styles=shared.freeze_native_reference(page);files.update(styles)
                        files[f'views/{case["id"]}-{viewport["name"]}.html']=html
                        record={'case':case['id'],'viewport':viewport['name'],'page_errors':errors,'table':metrics,'scope':'Actual current component state, not sticky fix completion'}
                        if evidence:
                            evidence.mkdir(parents=True,exist_ok=True);image=evidence/f'{case["id"]}-{viewport["name"]}.png';page.screenshot(path=str(image),caret='hide');record['screenshot']=str(image)
                        records.append(record)
                    finally:page.close()
        finally:browser.close()
    mapping={case['id']:{v['name']:f'views/{case["id"]}-{v["name"]}.html' for v in VIEWPORTS} for case in CASES}
    files['prototype.html']=('''<!doctype html><html><head><meta charset="utf-8"><title>Native table reference</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe title="Native table reference" id="reference"></iframe><script>const scenes=__SCENES__,sizes=__SIZES__;const selected=new URLSearchParams(location.search).get('scene');const scene=Object.hasOwn(scenes,selected)?selected:Object.keys(scenes)[0];const viewport=[...sizes].sort((a,b)=>Math.abs(a.width-innerWidth)-Math.abs(b.width-innerWidth))[0].name;document.getElementById('reference').src=scenes[scene][viewport];</script></body></html>'''.replace('__SCENES__',json.dumps(mapping)).replace('__SIZES__',json.dumps(VIEWPORTS))).encode()
    manifest={'schema_version':1,'kind':'frozen-native-table-reference','mode':'high_fidelity','revision':'poo171-native-reuse-r1',
        'files':{'prototype':'prototype.html',**{f'asset_{i}':name for i,name in enumerate(sorted(files)) if name!='prototype.html'}},
        'target':{'languages':['zh-Hans'],'themes':['light'],'viewports':[{'id':v['name'],'width':v['width'],'height':v['height']} for v in VIEWPORTS]},
        'scenes':[{'id':case['id'],'state':case['state'],'title':case['id'],'source_entry':'prototype.html'} for case in CASES],
        'design':{'skill_path':f'{PREFIX}/SKILL.md','sha256':shared.sha((SKILL/'SKILL.md').read_bytes()),'sources':[{'path':f'{PREFIX}/references/foundations.md','sha256':shared.sha((SKILL/'references/foundations.md').read_bytes())}]},
        'confirmations':[{'id':'D-ASSISTANT-REUSE','status':'confirmed','source':f'{PREFIX}/references/policy-alignment.json#D-ASSISTANT-REUSE','scope':'Preserve existing assistant Markdown/datatable styles only; current component reference does not approve a new layout or prove sticky behavior.'}],
        'provenance':{'generator':f'{PREFIX}/tools/export-table-reference.py','source_manifest':f'{PREFIX}/assets/source-baseline/baseline-manifest.json','source_input_fingerprint':baseline['input_fingerprint'],'source_export_sha256':shared.sha(source.read_bytes()),'method':'Actual Chromium render and native expand click, cloned DOM/CSS only in reference; live React runtime imports production components.','scope':'Component smoke and state coverage only; current header position is not the target sticky result. Full Electron, scroll geometry, row actions, source IO and actual bug before/after remain task acceptance.'}}
    files['prototype-manifest.json']=shared.encode(manifest)
    files['visual-plan.json']=shared.encode({'e2e':{'visual':{'mode':'smoke','viewports':VIEWPORTS,'routes':[{'name':case['id'],'state':case['state'],'actual':route(case),'whole_page':True,'capture_full_page':True,'actual_steps':steps(case),'state_assertions':[{'type':'visible','selector':'[role="dialog"] table' if case['state']=='expanded' else 'table'}]} for case in CASES]}}})
    files['runtime-manifest.json']=shared.encode({'services':{'frontend':{'url':'http://127.0.0.1:43171','cwd':f'{PREFIX}/tools/source-baseline','start':'../../../../../node_modules/.bin/vite --config vite.config.mjs --host 127.0.0.1 --port 43171 --strictPort','health_check':'/entries/baseline.html'}}})
    if evidence:(evidence/'capture-receipt.json').write_bytes(shared.encode({'cases':records,'browser_closed':True,'limits':manifest['provenance']['scope']}))
    return files


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');parser.add_argument('--evidence',type=Path);args=parser.parse_args();files=expected_outputs(args.evidence)
    if args.check:
        stale=[name for name,data in files.items() if not(OUTPUT/name).is_file() or (OUTPUT/name).read_bytes()!=data]
        if stale:raise SystemExit('stale table references: '+', '.join(stale))
    else:
        if (OUTPUT/'prototype-manifest.json').is_file():
            old=json.loads((OUTPUT/'prototype-manifest.json').read_text())
            if old['provenance']['generator']!=f'{PREFIX}/tools/export-table-reference.py':raise ValueError('unowned export')
            for name in old['files'].values():
                path=(OUTPUT/name).resolve()
                if not path.is_relative_to(OUTPUT.resolve()):raise ValueError('escaping generated asset')
                if name not in files:path.unlink(missing_ok=True)
        for name,data in files.items():
            path=OUTPUT/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    print(f'{len(CASES)} native table states x {len(VIEWPORTS)} viewports; {len(files)} reference files current')

if __name__=='__main__':main()
