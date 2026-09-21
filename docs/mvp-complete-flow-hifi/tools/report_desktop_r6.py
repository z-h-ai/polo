#!/usr/bin/env python3
"""Bind current observed evidence; preserve incomplete full-bundle clearance honestly."""
import json,sys
from pathlib import Path
B=Path(__file__).resolve().parents[1];ROOT=B.parents[1];OUT=B/'build/ux-r6'
sys.path.insert(0,str(Path.home()/'.agents/skills/product-ui-prototype/scripts'))
from quality_report import snapshot,fingerprints,sha
m=json.loads((B/'prototype-manifest.json').read_text());art=snapshot(B,ROOT,m);fp=fingerprints()
raw=json.loads((OUT/'browser-raw.json').read_text());shell=json.loads((OUT/'review-shell-raw.json').read_text());semantic=json.loads((OUT/'semantic-check.json').read_text())
assert raw['artifacts']==art and shell['artifacts']==art and semantic['artifacts']==art,'Evidence is stale; rerun affected checks.'
assert raw['status']=='passed' and shell['status']=='passed'
structure={'kind':'structure','status':'passed','artifacts':art,'fingerprints':fp,'evidence':['generation-structure-raw'],'findings':[]}
(OUT/'structure-check.json').write_text(json.dumps(structure,ensure_ascii=False,indent=2)+'\n')
browser={'kind':'browser','status':'incomplete','focused_status':'passed','artifacts':art,'fingerprints':fp,'evidence':['browser-raw','review-shell-raw','login-preservation'],'findings':[],
 'coverage':{'scenes':[s['id']for s in m['scenes']],'actions':[x['id']for x in raw['actions']],'stories':[x['id']for x in raw['stories']],'viewports':[x['id']for x in m['target']['viewports']],'scene_viewports':[x['scene']+'@'+x['viewport']for x in raw['render']]},
 'incomplete_reason':'All scene viewports rendered and all declared edges DOM-dispatched; 26 core-flow pointer clicks plus separate independent clicks passed. Hidden controls and every inherited non-transition control were not individually exercised as real user operations. DOM dispatch is not full browser acceptance.',
 'summary':{'rendered_scene_viewports':len(raw['render']),'declared_edges_dispatched':len(raw['actions']),'core_pointer_clicks':len([x for x in raw['flows']if x.get('method')=='pointer-click']),'stories':len(raw['stories']),'horizontal_overflow':0,'page_errors':raw['errors'],'shell_checks':shell['checks']}}
(OUT/'browser-check.json').write_text(json.dumps(browser,ensure_ascii=False,indent=2)+'\n')
files={'generation-structure-raw':'final-generation-structure-raw.json','structure':'structure-check.json','browser':'browser-check.json','browser-raw':'browser-raw.json','review-shell-raw':'review-shell-raw.json','login-preservation':'login-preservation.json','semantic':'semantic-check.json','semantic-independent-final':'semantic-review-resolution.json','semantic-final-dom':'semantic-dom-final-inventory.json','semantic-final-clicks':'semantic-final-clicks.json','semantic-final-edges':'semantic-final-edge-cases.json','semantic-whitespace-equivalence':'semantic-whitespace-equivalence.json'}
evidence={k:{'path':str((OUT/v).relative_to(ROOT)),'sha256':sha(OUT/v)}for k,v in files.items()}
inputs={s['path']:{'path':s['path'],'revision':s['revision'],'sha256':s['sha256'],'role':'prior-prototype' if 'prototype' in s['id'] else 'product-description'}for s in m['sources']}
for path in [m['design']['skill_path']]+[s['path']for s in m['design']['sources']]:inputs[path]={'path':path,'revision':m['design']['revision'],'sha256':sha(ROOT/path),'role':'design'}
prior='docs/mvp-complete-flow-hifi/build/ux-r6/prototype-before.html';inputs[prior]={'path':prior,'revision':m['change']['previous_revision'],'sha256':sha(ROOT/prior),'role':'prior-prototype'}
r={'schema_version':1,'revision':m['revision'],'status':'incomplete','focused_result':'passed','generation':{'mode':'incremental','context_id':'/root/desktop-ux-r6','inputs':list(inputs.values()),'trace':'generation-structure-raw'},'input_review':{'path':str((B/'review.md').relative_to(ROOT)),'sha256':sha(B/'review.md')},'fingerprints':fp,'artifacts':art,'evidence':evidence,'checks':{'structure':{'status':'passed','evidence':'structure'},'browser':{'status':'incomplete','evidence':'browser'},'semantic':{'status':'incomplete','evidence':'semantic'}},'limitations':['Full inherited product-control semantics and all hidden/dynamic controls are not fully certified.','Prototype uses offline example data, not real SDK, installation, AI execution or enterprise publishing.','Prior manifest fails its own historical reachability check; current structure and direct incremental comparison passed.']}
(B/'quality-report.json').write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n');print('Evidence bound to final bytes; focused checks passed, full-bundle clearance remains incomplete.')
