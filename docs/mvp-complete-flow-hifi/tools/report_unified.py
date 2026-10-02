#!/usr/bin/env python3
"""Bind real r12 check outputs. Refuses stale, missing or failed evidence."""
import hashlib,json
from pathlib import Path
import os
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r12');A=R/'design-demos/polo-client-source-baseline'
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
M=json.loads((B/'prototype-manifest.json').read_text())
artifacts={str(p.relative_to(R)):h(p) for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']}
files={'structure':'structure.json','browser':'browser.json','invariants':'invariants.json','review-continuity':'review-continuity.json','semantic':'semantic.json','reproducibility':'reproducibility.json','upstream-validator':'upstream-validator.json'}
if M['revision']=='poo70-cross-end-closure-r13':files['closure-browser']='closure-browser.json'
evidence={key:{'path':str((E/name).relative_to(R)),'sha256':h(E/name)} for key,name in files.items()}
for key in ['structure','browser','invariants','review-continuity','semantic']+(['closure-browser'] if 'closure-browser' in files else []):
 d=json.loads((E/files[key]).read_text())
 assert d.get('passed',d.get('status')=='passed'),f'{key} is not passed'
 observed=d['artifacts']
 if key=='semantic' and all(isinstance(v,dict) for v in observed.values()):observed={v['path']:v['sha256'] for v in observed.values()}
 assert observed==artifacts,f'{key} is stale'
s=json.loads((E/'semantic.json').read_text())
reviewer=s['reviewer_context'].get('agent') if isinstance(s['reviewer_context'],dict) else s['reviewer_context']
assert reviewer and reviewer!='/root' and s['independence']['allowed_inputs_only']
inputs={v['path']:v['sha256'] for v in s['inputs']} if isinstance(s['inputs'],list) else s['inputs']
for p,sha in inputs.items():assert h(R/p)==sha,f'semantic input stale: {p}'
assert not [f for f in s.get('findings',[]) if f.get('status') not in ['resolved']], 'unresolved semantic finding'
r=json.loads((E/'reproducibility.json').read_text());assert r['passed']
for p,sha in r['second'].items():assert h(R/p)==sha, 'reproducibility stale'
browser=json.loads((E/'browser.json').read_text());invariants=json.loads((E/'invariants.json').read_text());review=json.loads((E/'review-continuity.json').read_text())
for source in M['sources']:artifacts[source['path']]=h(R/source['path'])
artifacts[M['design']['skill_path']]=h(R/M['design']['skill_path'])
for p in sorted((A/'src').rglob('*')):
 if p.is_file():artifacts[str(p.relative_to(R))]=h(p)
for p in [A/'prototype-manifest.json',B/'tools/build_review.py',B/'tools/review-shell.html',B/'tools/validate_unified.py',B/'tools/check_unified.py',B/'tools/check_invariants.py',B/'tools/check_review_continuity.py',A/'tools/export-single-file.mjs']:artifacts[str(p.relative_to(R))]=h(p)
q={'schema_version':1,'contract':'polo-unified-surfaces-v1','revision':M['revision'],'status':'passed','scope':os.environ.get('POLO_REVIEW_SCOPE','R12 assistant MVP and unified routing. Chinese light, declared viewports, offline file and local HTTP.'),'artifacts':artifacts,'evidence':evidence,'checks':{key:{'status':'passed','evidence':keys} for key,keys in [('structure',['structure']),('browser',['browser','invariants','review-continuity']),('semantic',['semantic']),('reproducibility',['reproducibility'])]},'observed':{'mvp_scenes':sum(s['surface']=='mvp' for s in M['scenes']),'assistant_scenes':sum(s['surface']=='assistant' for s in M['scenes']),'compatibility_links':len(M['aliases']),'scene_viewport_protocol_observations':len(browser['scenes']),'assistant_action_observations':len(browser['actions']),'disabled_action_observations':sum('observation' in a for a in browser['actions']),'invariants':len(invariants['checks']),'review_continuity_checks':len(review['checks']),'page_errors':browser['errors'],'external_requests':browser['requests']},'limitations':['Upstream single-surface v3 validator rejects surfaces/aliases extension; its actual failure is retained. This is a repository-specific multi-surface report, not an upstream clearance.','New layout/visual design remains pending user review. No real Electron, API, payment, AI generation or installation was executed.','Other themes/languages and auxiliary reference=1 scenes remain available but outside this acceptance scope.']}
if 'closure-browser' in files:
 q['checks']['browser']['evidence'].append('closure-browser')
 c=json.loads((E/'closure-browser.json').read_text());q['observed']['closure_actions']=len(c['actions']);q['observed']['closure_checks']=len(c['checks']);q['observed']['unexercised_inherited_controls']=len(c.get('unexercised_inherited_controls',[]))
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_closure.py']=h(B/'tools/check_closure.py')
 q['limitations'].extend(['No real support QR asset was supplied; only unconfigured/load-failed states and copy fallback were reviewed.','Payment fee/settlement ownership remains with POL-116; this prototype does not decide or validate the settlement formula.'])
(B/'quality-report.json').write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':q['status'],**q['observed']},ensure_ascii=False))
