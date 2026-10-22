#!/usr/bin/env python3
"""Compare actual computed styles against immutable b82fa1e5 artifacts."""
import hashlib,json,os,re,subprocess,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[3];B=R/'docs/mvp-complete-flow-hifi';A=R/'design-demos/polo-client-source-baseline';E=B/os.environ.get('POLO_REVIEW_EVIDENCE','evidence/r15-classic-style');E.mkdir(parents=True,exist_ok=True)
M=json.loads((B/'prototype-manifest.json').read_text());paths=['docs/mvp-complete-flow-hifi/prototype.html','design-demos/polo-client-source-baseline/prototype.html']
old={path:subprocess.check_output(['git','show','b82fa1e5:'+path]) for path in paths}
props=['color','backgroundColor','borderTopColor','borderTopWidth','borderRadius','boxShadow','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft']
cases=[('home','P-M03-HOME-PERSONAL',0,[('heading','.home-hero h1',props),('card','.product-card',props),('art','.app-art',props+['width','height']),('card-title','.card-title h3',props),('source','.source-line',props),('open','.card-action.primary',props)]),('circles','P-M07-LIST',0,[('card','.circle-card',props),('avatar','.circle-avatar',props)]),('settings','P-M10-SETTINGS',0,[('selected-category','.settings-nav-card button.active',props)]),('switch','P-M02-CONFIRM',0,[('dialog','.dialog',props)]),('assistant','A-personal-new',1,[('composer','.mvp-composer',props),('input','.mvp-composer textarea',props),('navigator','.source-navigator',props)])]
# Spec 13.11 intentionally redesigns circle rows and unifies the assistant canvas.
# Keep immutable b82 comparisons for unaffected components; dedicated refinement checks
# verify circle consistency and the new cross-surface canvas, not false baseline equality.
if M['revision'] in ['poo70-workbench-r15-ui-refinement','poo70-workbench-r15-circle-copy','poo70-workbench-r15-copy-cleanup','poo70-workbench-r15-closure']:
 cases=[c for c in cases if c[0]!='circles']
 cases=[(label,sid,index,[(name,selector,[p for p in keys if not(label=='assistant' and p=='backgroundColor')]) for name,selector,keys in samples]) for label,sid,index,samples in cases]
report={'revision':M['revision'],'baseline_commit':subprocess.check_output(['git','rev-parse','b82fa1e5'],text=True).strip(),'baseline_artifacts':{p:hashlib.sha256(v).hexdigest() for p,v in old.items()},'artifacts':{str(p.relative_to(R)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [B/'prototype-manifest.json',B/'prototype.html',B/'review.html',A/'prototype.html']},'checks':[],'errors':[],'limitations':['Computed-style parity covers named components; changed content, newer features, entry placement and scroll divider behavior intentionally differ from b82fa1e5. Not whole-page pixel equality or product Acceptance.']}
def check(name,ok,detail=None):
 report['checks'].append({'name':name,'passed':bool(ok),'detail':detail})
 if not ok:print('FAIL',name,json.dumps(detail,ensure_ascii=False),flush=True)
old_css=re.search(rb'<style>([\s\S]*?)</style>',old[paths[0]])[1];current_css=re.search(rb'<style>([\s\S]*?)</style>',(R/paths[0]).read_bytes())[1]
check('MVP foundational CSS exactly equals b82fa1e5',old_css==current_css)
with tempfile.TemporaryDirectory(prefix='polo-classic-reference-') as temp, sync_playwright() as p:
 root=Path(temp)
 for path,data in old.items():
  target=root/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 browser=p.chromium.launch()
 for vp in M['target']['viewports']:
  before=browser.new_page(viewport={k:vp[k] for k in ['width','height']});after=browser.new_page(viewport={k:vp[k] for k in ['width','height']})
  after.on('pageerror',lambda e:report['errors'].append(str(e)))
  for label,sid,owner,samples in cases:
   before.goto((root/paths[owner]).as_uri()+'?scene='+sid);after.goto((R/paths[owner]).as_uri()+'?scene='+sid)
   before.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid);after.wait_for_function('(s)=>document.body.dataset.currentScene===s',arg=sid)
   before.wait_for_timeout(40);after.wait_for_timeout(40)
   for name,selector,keys in samples:
    source=before.locator('[data-prototype-scene]:visible').locator(selector).first;current=after.locator('[data-prototype-scene]:visible').locator(selector).first
    if not source.count() or not current.count():
     check(vp['id']+' '+label+' '+name,False,{'source_count':source.count(),'current_count':current.count()});continue
    get='(e,keys)=>{const s=getComputedStyle(e);return Object.fromEntries(keys.map(k=>[k,s[k]]))}'
    a=source.evaluate(get,keys);b=current.evaluate(get,keys);delta={k:{'baseline':a[k],'current':b[k]} for k in keys if a[k]!=b[k]}
    check(vp['id']+' '+label+' '+name,not delta,delta)
   before.screenshot(path=str(E/('baseline-'+label+'-'+vp['id']+'.png')));after.screenshot(path=str(E/('classic-'+label+'-'+vp['id']+'.png')))
  before.close();after.close()
 browser.close()
report['passed']=all(c['passed'] for c in report['checks']) and not report['errors'];(E/'classic-style.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':report['passed'],'checks':len(report['checks']),'errors':report['errors']}));raise SystemExit(0 if report['passed'] else 1)
