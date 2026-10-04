#!/usr/bin/env python3
"""Current r12 entry: assistant source export -> unified manifest -> two surfaces.
MVP source is maintained in the project Design System Skill; docs/prototype.html
is its compatibility export. Review source is review-shell.html; never invoke
pre-r12 reconstruction scripts for current output.
"""
import hashlib,json,re,subprocess,tarfile
from pathlib import Path
BUNDLE=Path(__file__).resolve().parents[1]
ROOT=BUNDLE.parents[1]
ASSISTANT=ROOT/'design-demos/polo-client-source-baseline'
DESIGN=ROOT/'.agents/skills/polo-ai-design-system'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 subprocess.run(['node',str(ASSISTANT/'tools/export-single-file.mjs')],check=True)
 payload=subprocess.check_output(['node','--input-type=module','-e',f"import {{scenes,aliases,revision}} from {json.dumps((ASSISTANT/'src/mvp/scenes.mjs').as_uri())};console.log(JSON.stringify({{scenes,aliases,revision}}))"],text=True)
 exported=json.loads(payload);aliases=exported['aliases'];resolve=lambda s:aliases.get(s,s)
 manifest=json.loads((BUNDLE/'prototype-manifest.json').read_text())
 closure=manifest.get('review',{}) if manifest.get('review',{}).get('item') in ['cross-end-closure','workbench-r14'] else None
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
  manifest['stories'].append({'id':'AS-'+key,'title':title,'description':'既有助手行为衔接示意；既有 UI 沿用真实 Renderer，只有明确新增差异参与本轮评审。前后步仅浏览状态。','steps':[{'id':f'AS-{key}-{i+1}','scene':k if k.startswith('P-') else f'A-{scope}-{k}','description':k} for i,k in enumerate(keys)]})
 story('personal','助手 · 个人会话与恢复','personal',['P-M03-HOME-PERSONAL','new','generating','stopped','question','reopen','answered','files','viewer','missing','reselected'])
 story('enterprise','助手 · 企业隔离与额度','enterprise',['P-M03-HOME-ENT','new','generating','question','deferred','notify','notified','budget','budgetowner','P-M09-BROWSER-MENU-ENT','ownerresumed'])
 for scope in ['personal','enterprise']:story('skills-'+scope,'Polo 技能 · 获取、启用与设备准备 · '+scope,scope,['discover','acquire','enabledpending','installing','enabled','detail','updated','updatefailed','remove','uninstalled','restricted','reauthorized','sources','sourceauth','sourcefailed','sourcedenied'])
 story('credits','助手 · 充值后主动恢复','personal',['preblock','P-M09-BROWSER','checking','notyet','queryfailed','resumed','generating','cut','P-M09-BROWSER-STREAM','checking','resumed'])
 byid={s['id']:s for s in manifest['scenes']}
 entries={resolve(e['scene']):e for e in manifest.get('review_entries',[]) if resolve(e['scene']) in ids}
 for s in exported['scenes']:entries[s['id']]={'scene':s['id'],'reason':f"查看{s['title']}；系统结果与异常由评审选取，不触发业务操作。"}
 for e in entries.values():e['scene']=resolve(e['scene'])
 for st in manifest['stories']:
  for i,step in enumerate(st['steps']):
   if i and not any(t['to']==step['scene'] for t in byid[st['steps'][i-1]['scene']]['transitions']):
    step['arrival']='review';entries.setdefault(step['scene'],{'scene':step['scene'],'reason':'浏览系统结果或跨端状态。'})
 for st in manifest['stories']:
  for step in st['steps']:
   if step.get('arrival')=='review':entries.setdefault(step['scene'],{'scene':step['scene'],'reason':'查看本轮页面或系统结果，不触发业务动作。'})
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
 for source in manifest['design']['sources']:
  if source['path']=='.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css':source['sha256']=digest(ROOT/source['path'])
 header_source='.agents/skills/polo-ai-design-system/assets/components/workbench-header-scroll.js'
 manifest['sources']=[x for x in manifest['sources'] if x['id']!='workbench-header-scroll']+[{'id':'workbench-header-scroll','path':header_source,'label':'顶部 Header 滚动分隔线共享行为','revision':exported['revision'],'sha256':digest(ROOT/header_source)}]
 for key in ['space-switch-sequence','space-switch-progress','circle-membership-feedback']:
  path=f'.agents/skills/polo-ai-design-system/assets/components/{key}.js'
  manifest['sources']=[x for x in manifest['sources'] if x['id']!=key]+[{'id':key,'path':path,'label':'空间切换系统进度','revision':exported['revision'],'sha256':digest(ROOT/path)}]
 model=json.loads((DESIGN/'references/design-system.json').read_text())
 manifest['design']['sha256']=digest(ROOT/manifest['design']['skill_path'])
 manifest['design']['revision']=model['revision']
 manifest['design']['model_path']='.agents/skills/polo-ai-design-system/references/design-system.json'
 manifest['design']['sources']=[{'path':s['path'],'sha256':s['sha256']} for s in model['sources']]
 for key,path,label in [
  ('client-workbench-template','.agents/skills/polo-ai-design-system/references/client-workbench.template.html','客户端产品页面唯一维护模板'),
  ('workbench-base-css','.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css','最新原型提升的 b82fa1e5 基础样式'),
  ('client-design-model','.agents/skills/polo-ai-design-system/references/design-system.json','当前客户端设计模型'),
  ('client-design-foundations','.agents/skills/polo-ai-design-system/references/foundations.md','当前客户端设计来源和消费边界')]:
  manifest['sources']=[s for s in manifest['sources'] if s['id']!=key]+[{'id':key,'path':path,'label':label,'revision':model['revision'],'sha256':digest(ROOT/path)}]
 manifest['change']={'summary':'统一入口选择 MVP 或新助手；旧助手退为历史，兼容链接仍可到达。新增布局与状态待复看。','changed_scenes':sorted(ids),'removed_scenes':sorted(set(before)-ids)}
 manifest['summary']=['统一入口，两份产品表面。','助手源码是助手的唯一维护来源。','业务规则沿用已接受 Spec；新增布局待复看。']
 brief={'source':'assistant-r12-review','item':'assistant-unified-entry','revision':exported['revision'],'current':'既有助手页面是固定版本组件转译后的行为示意，并非当前真实 Renderer 的整页复刻。','target':'聚焦技能管理和明确新增差异；既有聊天、输入、附件与会话导航沿用真实代码，不从示意页面派生 UI 重写。','reason':'用户担心简化原型误导实现范围，Spec §13.11 明确增量边界。','question':'技能管理是否清晰，既有助手沿用真实实现的边界是否明确？'}
 bp=BUNDLE/'sources/assistant-r12-review.json';bp.write_text(json.dumps(brief,ensure_ascii=False,indent=2)+'\n')
 manifest['sources']=[s for s in manifest['sources'] if s['id']!='assistant-r12-review']+[{'id':'assistant-r12-review','label':'助手统一入口本轮复看','path':str(bp.relative_to(ROOT)),'revision':exported['revision'],'sha256':digest(bp)}];manifest['review']=brief
 for s in manifest['scenes']:
  for t in s['transitions']:
   if t['to'] not in ids:raise ValueError((s['id'],t['to']))
 if closure:
  if closure['item']=='workbench-r14':
   review_path=BUNDLE/'sources/workbench-r14-review.json';review_path.write_text(json.dumps(closure,ensure_ascii=False,indent=2)+'\n')
   manifest['sources']=[x for x in manifest['sources'] if x['id']!='workbench-r14-review']+[{'id':'workbench-r14-review','path':str(review_path.relative_to(ROOT)),'label':'工作台与全端 UI/UX 复看范围（派生摘要）','revision':closure['revision'],'sha256':digest(review_path)}]
  manifest['review']=closure;manifest['revision']=closure['revision'];manifest['change']=closure_change;manifest['summary']=[closure_change['summary']]
 for source in manifest['sources']:
  if source['path'] in ['docs/client-journey-review/spec.md','.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css']:source['sha256']=digest(ROOT/source['path'])
 encoded=json.dumps(manifest,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
 (BUNDLE/'prototype-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 # Legacy docs entry remains the only runnable MVP export. This Skill-owned
 # consumer manifest indexes its selected scenes without duplicating the HTML.
 consumers={}
 for row in model['component_contracts']:
  for consumer in row['consumers']:
   consumers.setdefault(consumer['scene'],[]).append(row['name'])
 consumer_manifest={
  'schema_version':1,'kind':'client-entry-consumer-index',
  'revision':manifest['revision'],'design_revision':model['revision'],
  'source_manifest':'docs/mvp-complete-flow-hifi/prototype-manifest.json',
  'source_manifest_sha256':digest(BUNDLE/'prototype-manifest.json'),
  'product_export':'docs/mvp-complete-flow-hifi/prototype.html',
  'target':manifest['target'],
  'scenes':[dict(s,components=consumers[s['id']]) for s in manifest['scenes'] if s['id'] in consumers]}
 cp=DESIGN/'assets/prototypes/client-entry/prototype-manifest.json'
 cp.parent.mkdir(parents=True,exist_ok=True)
 cp.write_text(json.dumps(consumer_manifest,ensure_ascii=False,indent=2)+'\n')
 # Compatibility model is derived; references/design-system.json is canonical.
 (BUNDLE/'design-system.adoption.json').write_text(json.dumps(model,ensure_ascii=False,indent=2)+'\n')
 sequence_path='.agents/skills/polo-ai-design-system/assets/components/space-switch-sequence.js'
 review=(BUNDLE/'tools/review-shell.html').read_text().replace('__MANIFEST__',encoded)
 review=review.replace('__SPACE_SWITCH_SEQUENCE__',(ROOT/sequence_path).read_text())
 (BUNDLE/'review.html').write_text(review)
 product=(DESIGN/'references/client-workbench.template.html').read_text()
 if product.count('__WORKBENCH_BASE_CSS__')!=1:raise ValueError('Expected one maintained base style marker')
 product=product.replace('__WORKBENCH_BASE_CSS__',(DESIGN/'assets/tokens/workbench-base.css').read_text())
 shared_style=ROOT/'.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css'
 product=re.sub(r'<style id="workbench-review-style">[\s\S]*?</style>','',product)
 product=product.replace('</head>','<style id="workbench-review-style">'+shared_style.read_text()+'</style></head>')
 product=re.sub(r'<script data-product-script="workbench-header-scroll">[\s\S]*?</script>','',product)
 product=product.replace('</body>','<script data-product-script="workbench-header-scroll">'+(ROOT/header_source).read_text()+'</script></body>')
 for suffix,title in [('OWNER','企业充值'),('BUDGET','企业预算')]:
  sid='P-M09-BROWSER-'+suffix
  if 'data-prototype-scene="'+sid+'"' not in product:
   section='<section class="scene" data-prototype-scene="'+sid+'"><div class="flow-state-page"><div class="eyebrow">系统浏览器</div><h1>'+title+'</h1><p>晨星科技 · 请在平台处理企业额度。</p><button data-go="A-enterprise-ownerreturn" data-transition="'+sid+'-return">返回 Polo</button></div></section>\n'
   product=product.replace('\n</main>', '\n'+section+'</main>',1)

 for script_name in ['space-switch-sequence','space-switch-progress','circle-membership-feedback']:
  product=re.sub(r'<script data-product-script="'+script_name+r'">[\s\S]*?</script>','',product)
  script=(ROOT/'.agents/skills/polo-ai-design-system/assets/components'/f'{script_name}.js').read_text()
  product=product.replace('</body>','<script data-product-script="'+script_name+'">'+script+'</script></body>')

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
