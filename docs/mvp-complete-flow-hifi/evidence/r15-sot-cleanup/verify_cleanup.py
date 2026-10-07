"""Verify archived document relocation and refresh only documentation bindings.
Run from repository root after build_review.py and validate_unified.py.
No historical browser/semantic evidence is rewritten or re-stamped.
"""
from pathlib import Path
import copy,hashlib,json,tarfile
R=Path.cwd();B=R/'docs/mvp-complete-flow-hifi';E=Path(__file__).resolve().parent
h=lambda raw:hashlib.sha256(raw).hexdigest()
archive=B/'sources/document-history-20261003.tar.gz';index=B/'sources/document-history-20261003.json';catalog=json.loads(index.read_text());assert h(archive.read_bytes())==catalog['archive_sha256']
with tarfile.open(archive) as a:old={m.name:a.extractfile(m).read() for m in a if m.isfile()}
removed={e['path'] for e in catalog['entries'] if e['removed_from_active_tree']}
for e in catalog['entries']:
 assert h(old[e['path']])==e['sha256'],e['path']
 if e['removed_from_active_tree']:assert not (R/e['path']).exists(),e['path']
manifest='docs/mvp-complete-flow-hifi/prototype-manifest.json';spec='docs/client-journey-review/spec.md';quality='docs/mvp-complete-flow-hifi/quality-report.json';validator='docs/mvp-complete-flow-hifi/tools/validate_unified.py'
previous=json.loads(old[manifest]);current=json.loads((R/manifest).read_bytes());prior=json.loads(old[quality]);normalized=copy.deepcopy(current);moved=[]
for before,after in zip(previous['sources'],normalized['sources'],strict=True):
 if before!=after:
  if before['path']==spec:
   assert set(k for k in before if before[k]!=after[k])<={'revision','sha256'}
   assert after['sha256']==h((R/spec).read_bytes())
  else:
   assert before['path'] in removed
   assert after['path']==str(archive.relative_to(R)) and after['sha256']==h(archive.read_bytes())
   assert after['archive_member']==before['path'] and after['archive_member_sha256']==before['sha256']==h(old[before['path']])
   assert after['id']==before['id'] and after['revision']==before['revision']
   moved.append(before['id'])
  after.clear();after.update(before)
assert normalized==previous
encoded=lambda m:json.dumps(m,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
checks={'all_archive_members_byte_verified':True,'removed_files_absent':True,'manifest_only_document_source_bindings_changed':True}
changed={spec,manifest,validator}
for path in ['docs/mvp-complete-flow-hifi/prototype.html','docs/mvp-complete-flow-hifi/review.html']:
 before=old[path].decode();after=(R/path).read_text();a,b=encoded(previous),encoded(current)
 assert before.count(a)==after.count(b)==1
 assert before.replace(a,'__BOUND_MANIFEST__')==after.replace(b,'__BOUND_MANIFEST__'),path
 checks[path+'_outside_manifest_byte_identical']=True;changed.add(path)
# The validator gains only archive-member verification; every prior check stays.
before=old[validator].decode();after=(R/validator).read_text();expected=before.replace('import argparse,hashlib,json,re,subprocess','import argparse,hashlib,json,re,subprocess,tarfile').replace("for source in M['sources']:check('source '+source['id'],digest(R/source['path'])==source['sha256'])", "for source in M['sources']:\n check('source '+source['id'],digest(R/source['path'])==source['sha256'])\n if 'archive_member' in source:\n  with tarfile.open(R/source['path']) as archive:\n   member=archive.extractfile(source['archive_member'])\n   check('archived source '+source['id'],member is not None and hashlib.sha256(member.read()).hexdigest()==source['archive_member_sha256'])")
assert after==expected
checks['validator_only_adds_archive_member_verification']=True
for path,sha in prior['artifacts'].items():
 if path in removed:assert h(old[path])==sha
 elif path not in changed:assert h((R/path).read_bytes())==sha,path
checks['all_other_bound_runtime_sources_unchanged']=True
for key,ev in prior['evidence'].items():assert h((R/ev['path']).read_bytes())==ev['sha256'],key
checks['prior_raw_evidence_unchanged']=True
structure=json.loads((E/'structure.json').read_text());assert structure['passed']
proof={'passed':True,'scope':'Single product SoT cleanup; byte-preserved history relocation and source bindings, no new browser/semantic acceptance','archive':str(archive.relative_to(R)),'archive_sha256':h(archive.read_bytes()),'index':str(index.relative_to(R)),'prior_quality_sha256':h(old[quality]),'archived_member_count':len(catalog['entries']),'removed_file_count':len(removed),'rebound_sources':moved,'checks':checks,'preserved_scene_count':len(current['scenes']),'preserved_alias_count':len(current['aliases'])}
p=E/'documentation-equivalence.json';p.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
q=copy.deepcopy(prior);q['scope']='Single product SoT cleanup master-r15-sot-cleanup. Current archive/structure/reproducibility checks; original browser/semantic evidence inherited via exact product equivalence, not rerun.'
q['observed']={'archived_file_count':len(removed),'documentation_equivalence_checks':len(checks),'current_structure_checks':len(structure['checks'])}
q['artifacts']={path:sha for path,sha in q['artifacts'].items() if path not in removed}
for path in changed:q['artifacts'][path]=h((R/path).read_bytes())
for p in [archive,index,Path(__file__).resolve(),R/'design-demos/polo-client-source-baseline/README.md']:q['artifacts'][str(p.relative_to(R))]=h(p.read_bytes())
for key in ['structure','documentation-equivalence','reproducibility']:
 if key in q['evidence']:q['evidence']['before-cleanup-'+key]=q['evidence'][key]
 p=E/(key+'.json');q['evidence'][key]={'path':str(p.relative_to(R)),'sha256':h(p.read_bytes())}
q['evidence']['history-archive']={'path':str(archive.relative_to(R)),'sha256':h(archive.read_bytes())}
q['checks']['documentation']={'status':'passed','evidence':['documentation-equivalence','history-archive']}
for name,check in q['checks'].items():
 if name not in ['structure','reproducibility','documentation']:
  check['verification']='inherited_from_exact_product_equivalence'
  if 'documentation-equivalence' not in check['evidence']:check['evidence'].append('documentation-equivalence')
q['limitations'].append('Relocated historical input paths resolve inside document-history-20261003.tar.gz using its index. The archive preserves source hashes; frozen earlier reports remain version-specific, not current acceptance.')
(R/quality).write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':True,'removed_files':len(removed),'checks':checks},ensure_ascii=False))
