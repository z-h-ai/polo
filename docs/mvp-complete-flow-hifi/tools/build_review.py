#!/usr/bin/env python3
"""Current r12 entry: assistant source export -> unified manifest -> two surfaces.
MVP HTML remains the maintained non-assistant product source. Review source is
review-shell.html; never invoke pre-r12 reconstruction scripts for current output.
"""
import hashlib,json,re,subprocess,tarfile
from pathlib import Path
BUNDLE=Path(__file__).resolve().parents[1]
ROOT=BUNDLE.parents[1]
ASSISTANT=ROOT/'design-demos/polo-client-source-baseline'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 subprocess.run(['node',str(ASSISTANT/'tools/export-single-file.mjs')],check=True)
 payload=subprocess.check_output(['node','--input-type=module','-e',f"import {{scenes,aliases,revision}} from {json.dumps((ASSISTANT/'src/mvp/scenes.mjs').as_uri())};console.log(JSON.stringify({{scenes,aliases,revision}}))"],text=True)
 exported=json.loads(payload);aliases=exported['aliases'];resolve=lambda s:aliases.get(s,s)
 manifest=json.loads((BUNDLE/'prototype-manifest.json').read_text())
 closure=manifest.get('review',{}) if manifest.get('review',{}).get('item')=='cross-end-closure' else None
 closure_change=manifest.get('change') if closure else None
 with tarfile.open(BUNDLE/'sources/pre-assistant-r12.tar.gz') as archive:
  historical=json.load(archive.extractfile('prototype-manifest.json'))
 before=[s['id'] for s in historical['scenes']]
 # Preserve non-assistant authority and remove all prior assistant ownership.
 kept=[s for s in manifest['scenes'] if not s['id'].startswith('A-') and s['id'] not in aliases]
 for s in kept:
  s['surface']='mvp'
  for t in s['transitions']:
   t['to']=resolve(t['to'])
   if s['module']=='M03' and t['to'].startswith('A-') and '-generating' in t['to']:t['to']=t['to'].replace('-generating','-new')

 # Browser surface represents handoff only, never an automatic credit query.
 for sc in kept:
  if sc['id'] in ['P-M09-BROWSER','P-M09-BROWSER-STREAM']:
   for t in sc['transitions']:
    if t['label']!='取消':t['to']='A-personal-returnstream' if sc['id'].endswith('STREAM') else 'A-personal-return';t['label']='返回 Polo'
 for suffix,title in [('OWNER','企业充值'),('BUDGET','企业预算')]:
  sid='P-M09-BROWSER-'+suffix
  if not any(s['id']==sid for s in kept):
   kept.append({'id':sid,'module':'M09','surface':'mvp','journey':'J-PC-03','node':'browser','state':suffix.lower(),'status':'proposed','category':'跨端交接','title':title+'（浏览器交接）','annotation':'仅浏览器交接。返回原企业对话后主动查询，不自动恢复任务。','transitions':[{'id':sid+'-return','label':'返回 Polo','to':'A-enterprise-budgetreturn' if suffix=='BUDGET' else 'A-enterprise-ownerreturn','feedback':'回到原企业对话，待主动查询'}]})
 for sc in kept:
  if sc['id']=='P-M09-BROWSER-BUDGET':sc['transitions'][0]['to']='A-enterprise-budgetreturn'
 manifest['scenes']=kept+exported['scenes'];ids={s['id'] for s in manifest['scenes']}
 manifest['revision']=exported['revision'];manifest['aliases']=aliases
 manifest['surfaces']={'mvp':'prototype.html','assistant':'../../design-demos/polo-client-source-baseline/prototype.html'}
 manifest['target']['viewports']=[{'id':f'desktop-{w}x{h}','width':w,'height':h} for w,h in [(1440,900),(1024,768),(800,600)]]
 for story in manifest['stories']:
  for step in story['steps']:step['scene']=resolve(step['scene'])
 manifest['stories']=[s for s in manifest['stories'] if not s['id'].startswith('AS-') and s['id'] not in ['S-LOCAL-SKILLS','S-TEAM-SHARE']]
 def story(key,title,scope,keys):
  manifest['stories'].append({'id':'AS-'+key,'title':title,'description':'新助手基线的 MVP 连续走查；前后步仅浏览状态。','steps':[{'id':f'AS-{key}-{i+1}','scene':k if k.startswith('P-') else f'A-{scope}-{k}','description':k} for i,k in enumerate(keys)]})
 story('personal','助手 · 个人会话与恢复','personal',['P-M03-HOME-PERSONAL','new','generating','stopped','question','reopen','answered','files','viewer','missing','reselected'])
 story('enterprise','助手 · 企业隔离与额度','enterprise',['P-M03-HOME-ENT','new','generating','question','deferred','notify','notified','budget','budgetowner','P-M09-BROWSER-MENU-ENT','ownerresumed'])
 for scope in ['personal','enterprise']:story('skills-'+scope,'助手 · 技能获取、启用与设备准备 · '+scope,scope,['discover','acquire','enabledpending','installing','enabled','detail','updated','updatefailed','remove','uninstalled','restricted','reauthorized','sources','sourceauth','sourcefailed','sourcedenied'])
 story('credits','助手 · 充值后主动恢复','personal',['preblock','P-M09-BROWSER','checking','notyet','queryfailed','resumed','generating','cut','P-M09-BROWSER-STREAM','checking','resumed'])
 byid={s['id']:s for s in manifest['scenes']}
 entries={resolve(e['scene']):e for e in manifest.get('review_entries',[]) if resolve(e['scene']) in ids}
 for s in exported['scenes']:entries[s['id']]={'scene':s['id'],'reason':f"查看{s['title']}；系统结果与异常由评审选取，不触发业务操作。"}
 for e in entries.values():e['scene']=resolve(e['scene'])
 for st in manifest['stories']:
  for i,step in enumerate(st['steps']):
   if i and not any(t['to']==step['scene'] for t in byid[st['steps'][i-1]['scene']]['transitions']):
    step['arrival']='review';entries.setdefault(step['scene'],{'scene':step['scene'],'reason':'浏览系统结果或跨端状态。'})
 manifest['review_entries']=list(entries.values())
 # Bind current input sources; old prototype snapshots are history, not requirements.
 manifest['sources']=[s for s in manifest['sources'] if not s['id'].startswith('assistant-r12-')]
 for key,path,label in [('source','design-demos/polo-client-source-baseline/SOURCE-EVIDENCE.md','固定 Renderer 组件依据'),('routes','design-demos/polo-client-source-baseline/src/mvp/scenes.mjs','助手源码场景映射'),('design','design-demos/polo-client-source-baseline/SCENE-TRACEABILITY.md','助手组件与本轮设计差异')]:
  manifest['sources'].append({'id':'assistant-r12-'+key,'path':path,'label':label,'revision':exported['revision'],'sha256':digest(ROOT/path)})
 for source in manifest['sources']:
  if source['id']=='renderer-index-css':
   source['path']='docs/mvp-complete-flow-hifi/sources/renderer-index.css';source['label']='固定 Renderer 01f4447c 样式快照（非当前工作树）'
 for source in manifest['design']['sources']:
  if source['path']=='apps/electron/src/renderer/index.css':source['path']='docs/mvp-complete-flow-hifi/sources/renderer-index.css'
 manifest['design']['sha256']=digest(ROOT/manifest['design']['skill_path']);manifest['design']['revision']='poo70-assistant-unified-r12：助手引用新基线；非助手沿用 G4'
 manifest['change']={'summary':'统一入口选择 MVP 或新助手；旧助手退为历史，兼容链接仍可到达。新增布局与状态待复看。','changed_scenes':sorted(ids),'removed_scenes':sorted(set(before)-ids)}
 manifest['summary']=['统一入口，两份产品表面。','助手源码是助手的唯一维护来源。','业务规则沿用已接受 Spec；新增布局待复看。']
 brief={'source':'assistant-r12-review','item':'assistant-unified-entry','revision':exported['revision'],'current':'助手组件来自固定 Renderer 转译基线；现有 MVP 旧助手已退出当前参考。','target':'同一入口走查两份产品表面；新基线补齐会话、技能、数据源、文件与积分恢复。','reason':'消除两份助手参考并补齐已确认 MVP 状态。','question':'新助手布局、状态区分与失败恢复是否清晰？新增设计待复看。'}
 bp=BUNDLE/'sources/assistant-r12-review.json';bp.write_text(json.dumps(brief,ensure_ascii=False,indent=2)+'\n')
 manifest['sources']=[s for s in manifest['sources'] if s['id']!='assistant-r12-review']+[{'id':'assistant-r12-review','label':'助手统一入口本轮复看','path':str(bp.relative_to(ROOT)),'revision':exported['revision'],'sha256':digest(bp)}];manifest['review']=brief
 for s in manifest['scenes']:
  for t in s['transitions']:
   if t['to'] not in ids:raise ValueError((s['id'],t['to']))
 if closure:
  manifest['review']=closure;manifest['revision']=closure['revision'];manifest['change']=closure_change;manifest['summary']=[closure_change['summary']]
 for source in manifest['sources']:
  if source['path']=='docs/client-journey-review/spec.md':source['sha256']=digest(ROOT/source['path'])
 encoded=json.dumps(manifest,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
 (BUNDLE/'prototype-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 (BUNDLE/'review.html').write_text((BUNDLE/'tools/review-shell.html').read_text().replace('__MANIFEST__',encoded))
 product=(BUNDLE/'prototype.html').read_text()
 for suffix,title in [('OWNER','企业充值'),('BUDGET','企业预算')]:
  sid='P-M09-BROWSER-'+suffix
  if 'data-prototype-scene="'+sid+'"' not in product:
   section='<section class="scene" data-prototype-scene="'+sid+'"><div class="flow-state-page"><div class="eyebrow">系统浏览器</div><h1>'+title+'</h1><p>晨星科技 · 请在平台处理企业额度。</p><button data-go="A-enterprise-ownerreturn" data-transition="'+sid+'-return">返回 Polo</button></div></section>\n'
   product=product.replace('\n</main>', '\n'+section+'</main>',1)

 # Scene roots are emitted on separate lines by the established MVP authoring path.
 pattern=r'<section class="scene[^\"]*"[^>]*data-prototype-scene="([^"]+)"[\s\S]*?(?=\n<section class="scene|\n</main>)'
 product=re.sub(pattern,lambda m:'' if m[1] in aliases else m[0],product)
 for old,new in aliases.items():product=product.replace('data-go="'+old+'"','data-go="'+new+'"')
 for sc in kept:
  for t in sc['transitions']:
   if sc['id'] in ['P-M09-BROWSER','P-M09-BROWSER-STREAM'] and t['label']=='返回 Polo':
    product=re.sub(r'(<button[^>]+data-transition="'+re.escape(t['id'])+r'"[^>]*>).*?(</button>)',lambda m:m[1]+'返回 Polo'+m[2],product)
   product=re.sub(r'(<[^>]+data-transition="'+re.escape(t['id'])+r'"[^>]*>)',lambda m:re.sub(r'data-go="[^"]+"','data-go="'+t['to']+'"',m[0]),product)
 product=re.sub(r'(<script[^>]+id="prototype-manifest"[^>]*>).*?(</script>)',lambda m:m[1]+encoded+m[2],product,flags=re.S)
 if '// r12 surface routing' not in product:
  product=product.replace("function show(id,reason='command',transition=null){if(!byScene.has(id))return;", """// r12 surface routing: standalone handoff and embedded action reports.
function show(id,reason='command',transition=null){id=manifest.aliases?.[id]||id;if(!byScene.has(id))return;
 if(byScene.get(id).surface==='assistant'){
  if(window===parent){location.replace('../../design-demos/polo-client-source-baseline/prototype.html?scene='+encodeURIComponent(id));return}
  send('scene-change',{scene:id,reason,from:current,transition});return;
 }""")
  product=product.replace("const requested=hash.get('scene')||query.get('scene');", "const requested=manifest.aliases?.[hash.get('scene')||query.get('scene')]||hash.get('scene')||query.get('scene');")
 (BUNDLE/'prototype.html').write_text(product)
 # The manifest and review page expose the generated scene map; Spec is the only product document.
 print(f"Unified: {len(kept)} MVP + {len(exported['scenes'])} assistant scenes; {len(aliases)} compatibility links")
if __name__=='__main__':main()
