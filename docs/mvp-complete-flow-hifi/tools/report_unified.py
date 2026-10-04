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
if M['revision'] in ['poo70-cross-end-closure-r13','poo70-workbench-r14','poo70-workbench-r15','poo70-workbench-r15-nav-header','poo70-workbench-r15-classic-style','poo70-workbench-r15-ui-refinement','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['closure-browser']='closure-browser.json'
if M['revision'] in ['poo70-workbench-r14','poo70-workbench-r15','poo70-workbench-r15-nav-header','poo70-workbench-r15-classic-style','poo70-workbench-r15-ui-refinement','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['workbench-browser']='workbench-browser.json'
if M['revision'] in ['poo70-workbench-r15-nav-header','poo70-workbench-r15-classic-style','poo70-workbench-r15-ui-refinement','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['navigation-header']='navigation-header.json'
if M['revision'] in ['poo70-workbench-r15-classic-style','poo70-workbench-r15-ui-refinement','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['classic-style']='classic-style.json'
if M['revision'] in ['poo70-workbench-r15-ui-refinement','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['ui-refinement']='ui-refinement.json'
if M['revision']=='poo70-workbench-r15-circle-copy':files.update({'browser':'browser-quick.json','circle-copy':'circle-copy.json','copy-diff-proof':'copy-diff-proof.json'})
if M['revision'] in ['poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:files['copy-cleanup']='copy-cleanup.json'
if M['revision']=='poo70-workbench-r15-closure':files.update({'product-closure':'product-closure.json','mvp-operations':'mvp-operations.json','second-semantic':'second-semantic.json'})
evidence={key:{'path':str((E/name).relative_to(R)),'sha256':h(E/name)} for key,name in files.items()}
for key in ['structure','browser','invariants','review-continuity','semantic']+(['closure-browser'] if 'closure-browser' in files else [])+(['workbench-browser'] if 'workbench-browser' in files else [])+(['navigation-header'] if 'navigation-header' in files else [])+(['classic-style'] if 'classic-style' in files else [])+(['ui-refinement'] if 'ui-refinement' in files else [])+(['circle-copy'] if 'circle-copy' in files else [])+(['copy-cleanup'] if 'copy-cleanup' in files else [])+(['product-closure','mvp-operations','second-semantic'] if 'product-closure' in files else []):
 d=json.loads((E/files[key]).read_text())
 assert d.get('passed',d.get('status')=='passed'),f'{key} is not passed'
 observed=d['artifacts']
 if key in ['semantic','second-semantic'] and all(isinstance(v,dict) for v in observed.values()):observed={v['path']:v['sha256'] for v in observed.values()}
 assert observed==artifacts,f'{key} is stale'
s=json.loads((E/'semantic.json').read_text())
if 'second-semantic' in files:
 second=json.loads((E/'second-semantic.json').read_text());assert second['independence']['allowed_inputs_only'];assert second['reviewer_context']['agent'] not in ['/root',s['reviewer_context']['agent']];assert not [f for f in second.get('findings',[]) if f.get('status')!='resolved'];second_inputs={v['path']:v['sha256'] for v in second['inputs']} if isinstance(second['inputs'],list) else second['inputs'];assert all(h(R/p)==sha for p,sha in second_inputs.items()),'second semantic input stale'
reviewer=s['reviewer_context'].get('agent') if isinstance(s['reviewer_context'],dict) else s['reviewer_context']
assert reviewer and reviewer!='/root' and s['independence']['allowed_inputs_only']
inputs={v['path']:v['sha256'] for v in s['inputs']} if isinstance(s['inputs'],list) else s['inputs']
for p,sha in inputs.items():assert h(R/p)==sha,f'semantic input stale: {p}'
assert not [f for f in s.get('findings',[]) if f.get('status') not in ['resolved']], 'unresolved semantic finding'
r=json.loads((E/'reproducibility.json').read_text());assert r['passed']
for p,sha in r['second'].items():assert h(R/p)==sha, 'reproducibility stale'
browser=json.loads((E/files['browser']).read_text());invariants=json.loads((E/'invariants.json').read_text());review=json.loads((E/'review-continuity.json').read_text())
for source in M['sources']:artifacts[source['path']]=h(R/source['path'])
artifacts[M['design']['skill_path']]=h(R/M['design']['skill_path'])
for p in sorted((A/'src').rglob('*')):
 if p.is_file():artifacts[str(p.relative_to(R))]=h(p)
for p in [A/'prototype-manifest.json',B/'tools/build_review.py',B/'tools/review-shell.html',B/'tools/validate_unified.py',B/'tools/check_unified.py',B/'tools/check_invariants.py',B/'tools/check_review_continuity.py',A/'tools/export-single-file.mjs']:artifacts[str(p.relative_to(R))]=h(p)
q={'schema_version':1,'contract':'polo-unified-surfaces-v1','revision':M['revision'],'status':'passed','scope':os.environ.get('POLO_REVIEW_SCOPE','R12 assistant MVP and unified routing. Chinese light, declared viewports, offline file and local HTTP.'),'artifacts':artifacts,'evidence':evidence,'checks':{key:{'status':'passed','evidence':keys} for key,keys in [('structure',['structure']),('browser',['browser','invariants','review-continuity']),('semantic',['semantic']),('reproducibility',['reproducibility'])]},'observed':{'mvp_scenes':sum(s['surface']=='mvp' for s in M['scenes']),'assistant_scenes':sum(s['surface']=='assistant' for s in M['scenes']),'compatibility_links':len(M['aliases']),'scene_viewport_protocol_observations':len(browser['scenes']),'assistant_action_observations':len(browser['actions']),'disabled_action_observations':sum('observation' in a for a in browser['actions']),'invariants':len(invariants['checks']),'review_continuity_checks':len(review['checks']),'page_errors':browser['errors'],'external_requests':browser['requests']},'limitations':['Upstream single-surface v3 validator rejects surfaces/aliases extension; its actual failure is retained. This is a repository-specific multi-surface report, not an upstream clearance.','Prototype closure covers confirmed PRD and interaction scope. Existing chat UI remains Renderer-owned. No real Electron, API, payment, AI generation or installation was executed; this is not production Acceptance.','Other themes/languages and auxiliary reference=1 scenes remain available but outside this acceptance scope.']}
if 'closure-browser' in files:
 q['checks']['browser']['evidence'].append('closure-browser')
 c=json.loads((E/'closure-browser.json').read_text());q['observed']['closure_actions']=len(c['actions']);q['observed']['closure_checks']=len(c['checks']);q['observed']['unexercised_inherited_controls']=len(c.get('unexercised_inherited_controls',[]))
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_closure.py']=h(B/'tools/check_closure.py')
 q['limitations'].extend(['No real support QR asset was supplied; only unconfigured/load-failed states and copy fallback were reviewed.','Payment fee/settlement ownership remains with POL-116; this prototype does not decide or validate the settlement formula.'])
if 'workbench-browser' in files:
 q['checks']['browser']['evidence'].append('workbench-browser')
 w=json.loads((E/'workbench-browser.json').read_text());q['observed']['workbench_checks']=len(w['checks'])
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_workbench.py']=h(B/'tools/check_workbench.py')
 q['limitations'].extend(w.get('limitations',[]))
if 'navigation-header' in files:
 q['checks']['browser']['evidence'].append('navigation-header')
 n=json.loads((E/'navigation-header.json').read_text());q['observed']['navigation_header_checks']=len(n['checks'])
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_navigation_header.py']=h(B/'tools/check_navigation_header.py')
 q['limitations'].extend(n.get('limitations',[]))
if 'classic-style' in files:
 q['checks']['browser']['evidence'].append('classic-style')
 c=json.loads((E/'classic-style.json').read_text());q['observed']['classic_style_checks']=len(c['checks'])
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_classic_style.py']=h(B/'tools/check_classic_style.py')
 q['limitations'].extend(c.get('limitations',[]))
if 'ui-refinement' in files:
 q['checks']['browser']['evidence'].append('ui-refinement')
 u=json.loads((E/'ui-refinement.json').read_text());q['observed']['ui_refinement_checks']=len(u['checks'])
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_ui_refinement.py']=h(B/'tools/check_ui_refinement.py')
 q['limitations'].extend(u.get('limitations',[]))
if 'copy-cleanup' in files:
 c=json.loads((E/'copy-cleanup.json').read_text())
 q['checks']['browser']['evidence'].append('copy-cleanup')
 q['observed']['copy_cleanup_checks']=len(c['checks'])
 q['artifacts']['docs/mvp-complete-flow-hifi/tools/check_copy_cleanup.py']=h(B/'tools/check_copy_cleanup.py')
if 'product-closure' in files:
 c=json.loads((E/'product-closure.json').read_text());q['checks']['browser']['evidence'].append('product-closure');q['observed']['product_closure_checks']=len(c['checks']);q['artifacts'][str((B/'tools/check_product_closure.py').relative_to(R))]=h(B/'tools/check_product_closure.py')
if 'mvp-operations' in files:
 c=json.loads((E/'mvp-operations.json').read_text());q['checks']['browser']['evidence'].append('mvp-operations');q['observed']['mvp_operations']={k:sum(a.get('status')==k for a in c['actions']) for k in ['passed','occluded']};q['artifacts'][str((B/'tools/check_mvp_operations.py').relative_to(R))]=h(B/'tools/check_mvp_operations.py');q['checks']['semantic']['evidence'].append('second-semantic')
if 'circle-copy' in files:
 c=json.loads((E/'circle-copy.json').read_text());proof=json.loads((E/'copy-diff-proof.json').read_text())
 assert all(proof[k] for k in ['passed','assistant_unchanged','transitions_unchanged','stories_unchanged'])
 q['checks']['browser']['evidence'].append('circle-copy')
 q['checks']['copy-scope']={'status':'passed','evidence':['copy-diff-proof']}
 q['observed']['circle_copy_checks']=len(c['checks'])
 q['observed']['circle_scene_viewport_protocol_observations']=len(c['scenes'])
 q['limitations'].append('Copy-only revision: quick shared-surface regression plus both affected lists at all three viewports/file/HTTP; previous full action suite was not rerun. Exact diff proves scripts/styles/operations and assistant surface unchanged; old results are historical, not re-stamped.')
if (E/'documentation-equivalence.json').exists():
 proof=E/'documentation-equivalence.json';assert json.loads(proof.read_text())['passed']
 q['evidence']['documentation-equivalence']={'path':str(proof.relative_to(R)),'sha256':h(proof)}
 q['checks']['documentation']={'status':'passed','evidence':['documentation-equivalence']}
 for path in ['sources/document-history-20261002.json','sources/document-history-20261002.tar.gz']:
  q['artifacts'][str((B/path).relative_to(R))]=h(B/path)
(B/'quality-report.json').write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':q['status'],**q['observed']},ensure_ascii=False))
