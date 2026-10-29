#!/usr/bin/env python3
"""Import adopted POO-178 native candidate renders without duplicating its JS bundle."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('native_reference', Path(__file__).with_name('export-conversation-references.py'))
shared = importlib.util.module_from_spec(spec); spec.loader.exec_module(shared)
SKILL, REPO, PREFIX = shared.SKILL, shared.REPO, shared.PREFIX
OUTPUT = SKILL / 'assets/prototypes/interview-sidebar'
SOURCE = SKILL / 'tools/sidebar-runtime/reference-source.json'
VIEWPORTS = shared.VIEWPORTS[:2]
CASES = [('sidebar-collapsed', 'collapsed'), ('sidebar-expanded', 'expanded')]


def expected_outputs(source_export, evidence):
    provenance = json.loads(SOURCE.read_text())
    if shared.sha(source_export.read_bytes()) != provenance['candidate']['bundle_sha256']:
        raise ValueError('source export does not match the adopted native candidate')
    files, records = {}, []
    with shared.sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for viewport in VIEWPORTS:
                for scene, state in CASES:
                    page = browser.new_page(viewport={k:viewport[k] for k in ('width','height')}, device_scale_factor=1)
                    errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
                    try:
                        page.clock.set_fixed_time(datetime(2026,10,28,12,tzinfo=timezone.utc))
                        # Deterministic entropy only: production randomized input hint stays real.
                        page.add_init_script('let state=178;Math.random=()=>((state=(state*1664525+1013904223)>>>0)/4294967296)')
                        page.emulate_media(reduced_motion='reduce')
                        page.goto(source_export.resolve().as_uri()+'?version=after&route=allSessions/session/read-1', wait_until='load')
                        more = page.get_by_text('更多', exact=True); more.wait_for(state='visible')
                        page.wait_for_timeout(1200)
                        if state == 'expanded': more.click(); page.wait_for_timeout(1200); page.locator('[data-tutorial="sources-nav"]').wait_for(state='visible')
                        page.evaluate('document.fonts.ready')
                        if errors: raise ValueError(errors)
                        text, styles = shared.freeze_native_reference(page)
                        files.update(styles); files[f'views/{scene}-{viewport["name"]}.html'] = text
                        record = {'scene':scene,'viewport':viewport['name'],'page_errors':errors,
                                  'horizontal_overflow':page.evaluate('document.documentElement.scrollWidth>innerWidth'),
                                  'source':'adopted candidate, not current production implementation'}
                        if evidence:
                            evidence.mkdir(parents=True,exist_ok=True)
                            image = evidence/f'{scene}-{viewport["name"]}.png'; page.screenshot(path=str(image),caret='hide')
                            record['screenshot']=str(image)
                        records.append(record)
                    finally: page.close()
        finally: browser.close()
    mapping={scene:{v['name']:f'views/{scene}-{v["name"]}.html' for v in VIEWPORTS} for scene,_ in CASES}
    files['prototype.html'] = ('''<!doctype html><html><head><meta charset="utf-8"><title>Adopted native sidebar reference</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe title="Adopted native sidebar reference" id="reference"></iframe><script>const scenes=__SCENES__,sizes=__SIZES__;const selected=new URLSearchParams(location.search).get('scene');const scene=Object.hasOwn(scenes,selected)?selected:Object.keys(scenes)[0];const viewport=[...sizes].sort((a,b)=>Math.abs(a.width-innerWidth)-Math.abs(b.width-innerWidth))[0].name;document.getElementById('reference').src=scenes[scene][viewport];</script></body></html>'''.replace('__SCENES__',json.dumps(mapping)).replace('__SIZES__',json.dumps(VIEWPORTS))).encode()
    confirmation = provenance['confirmation']
    manifest = {'schema_version':1,'kind':'frozen-native-sidebar-reference','mode':'high_fidelity',
        'revision':'poo178-adopted-native-r1',
        'files':{'prototype':'prototype.html',**{f'asset_{i}':name for i,name in enumerate(sorted(files)) if name!='prototype.html'}},
        'target':{'languages':['zh-Hans'],'themes':['light'],'viewports':[{'id':v['name'],'width':v['width'],'height':v['height']} for v in VIEWPORTS]},
        'scenes':[{'id':scene,'state':state,'title':scene,'source_entry':'prototype.html'} for scene,state in CASES],
        'design':{'skill_path':f'{PREFIX}/SKILL.md','sha256':shared.sha((SKILL/'SKILL.md').read_bytes()),
                  'sources':[{'path':SOURCE.relative_to(REPO).as_posix(),'sha256':shared.sha(SOURCE.read_bytes())}]},
        'confirmations':[{'id':confirmation['id'],'status':'confirmed','source':SOURCE.relative_to(REPO).as_posix()+'#confirmation','scope':confirmation['scope']}],
        'provenance':{'generator':f'{PREFIX}/tools/export-sidebar-reference.py','source_export_sha256':provenance['candidate']['bundle_sha256'],
          'source_baseline':provenance['candidate']['baseline'],'source_manifest':SOURCE.relative_to(REPO).as_posix(),
          'method':'Real archived native candidate rendered in Chromium, DOM/CSS frozen without product scripts; runtime imports current production AppShell.',
          'scope':'Previously adopted sidebar layout only, original typography. Fixed clock/seeded entropy stabilize the existing randomized input hint. POO-168 integration must recapture14px. Not product completion, Electron/backend proof, or same-state bug before/after.'}}
    files['prototype-manifest.json']=shared.encode(manifest)
    routes=[{'name':scene,'state':state,'actual':'/entries/baseline.html?route=allSessions/session/read-1','whole_page':True,'capture_full_page':True,
             'actual_steps':([] if state=='collapsed' else [{'action':'click','selector':'button:has-text("更多")'}]),
             'state_assertions':[{'type':'visible','selector':'button:has-text("更多")'}]+([] if state=='collapsed' else [{'type':'visible','selector':'[data-tutorial="sources-nav"]'}])} for scene,state in CASES]
    files['visual-plan.json']=shared.encode({'e2e':{'visual':{'mode':'smoke','viewports':VIEWPORTS,'routes':routes}}})
    files['runtime-manifest.json']=shared.encode({'services':{'frontend':{'url':'http://127.0.0.1:43178','cwd':f'{PREFIX}/tools/sidebar-runtime',
        'start':'../../../../../node_modules/.bin/vite --config vite.config.mjs --host 127.0.0.1 --port 43178 --strictPort','health_check':'/entries/baseline.html'}}})
    if evidence: (evidence/'capture-receipt.json').write_bytes(shared.encode({'cases':records,'browser_closed':True,'limits':manifest['provenance']['scope']}))
    return files


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--source-export',type=Path,required=True); parser.add_argument('--evidence',type=Path);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    files=expected_outputs(args.source_export,args.evidence)
    if args.check:
        stale=[name for name,data in files.items() if not(OUTPUT/name).is_file() or (OUTPUT/name).read_bytes()!=data]
        if stale: raise SystemExit('stale sidebar references: '+', '.join(stale))
    else:
        if (OUTPUT/'prototype-manifest.json').is_file():
            previous=json.loads((OUTPUT/'prototype-manifest.json').read_text())
            if previous['provenance']['generator']!=f'{PREFIX}/tools/export-sidebar-reference.py':raise ValueError('unowned output')
            for name in previous['files'].values():
                path=(OUTPUT/name).resolve()
                if not path.is_relative_to(OUTPUT.resolve()):raise ValueError('escaping generated path')
                if name not in files:path.unlink(missing_ok=True)
        for name,data in files.items():
            path=OUTPUT/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    print(f'2 adopted native states x 2 viewports; {len(files)} reference files current')

if __name__=='__main__':main()
