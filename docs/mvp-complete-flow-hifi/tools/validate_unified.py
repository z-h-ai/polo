#!/usr/bin/env python3
"""Validate the user-approved two-surface extension without weakening global skill.
The upstream v3 validator requires one static surface and rejects extra fields;
this local contract checks actual ownership, source exports and browser evidence.
"""
import argparse,hashlib,json,re,subprocess,tarfile
from html.parser import HTMLParser
from pathlib import Path
import os
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline'
parser=argparse.ArgumentParser();parser.add_argument('--quality-report',type=Path);args=parser.parse_args()
M=json.loads((B/'prototype-manifest.json').read_text());errors=[];checks=[]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def check(name,condition):
 checks.append({'check':name,'passed':bool(condition)})
 if not condition:errors.append(name)
def embedded(p):
 text=p.read_text();return json.loads(re.search(r'<script[^>]+id="prototype-manifest"[^>]*>(.*?)</script>',text,re.S)[1])
exported=json.loads(subprocess.check_output(['node','--input-type=module','-e',f"import {{scenes,aliases}} from {json.dumps((A/'src/mvp/scenes.mjs').as_uri())};console.log(JSON.stringify({{scenes,aliases}}))"],text=True))
ids={s['id'] for s in M['scenes']};byid={s['id']:s for s in M['scenes']};edges=[t for s in M['scenes'] for t in s['transitions']]
check('unique scenes',len(ids)==len(M['scenes']));check('unique transitions',len({t['id'] for t in edges})==len(edges));check('known transition destinations',all(t['to'] in ids for t in edges));check('source exported assistant scenes exact',[s for s in M['scenes'] if s['surface']=='assistant']==exported['scenes']);check('source exported compatibility exact',M['aliases']==exported['aliases']);check('aliases point to active assistant',all(t in ids and byid[t]['surface']=='assistant' for t in M['aliases'].values()))
check('embedded review matches manifest',embedded(B/'review.html')==M);check('embedded mvp matches manifest',embedded(B/'prototype.html')==M)
for source in M['sources']:
 check('source '+source['id'],digest(R/source['path'])==source['sha256'])
 if 'archive_member' in source:
  with tarfile.open(R/source['path']) as archive:
   member=archive.extractfile(source['archive_member'])
   check('archived source '+source['id'],member is not None and hashlib.sha256(member.read()).hexdigest()==source['archive_member_sha256'])
check('design skill binding',digest(R/M['design']['skill_path'])==M['design']['sha256'])
for source in M['design']['sources']:check('design '+source['path'],digest(R/source['path'])==source['sha256'])
class Inventory(HTMLParser):
 def __init__(self):super().__init__();self.scenes=[];self.transitions=[];self.urls=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if 'data-prototype-scene' in a:self.scenes.append(a['data-prototype-scene'])
  if 'data-transition' in a:self.transitions.append(a['data-transition'])
  if tag in ['script','link','img','iframe']:
   for k in ['src','href']:
    if a.get(k,'').startswith(('http:','https:','//')):self.urls.append(a[k])
i=Inventory();i.feed((B/'prototype.html').read_text());check('MVP contains only its owned scenes',set(i.scenes)=={s['id'] for s in M['scenes'] if s['surface']=='mvp'});check('no remote MVP assets',not i.urls);check('MVP scene DOM identity unique',len(i.scenes)==len(set(i.scenes)));check('MVP control DOM identity unique',len(i.transitions)==len(set(i.transitions)));check('MVP controls match owned manifest',set(i.transitions)=={t['id'] for s in M['scenes'] if s['surface']=='mvp' for t in s['transitions']})
for name,p in [('review',B/'review.html'),('assistant',A/'prototype.html')]:
 i=Inventory();i.feed(p.read_text());check('no remote '+name+' assets',not i.urls)
for owner,url in M['surfaces'].items():check('local surface '+owner,(B/url).resolve().is_file())
for story in M['stories']:
 check('story destinations '+story['id'],all(step['scene'] in ids for step in story['steps']))
 for i,step in enumerate(story['steps']):
  if i:check('story arrival '+step['id'],step.get('arrival')=='review' or any(t['to']==step['scene'] for t in byid[story['steps'][i-1]['scene']]['transitions']))
check('review arrivals declared',all(step['scene'] in {e['scene'] for e in M['review_entries']} for st in M['stories'] for step in st['steps'] if step.get('arrival')=='review'))
if args.quality_report:
 q=json.loads(args.quality_report.read_text())
 check('quality revision',q['revision']==M['revision'])
 for path,sha in q['artifacts'].items():check('quality artifact '+path,digest(R/path)==sha)
 for name,ev in q['evidence'].items():check('quality evidence '+name,digest(R/ev['path'])==ev['sha256'])
 check('required quality results',all(q['checks'].get(k,{}).get('status')=='passed' for k in ['structure','browser','semantic','reproducibility']))
report={'contract':'polo-unified-surfaces-v1','revision':M['revision'],'passed':not errors,'checks':checks,'errors':errors,'artifacts':{str(p.relative_to(R)):digest(p) for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']}}
if not args.quality_report:
 out=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r12')/'structure.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':not errors,'checks':len(checks),'errors':errors},ensure_ascii=False));raise SystemExit(0 if not errors else 1)
