"""Reproduce a documentation-only binding refresh without re-stamping browser evidence.
Run from the repository root after build_review.py and validate_unified.py.
The archive is the exact pre-edit input; this script refuses product/source drift.
"""
from pathlib import Path
import copy,hashlib,json,tarfile
R=Path.cwd();B=R/'docs/mvp-complete-flow-hifi';E=Path(__file__).resolve().parent
h=lambda data:hashlib.sha256(data).hexdigest()
archive=E/'before-document-sync.tar.gz'
with tarfile.open(archive) as a:old={m.name:a.extractfile(m).read() for m in a if m.isfile()}
manifest='docs/mvp-complete-flow-hifi/prototype-manifest.json';spec='docs/client-journey-review/spec.md';quality='docs/mvp-complete-flow-hifi/quality-report.json'
previous=json.loads(old[manifest]);current=json.loads((R/manifest).read_bytes());prior=json.loads(old[quality]);normalized=copy.deepcopy(current)
source_changes=[]
for before,after in zip(previous['sources'],normalized['sources'],strict=True):
 if before!=after:
  assert before['path']==after['path']==spec
  assert set(k for k in before if before[k]!=after[k])<={'revision','sha256'}
  source_changes.append({'path':spec,'before':before,'after':copy.deepcopy(after)})
  after.update(before)
assert len(source_changes)==1 and normalized==previous
assert source_changes[0]['after']['sha256']==h((R/spec).read_bytes())
encoded=lambda m:json.dumps(m,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
checks={'manifest_only_spec_binding_changed':True}
changed={spec,manifest}
for path in ['docs/mvp-complete-flow-hifi/prototype.html','docs/mvp-complete-flow-hifi/review.html']:
 before=old[path].decode();after=(R/path).read_text();a,b=encoded(previous),encoded(current)
 assert before.count(a)==after.count(b)==1,path
 assert before.replace(a,'__BOUND_MANIFEST__')==after.replace(b,'__BOUND_MANIFEST__'),path
 checks[path+'_outside_manifest_byte_identical']=True;changed.add(path)
for path,sha in prior['artifacts'].items():
 if path not in changed:assert h((R/path).read_bytes())==sha,path
checks['all_other_bound_sources_and_assistant_unchanged']=True
for key,ev in prior['evidence'].items():assert h((R/ev['path']).read_bytes())==ev['sha256'],key
checks['prior_raw_evidence_unchanged']=True
structure=json.loads((E/'structure.json').read_text());assert structure['passed']
proof={'passed':True,'scope':'PRD consolidation and source binding only; no new browser or independent semantic acceptance','before_archive':str(archive.relative_to(R)),'before_archive_sha256':h(archive.read_bytes()),'prior_quality_sha256':h(old[quality]),'source_changes':source_changes,'checks':checks,'preserved_scene_count':len(current['scenes']),'preserved_alias_count':len(current['aliases'])}
proof_path=E/'documentation-equivalence.json';proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
q=copy.deepcopy(prior)
q['scope']='PRD sync master-r15-prd-sync. Current structure/reproducibility and exact source-only equivalence; browser/semantic checks inherited from r15-copy-cleanup, not rerun or re-stamped.'
q['inherited_observed']=q.pop('observed');q['observed']={'documentation_equivalence_checks':len(checks),'current_structure_checks':len(structure['checks'])}
for path in changed:q['artifacts'][path]=h((R/path).read_bytes())
q['evidence']['prior-structure']=q['evidence']['structure']
for key,name in [('structure','structure.json'),('documentation-equivalence','documentation-equivalence.json'),('reproducibility','reproducibility.json')]:
 p=E/name;q['evidence'][key]={'path':str(p.relative_to(R)),'sha256':h(p.read_bytes())}
q['evidence']['documentation-before']={'path':str(archive.relative_to(R)),'sha256':h(archive.read_bytes())}
q['artifacts'][str(Path(__file__).resolve().relative_to(R))]=h(Path(__file__).read_bytes())
for name,check in q['checks'].items():
 if name not in ['structure','reproducibility']:
  check['verification']='inherited_from_exact_product_equivalence';check['evidence'].append('documentation-equivalence')
q['checks']['documentation']={'status':'passed','evidence':['documentation-equivalence','documentation-before']}
q['limitations'].append('This refresh reviews no new runtime behavior. Prior semantic/browser input snapshots retain their original hashes and scope; the archive and equivalence proof bridge only the PRD binding update.')
(R/quality).write_text(json.dumps(q,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':True,'checks':checks},ensure_ascii=False))
