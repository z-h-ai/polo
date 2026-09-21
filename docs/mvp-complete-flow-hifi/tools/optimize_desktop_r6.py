#!/usr/bin/env python3
"""Incremental desktop/container and local Skills proposal. Requires beautifulsoup4."""
import copy, hashlib, json, re, sys
from pathlib import Path
try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.path.insert(0, '/tmp/polo-ux-deps')
    from bs4 import BeautifulSoup
B=Path(__file__).resolve().parents[1];ROOT=B.parents[1]
REV='poo70-desktop-ux-r6-v3-14'
old=json.loads((B/'sources/prototype-manifest-before-ux-r6.json').read_text());m=copy.deepcopy(old)
html=(B/'build/ux-r6/prototype-before.html').read_text()
html,tail=re.split(r'(?=<script id="prototype-manifest")',html,maxsplit=1)
html=html.rsplit('</main>',1)[0];tail='</main>\n'+tail
parts=re.split(r'(?=<section class="scene" data-prototype-scene=")',html)
head=parts[0]; raws={}
for part in parts[1:]:
 sid=re.match(r'<section class="scene" data-prototype-scene="([^"]+)"',part)[1]
 if '</main>\n<script id="prototype-manifest"' in part:
  part,tail=part.split('</main>\n<script id="prototype-manifest"',1);tail='</main>\n<script id="prototype-manifest"'+tail
 raws[sid]=part
scenes={sid:BeautifulSoup(raw,'html.parser').select_one('section.scene') for sid,raw in raws.items()}
meta={s['id']:s for s in m['scenes']}
def parse(x):return BeautifulSoup(x,'html.parser')
def btn(label,to,cls='button',extra=''):return f'<button class="{cls}" data-go="{to}" {extra}>{label}</button>'
def replace_main(sid,content,cls='workspace-main'):
 e=scenes[sid].select_one('.workspace-main');e.replace_with(parse(f'<main class="{cls}" id="workspace-main">{content}</main>'))
def clone(src,sid,title,module=None):
 scenes[sid]=copy.deepcopy(scenes[src]);scenes[sid]['data-prototype-scene']=sid
 meta[sid]=copy.deepcopy(meta[src]);meta[sid].update(id=sid,node=sid,title=title,status='suggested',state=sid.lower(),annotations=[])
 if module:meta[sid]['module']=module
 return scenes[sid]
def txt(e,v):
 if e:e.clear();e.append(v)
def home(personal):return 'P-M03-HOME-PERSONAL' if personal else 'P-M03-HOME-ENT'
def skills(personal):return 'P-M06-SKILLS-PERSONAL' if personal else 'P-M06-SKILLS'
def assistant(personal):return 'P-M05-NEW' if personal else 'P-M05-NEW-ENT'
# Preserve login bytes; shared shell fixes are scoped to the desktop.
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 personal='我的空间' in (e.select_one('#space-name').get_text() if e.select_one('#space-name') else '')
 for n in e.find_all(string=True):
  if n.parent.name in ['script','style']:continue
  value=str(n).replace('全部 Apps','全部应用').replace('全部 App','全部应用').replace('常用 Apps','常用应用').replace('常用 App','常用应用').replace('管理技能','管理 Skill').replace('企业内部导入 · 晨星科技','晨星科技 · 企业应用').replace('复制编号（演示）','复制编号')
  if value!=str(n):n.replace_with(value)
 brand=e.select_one('.brand-lockup')
 if brand:brand['data-go']=home(personal)
 for n in e.select('#runtime-label'):txt(n,'后台任务')
 for n in e.select('.tab-close'):
  txt(n,'×');n['aria-label']='关闭标签';n['title']='关闭当前标签';n['data-go']=home(personal)
 for n in e.select('[data-go="P-M03-ALL-APPS"]'):
  if not personal:n['data-go']='P-M03-ALL-APPS-ENT'
 for n in e.select('.assistant-new-session'):
  n['data-go']=assistant(personal)
 for n in e.select('.assistant-header-actions [data-go]'):
  n['data-go']=skills(personal);txt(n,'管理 Skill')
 for n in e.select('.product-card'):
  if n.select_one('h3') and n.select_one('h3').get_text(strip=True)=='合同审查':
   for a in n.select('[data-go="P-M04-PREPARE"]'):a['data-go']='P-M04-APP-CONTRACT';txt(a,'打开')
   for a in n.select('.status'):txt(a,'企业提供')
  if n.select_one('h3') and n.select_one('h3').get_text(strip=True)=='报价整理':
   for a in n.select('.status.info'):txt(a,'可使用')
  if 'assistant-card' in n.get('class',[]):
   for a in n.select('[data-go^="P-M05-"]'):a['data-go']=assistant(personal)
   txt(n.select_one('.source-line'),'Polo 内置 · 当前空间的专属助手')
 for n in e.select('.assistant-nav-item'):
  if n.get_text(strip=True)=='技能':txt(n.select_one('span'),'Skill')
# Add correct enterprise application directory.
clone('P-M03-HOME-ENT','P-M03-ALL-APPS-ENT','全部应用 · 企业提供','M03')
replace_main('P-M03-ALL-APPS-ENT',f'''<div class="subpage-heading"><div>{btn('返回首页',home(False),'back-button')}<p class="eyebrow">晨星科技</p><h1>企业应用</h1><p>团队提供的工作工具，打开即可使用</p></div></div><div class="card-grid">{''.join(str(x) for x in scenes['P-M03-HOME-ENT'].select('.product-card'))}</div>''')
# Keep app internals neutral. Polo adds no task dashboard or in-app business flow.
app_variants={'P-M04-APP-VIEW':('报价整理',False),'P-M04-APP-VIEW-PERSONAL':('会议纪要整理',True),'P-M04-APP-CONTRACT':('合同审查',False),'P-M04-APP-GROWTH':('增长打法手册',True),'P-M04-APP-REPORT':('数据报表生成器',True),'P-M04-APP-BRAND':('品牌语气分析',True)}
for sid,(name,personal) in app_variants.items():
 if sid not in scenes:clone('P-M04-APP-VIEW-PERSONAL' if personal else 'P-M04-APP-VIEW',sid,f'应用 · {name}','M04')
 e=scenes[sid];tab=e.select_one('.tab-activate');txt(tab,name);tab['data-go']=sid
 replace_main(sid,f'''<section class="app-content-plane" data-review-anchor="app-content"><div class="app-neutral-identity"><span class="app-art">{name[0]}</span><h1>{name}</h1><p>{'我的空间' if personal else '晨星科技'}</p></div></section>''','workspace-main container-mode')
 meta[sid]['title']=f'应用 · {name}'
 meta[sid]['annotation']='应用内容占满标签下方工作区；中性内容承载区不设计第三方应用内部业务。正常打开没有安装、执行、停止向导；文件/AI能力由实际调用触发容器反馈。'
 meta[sid]['annotations']=[dict(id='app-boundary',anchor='app-content',title='应用直接打开',body='此处是应用自己的页面范围。Polo 只负责标签、当前空间、按需授权和能力反馈，不在这里添加应用业务步骤。关闭普通标签直接返回首页；SDK有未结束任务时才使用已有三选项确认。')]
# Fix card identity and personal context, including circle entries.
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 for card in e.select('.product-card,.circle-work-row'):
  title=card.select_one('h3');name=title.get_text(strip=True) if title else ''
  target=next((k for k,v in app_variants.items() if v[0]==name),None)
  if target:
   for a in card.select('[data-go^="P-M04-APP"],[data-go="P-M04-PREPARE"]'):a['data-go']=target
# On-demand file permission and separate failure; neither is a mandatory opening step.
replace_main('P-M04-PREPARE',str(scenes['P-M04-APP-CONTRACT'].select_one('.workspace-main').decode_contents()),'workspace-main container-mode')
modal=scenes['P-M04-PREPARE'].select_one('.modal-layer')
modal.clear();modal.append(parse(f'''<div class="dialog" role="dialog" aria-modal="true" aria-label="文件访问许可"><div class="dialog-header"><div><h2>允许「合同审查」读取所选文件？</h2><p>晨星科技 · 合同审查</p></div></div><div class="dialog-body"><div class="impact-card"><span><strong>采购合同.pdf</strong><small>仅本次选中的文件。其他文件和文件夹不会开放。</small></span></div><p>文件内容将用于 AI 分析，费用由晨星科技承担。</p></div><div class="dialog-footer">{btn('不允许','P-M04-APP-CONTRACT')}{btn('允许本次访问','P-M04-APP-CONTRACT','button primary')}</div></div>'''))
meta['P-M04-PREPARE']['title']='应用请求访问所选文件'
meta['P-M04-PREPARE']['annotation']='SDK实际请求读取用户所选文件时出现；不是应用首次打开的必经页。不允许仍回原应用。'
# Scene that truly has a background capability call, for conditional close flow.
clone('P-M04-APP-VIEW','P-M04-APP-ACTIVE','应用 · 有后台 AI 请求','M04')
e=scenes['P-M04-APP-ACTIVE'];e.select_one('.tab-close')['data-go']='P-M04-CLOSE-ACTIVE';e.select_one('#runtime-label').string='1 项后台任务'
e.select_one('.workspace-main').insert(0,parse('<div class="capability-status" role="status">报价整理正在使用 AI 服务。可切换标签继续工作。</div>'))
meta['P-M04-APP-ACTIVE']['annotation']='仅代表应用已通过SDK注册尚未结束的后台任务。应用内部如何发起任务不在Polo原型中模拟；由评审入口进入。'
for sid in ['P-M04-CLOSE-ACTIVE','P-M04-TERM-FAILED']:
 e=scenes[sid]
 replace_main(sid,str(scenes['P-M04-APP-ACTIVE'].select_one('.workspace-main').decode_contents()),'workspace-main container-mode')
 for a in e.select('.modal-layer [data-go="P-M04-APP-VIEW"]'):a['data-go']='P-M04-APP-ACTIVE'
 for n in e.find_all(string=True):
  if '报价整理正在运行' in n:n.replace_with(str(n).replace('报价整理正在运行','仍有 1 项 AI 请求尚未结束'))
 meta[sid]['annotation']='仅在SDK注册的任务尚未结束时询问关闭方式；普通打开的应用关闭无此确认。后台继续保留原有恢复入口。'
# Local Skill management uses assistant frame; center pane becomes skill navigation.
BASE_PERSONAL=copy.deepcopy(scenes['P-M06-SKILLS-PERSONAL']);BASE_ENT=copy.deepcopy(scenes['P-M06-SKILLS'])
newskill={
 'P-M06-SKILLS-PERSONAL':(True,'installed'), 'P-M06-SKILLS':(False,'installed'),
 'P-M06-DISCOVER-PERSONAL':(True,'discover'), 'P-M06-DISCOVER-ENT':(False,'discover'),
 'P-M06-INSTALL-PERSONAL':(True,'install'), 'P-M06-INSTALL-ENT':(False,'install'),
 'P-M06-INSTALLED-PERSONAL':(True,'ready'), 'P-M06-INSTALLED-ENT':(False,'ready'),
 'P-M06-ENABLED-PERSONAL':(True,'enabled'), 'P-M06-ENABLED-ENT':(False,'enabled'),
 'P-M06-DETAIL-PERSONAL':(True,'detail'), 'P-M06-DETAIL-ENT':(False,'detail'),
 'P-M06-UPDATE-PERSONAL':(True,'updated'), 'P-M06-UPDATE-ENT':(False,'updated'),
 'P-M06-REMOVE-PERSONAL':(True,'remove'), 'P-M06-REMOVE-ENT':(False,'remove'),
 'P-M06-INSTALL-FAILED':(True,'failed'), 'P-M06-LOCAL-RESTRICTED':(True,'restricted'),
 'P-M06-BUILTIN-OFF-PERSONAL':(True,'builtin-off'), 'P-M06-BUILTIN-OFF-ENT':(False,'builtin-off'),
 'P-M06-SHARE-ENT':(False,'share'), 'P-M06-SHARE-SUBMITTED':(False,'submitted')}
def skillrow(name,desc,source,state,actions):
 return f'<article class="local-skill-row" data-search-text="{name} {source}"><span class="app-art compact">✧</span><div class="skill-info"><h3>{name}</h3><p>{desc}</p><small>{source}</small></div><div class="skill-row-actions"><span class="status neutral">{state}</span><div>{actions}</div></div></article>'
for sid,(personal,kind) in newskill.items():
 base='P-M06-SKILLS-PERSONAL' if personal else 'P-M06-SKILLS';suffix='PERSONAL' if personal else 'ENT';space='我的空间' if personal else '晨星科技'
 def to(k):return f'P-M06-{k}-{suffix}'
 if sid not in scenes:clone(base,sid,'Skill · '+kind,'M06')
 e=scenes[sid];frame=copy.deepcopy(BASE_PERSONAL if personal else BASE_ENT).select_one('.workspace-main');e.select_one('.workspace-main').replace_with(frame)
 nav=frame.select_one('.assistant-navigator');nav.clear();nav.append(parse(f'''<header><div><strong>Skill</strong><span>{space}</span></div></header><p class="assistant-list-label">Polo 助手的能力</p>{btn('本机已安装',base,'session-row '+('active' if kind!='discover' else ''))}{btn('从圈子获取' if personal else '企业共享',to('DISCOVER'),'session-row '+('active' if kind=='discover' else ''))}<div class="skill-nav-note">安装在这台 Mac<br>仅供当前空间的 Polo 助手使用</div>'''))
 name='增长案例检索' if personal else '销售周报';source='晨星增长圈 · 晨星增长工作室' if personal else '晨星科技 · 林晓共享';desc='根据提问检索增长方法，整理可参考的案例。' if personal else '按团队格式汇总本周进展、风险和下周计划。'
 title='本机 Skill';subtitle=f'{space} · 安装在这台 Mac · 启用设置跟随当前账号与空间'
 installed=kind not in ['installed','discover','install','failed','builtin-off','submitted','share']
 actions=btn('查看并安装',to('INSTALL'),'button primary')
 body=''
 if kind in ['installed','ready','enabled','updated','builtin-off']:
  off=kind=='builtin-off'
  body='<div class="skill-toolbar"><label class="skill-search">⌕ <input type="search" aria-label="搜索本机 Skill" placeholder="搜索名称或来源" data-skill-search></label>'+btn('获取 Skill',to('DISCOVER'))+'</div><div class="local-skill-list">'
  body+=skillrow('资料研究','查找资料、梳理重点并保留来源。','Polo 内置 · 随客户端更新','已停用' if off else '已启用',btn('启用' if off else '停用',base if off else to('BUILTIN-OFF'),'button quiet'))
  body+=skillrow('会议纪要','将对话中的会议材料整理为纪要。','Polo 内置 · 随客户端更新','已启用',btn('在助手中使用',assistant(personal),'button quiet'))
  if installed:
   enabled=kind in ['enabled','updated'];version='1.1.0' if kind=='updated' else '1.0.0'
   body+=skillrow(name,desc,source+f' · 本机 v{version}','已启用' if enabled else '已安装 · 未启用',btn('管理',to('DETAIL'),'button quiet')+btn('停用' if enabled else '启用',to('INSTALLED') if enabled else to('ENABLED'),'button primary'))
  else:body+=f'<div class="skill-empty"><h3>把好用的方法交给助手</h3><p>{"从已加入的圈子安装更多 Skill。" if personal else "安装同事共享的 Skill，复用团队的工作方法。"}</p>{actions}</div>'
  body+='</div><p class="skill-footnote">停用后，助手不会在后续消息中调用该 Skill。已有对话和正在进行的任务不受影响。</p>'
  if kind in ['ready','enabled','updated']:body=f'<div class="local-success" role="status">{ {"ready":"已安装到本机，启用后助手才能使用。","enabled":"已启用，可在新的消息中使用。","updated":"已更新到 v1.1.0，下次调用使用新版本。"}[kind]}</div>'+body
 elif kind=='discover':
  title='从圈子获取 Skill' if personal else '企业共享 Skill';subtitle='来自你已加入的圈子，安装后在本机管理。' if personal else '同事整理的工作方法，安装后交给助手使用。'
  body=skillrow(name,desc,source+' · v1.0.0','可安装',actions)
  body+=f'<div class="skill-info-card"><h3>{"寻找更多工作工具" if personal else "让团队复用你的经验"}</h3><p>{"圈子同时提供可直接打开的应用和助手使用的 Skill。" if personal else "已有本地 Skill 可以提交企业审核，通过后同事才能获取。"}</p>{btn("查看我的圈子","P-M07-LIST") if personal else btn("共享我的 Skill","P-M06-SHARE-ENT")}</div>'
 elif kind in ['install','detail','updated','restricted','failed']:
  title=name;subtitle=source
  version='v1.1.0' if kind=='updated' else 'v1.0.0'
  body=f'<div class="skill-detail-intro"><span class="app-art">✧</span><div><h2>{name}</h2><p>{desc}</p></div></div><dl class="skill-facts"><div><dt>提供者</dt><dd>{source}</dd></div><div><dt>安装位置</dt><dd>这台 Mac · {space}</dd></div><div><dt>使用范围</dt><dd>仅 Polo 助手</dd></div><div><dt>版本</dt><dd>{version}</dd></div><div><dt>需要的内容</dt><dd>当前提问与主动添加的附件</dd></div></dl>'
  if kind=='install':body+=f'<p class="skill-footnote">安装不会立即执行任务。安装后由你选择是否启用。</p><div class="skill-bottom-actions">{btn("返回",to("DISCOVER"))}{btn("安装到本机",to("INSTALLED"),"button primary")}</div>'
  elif kind=='detail':body+=f'<div class="skill-info-card"><h3>有新版本 v1.1.0</h3><p>优化输出格式；更新不改变当前任务正在使用的版本。</p>{btn("更新本机版本",to("UPDATE"),"button primary")}</div><div class="skill-bottom-actions">{btn("返回已安装",to("ENABLED"))}{btn("从本机卸载",to("REMOVE"),"button danger")}</div>'
  elif kind=='failed':body+=f'<div class="skill-info-card" role="alert"><h3>安装未完成</h3><p>网络连接中断，未启用此 Skill。恢复连接后可重试。</p>{btn("返回",to("DISCOVER"))}{btn("重试安装",to("INSTALLED"),"button primary")}</div>'
  elif kind=='restricted':body+=f'<div class="skill-info-card" role="alert"><h3>来源授权已失效</h3><p>本机副本已保留并停用。恢复有效授权前，助手不能调用。</p>{btn("查看圈子","P-M07-DETAIL-FOCUS")}{btn("从本机卸载",to("REMOVE"))}</div>'
 elif kind=='remove':
  title='从本机卸载？';subtitle=name
  body=f'<div class="skill-info-card"><h2>只移除这台 Mac 上的副本</h2><p>助手将不能再调用此 Skill。已有对话、生成的文件和来源中的共享内容都会保留；需要时可重新安装。</p><div class="skill-bottom-actions">{btn("取消",to("DETAIL"))}{btn("确认卸载",base,"button danger")}</div></div>'
 elif kind in ['share','submitted']:
  title='共享给晨星科技';subtitle='把自己整理的工作方法提交给团队'
  if kind=='share':body=f'<div class="skill-info-card"><h2>客户回访摘要</h2><p>我的本地 Skill · v1.0.0</p><dl class="skill-facts"><div><dt>包含</dt><dd>Skill 说明、执行脚本和模板</dd></div><div><dt>不包含</dt><dd>对话、客户附件、账号凭证</dd></div></dl><label>给审核人的说明<textarea class="share-note" placeholder="适合哪些同事，能解决什么问题？">帮助销售同事整理回访记录和下一步行动。</textarea></label><div class="skill-bottom-actions">{btn("取消","P-M06-DISCOVER-ENT")}{btn("提交企业审核","P-M06-SHARE-SUBMITTED","button primary")}</div></div>'
  else:body=f'<div class="local-success" role="status">已提交企业审核</div><div class="skill-info-card"><h2>客户回访摘要</h2><p>审核通过并分发后，同事才能在企业共享中安装。本机版本可以继续使用。</p>{btn("返回企业共享","P-M06-DISCOVER-ENT","button primary")}</div>'
 main=frame.select_one('.assistant-main');main.clear();main.append(parse(f'<header class="assistant-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{btn("回到对话",assistant(personal),"button quiet")}</header><div class="local-skills-panel" data-review-anchor="local-skills">{body}<p data-search-empty hidden>没有找到匹配的 Skill，请换个关键词。</p></div>'))
 meta[sid]['title']=title+' · '+space+' · '+{'installed':'本机','discover':'获取','install':'安装详情','ready':'已安装','enabled':'已启用','detail':'管理版本','updated':'已更新','remove':'卸载确认','failed':'安装失败','restricted':'授权失效','builtin-off':'内置已停用','share':'共享提交','submitted':'审核中'}[kind]
 meta[sid]['annotation']='用户要求的本地Skill管理；来源授权、安装到本机和本人启用分别呈现。个人圈子与企业共享隔离；只供Polo助手调用。安装、版本和共享流程为本轮推荐，待复看。'
 meta[sid]['annotations']=[dict(id='local-lifecycle',anchor='local-skills',title='管理这台 Mac 上的 Skill',body='内置 Skill 可停用，随客户端更新；分发 Skill 安装后需明确启用，可更新或卸载。卸载不删除来源作品或对话。企业共享提交是推荐流程，并非已发布给所有员工。')]
# Circle Skill actions go to concrete installation details, never start standalone tasks.
for sid,e in scenes.items():
 if not sid.startswith('P-M07-'):continue
 for row in e.select('.circle-work-row'):
  if not any('SKILLS' in a.get('data-go','') for a in row.select('[data-go]')):continue
  for a in row.select('[data-go*="SKILLS"]'):a['data-go']='P-M06-INSTALL-PERSONAL';txt(a,'查看并安装')
  for n in row.select('em'):txt(n,'安装到本机后，供 Polo 助手使用')
  for n in row.select('.status'):txt(n,'可安装')
 for a in e.select('.section-link[data-go*="SKILLS"]'):txt(a,'管理本机 Skill')
 for n in e.find_all(string=True):
  if str(n)=='在助手中开启技能':n.replace_with('安装到本机，再由 Polo 助手使用')
# Remove misleading version-install language from regular App entries; do not alter auth/payment policies.
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 for a in e.select('button'):
  if a.get_text(strip=True)=='更新并打开':txt(a,'打开')
# Product CSS only: preserve existing visual palette and assistant three-column structure.
css='''
/* desktop UX r6: local Skill manager and neutral application container */
.workspace-main.container-mode{padding:0!important;max-width:none!important;width:100%;display:flex;flex-direction:column;overflow:auto;}
.app-content-plane{flex:1;min-height:400px;position:relative;background:var(--background,#fff);display:grid;place-items:center;}
.app-neutral-identity{text-align:center;color:var(--foreground);}.app-neutral-identity .app-art{margin:0 auto 18px;}.app-neutral-identity h1{font-size:22px;font-weight:550;letter-spacing:-.5px}.app-neutral-identity p{font-size:13px;color:var(--fg-50,#777);margin-top:8px;}
.capability-status{padding:12px 24px;background:var(--accent-10,#f1ecfb);font-size:13px;color:var(--accent);}
.local-skills-panel{padding:26px 30px;overflow:auto;flex:1;min-height:0;}.assistant-main:has(.local-skills-panel){display:flex;flex-direction:column;min-width:0;}.skill-nav-note{padding:22px 16px;font-size:12px;color:var(--fg-50,#777);line-height:1.8;}
.skill-toolbar{display:flex;gap:12px;align-items:center;margin-bottom:24px;}.skill-search{display:flex;align-items:center;gap:10px;border:1px solid var(--fg-10,#ddd);border-radius:9px;padding:9px 12px;flex:1;}.skill-search input{border:0;outline:0;background:transparent;color:inherit;min-width:0;width:100%;font:inherit;font-size:13px;}
.local-skill-row{display:flex;align-items:flex-start;gap:14px;padding:21px 0;border-bottom:1px solid var(--fg-10,#e9e9eb);}.skill-info{flex:1;min-width:0;}.skill-info h3{font-size:14px;margin:0 0 7px;}.skill-info p{font-size:13px;line-height:1.6;margin:0 0 6px;}.skill-info small{font-size:11px;color:var(--fg-50,#777);}.skill-row-actions{display:flex;flex-direction:column;align-items:flex-end;gap:12px;}.skill-row-actions>div{display:flex;gap:6px;}.skill-row-actions .button{font-size:12px;min-height:30px;padding:6px 10px;}
.skill-empty,.skill-info-card{border:1px solid var(--fg-10,#e5e5e8);border-radius:12px;padding:24px;margin:24px 0;background:var(--background,#fff);}.skill-empty h3,.skill-info-card h3{font-size:15px;margin:0 0 9px;}.skill-info-card h2{font-size:19px;}.skill-empty p,.skill-info-card p{font-size:13px;line-height:1.8;color:var(--fg-50,#777);margin:8px 0 18px;}.skill-footnote{font-size:12px;line-height:1.8;color:var(--fg-50,#777);margin-top:24px;}.local-success{padding:12px 16px;border-radius:8px;background:#eaf5ef;color:#247453;font-size:13px;margin-bottom:16px;}.skill-detail-intro{display:flex;gap:18px;align-items:center;margin:10px 0 28px;}.skill-detail-intro h2{font-size:21px;margin:0 0 8px}.skill-detail-intro p{font-size:13px;color:var(--fg-50,#777);}.skill-facts{margin:0}.skill-facts>div{display:grid;grid-template-columns:100px 1fr;gap:18px;padding:14px 0;border-bottom:1px solid var(--fg-10,#eee);font-size:13px;}.skill-facts dt{color:var(--fg-50,#777);}.skill-facts dd{margin:0;line-height:1.6;}.skill-bottom-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px;}.share-note{display:block;box-sizing:border-box;width:100%;min-height:92px;padding:12px;border:1px solid var(--fg-10,#ddd);border-radius:8px;font:inherit;margin-top:8px;resize:vertical;}
@media(max-width:1100px){.local-skills-panel{padding:20px;}.skill-row-actions{max-width:160px}.local-skill-row{gap:10px}.skill-info p{font-size:12px}}
'''
head=head.replace('</style>',css+'\n</style>',1)
# Explicit local-state variants; navigation never resets installed content.
state_routes={};state_kinds={}
for personal in [True,False]:
 suffix='PERSONAL' if personal else 'ENT';scope='personal' if personal else 'enterprise'
 base=skills(personal)
 def target(k):return f'P-M06-{k}-{suffix}'
 states=[(v,on,builtin) for v,on in [('none',False),('1.0.0',False),('1.0.0',True),('1.1.0',False),('1.1.0',True)] for builtin in [True,False]]
 routes={}
 for v,on,builtin in states:
  key=f'{v}|{int(on)}|{int(builtin)}'
  template=base if v=='none' else target('INSTALLED') if not on else target('UPDATE') if v=='1.1.0' else target('ENABLED')
  canonical=(v,builtin,on) in [('none',True,False),('none',False,False),('1.0.0',True,False),('1.0.0',True,True),('1.1.0',True,True)]
  sid=(target('BUILTIN-OFF') if v=='none' and not builtin else template) if canonical else f'P-M06-LOCAL-{suffix}-{v.replace(".", "")}-{int(on)}-{int(builtin)}'
  if sid not in scenes:clone(template,sid,meta[template]['title'],'M06')
  e=scenes[sid];e['data-skill-scope']=scope;e['data-skill-state']=key
  statusrows=e.select('.local-skill-row')
  txt(statusrows[0].select_one('.status'),'已启用' if builtin else '已停用')
  txt(statusrows[0].select_one('button'),'停用' if builtin else '启用')
  if v!='none':
   row=statusrows[-1];txt(row.select_one('.status'),'已启用' if on else '已安装 · 未启用');txt(row.select_one('small'),('晨星增长圈 · 晨星增长工作室' if personal else '晨星科技 · 林晓共享')+' · 本机 v'+v)
   buttons=row.select('button');txt(buttons[-1],'停用' if on else '启用')
  banner=e.select_one('.local-success')
  if banner:txt(banner,'已安装到本机 · '+('已启用' if on else '未启用')+' · v'+v)
  routes[key]={'manager':sid};state_kinds[sid]=(scope,key,'manager')
 # Management/detail and removal preserve both built-in preference and installed version.
 for v,on,builtin in states:
  if v=='none':continue
  key=f'{v}|{int(on)}|{int(builtin)}'
  for kind in ['detail','remove']:
   template=target('DETAIL' if kind=='detail' else 'REMOVE')
   sid=template if (v,on,builtin)==('1.0.0',True,True) else f'P-M06-{kind.upper()}-{suffix}-{v.replace(".", "")}-{int(on)}-{int(builtin)}'
   if sid not in scenes:clone(template,sid,meta[template]['title'],'M06')
   e=scenes[sid];e['data-skill-scope']=scope;e['data-skill-state']=key
   if kind=='detail':
    for row in e.select('.skill-facts>div'):
     if row.select_one('dt').get_text()=='版本':txt(row.select_one('dd'),'v'+v)
    card=e.select_one('.skill-info-card')
    if v=='1.1.0' and card:card.clear();card.append(parse('<h3>已是最新版本</h3><p>本机 v1.1.0 · '+('已启用' if on else '未启用')+'</p>'))
   routes[key][kind]=sid;state_kinds[sid]=(scope,key,kind)
 state_routes[scope]=routes
 # Resolve operations in each concrete state.
 for sid,(sc,key,kind) in list(state_kinds.items()):
  if sc!=scope:continue
  v,on,builtin=key.split('|');on=on=='1';builtin=builtin=='1';e=scenes[sid]
  for a in e.select('[data-go]'):
   dest=a['data-go'];label=a.get_text(strip=True)
   destkey=key;destkind=None
   if dest==base:destkind='manager'
   if dest==target('BUILTIN-OFF'):destkey=f'{v}|{int(on)}|{int(not builtin)}';destkind='manager'
   if a.find_parent(class_='local-skill-row')==e.select_one('.local-skill-row') and label in ['停用','启用']:
    destkey=f'{v}|{int(on)}|{int(not builtin)}';destkind='manager'
   elif dest in [target('ENABLED'),target('INSTALLED')]:
    if label in ['停用','启用']:destkey=f'{v}|{int(not on)}|{int(builtin)}'
    destkind='manager'
   elif dest==target('DETAIL'):destkind='detail'
   elif dest==target('REMOVE'):destkind='remove'
   elif dest==target('UPDATE'):destkey=f'1.1.0|{int(on)}|{int(builtin)}';destkind='manager'
   if label=='确认卸载':destkey=f'none|0|{int(builtin)}';destkind='manager'
   if destkind:a['data-go']=routes[destkey][destkind]
# Source loss persists across navigation; retaining a local copy never grants access.
for scope,personal in [('personal',True),('enterprise',False)]:
 suffix='PERSONAL' if personal else 'ENT';sid=f'P-M06-RESTRICTED-{suffix}'
 clone(f'P-M06-INSTALLED-{suffix}',sid,'本机 Skill · 来源失效','M06')
 e=scenes[sid];e['data-skill-scope']=scope;e['data-skill-state']='revoked|0|1'
 row=e.select('.local-skill-row')[-1];txt(row.select_one('.status'),'授权已失效 · 已停用')
 for a in row.select('button'):a.decompose()
 row.select_one('.skill-row-actions').append(parse(btn('重新验证授权',f'P-M06-INSTALLED-{suffix}')+btn('从本机卸载',skills(personal),'button danger')))
 txt(e.select_one('.local-success'),'来源授权失效，本机副本已保留；重新验证成功前不能使用。')
 for a in e.select('[data-go]'):
  if a.get_text(strip=True)=='本机已安装':a['data-go']=sid
  if a.get_text(strip=True) in ['停用','启用']:a.attrs.pop('data-go',None);a.attrs.pop('data-transition',None);a['disabled']=''
 removeid=f'P-M06-REMOVE-RESTRICTED-{suffix}'
 clone(f'P-M06-REMOVE-{suffix}',removeid,'卸载已失效的本机 Skill','M06')
 removal=scenes[removeid];removal['data-skill-scope']=scope;removal['data-skill-state']='revoked|0|1'
 for a in removal.select('[data-go]'):
  if a.get_text(strip=True) in ['取消','本机已安装']:a['data-go']=sid
  if a.get_text(strip=True)=='确认卸载':a['data-go']=skills(personal)
 for a in e.select('[data-go]'):
  if a.get_text(strip=True)=='从本机卸载':a['data-go']=removeid
 if personal:
  for a in scenes['P-M06-LOCAL-RESTRICTED'].select('[data-go]'):
   if a.get_text(strip=True)=='从本机卸载':a['data-go']=removeid
 state_kinds[removeid]=(scope,'revoked|0|1','remove')
 for container in [e,removal]:
  for a in container.select('.assistant-nav-item[data-go]'):
   if a.get_text(strip=True)=='Skill':a['data-go']=sid
 state_routes[scope]['revoked|0|1']={'manager':sid,'detail':sid,'remove':removeid}
 state_kinds[sid]=(scope,'revoked|0|1','manager')
 if personal:scenes['P-M06-LOCAL-RESTRICTED']['data-skill-scope']=scope;scenes['P-M06-LOCAL-RESTRICTED']['data-skill-state']='revoked|0|1'
 else:scenes['P-M06-SKILL-DENIED']['data-skill-scope']=scope;scenes['P-M06-SKILL-DENIED']['data-skill-state']='revoked|0|1'

# Navigation controls carry all declared state-specific destinations. The runtime only
# exposes the route for the current session state; it never invents a scene or outcome.
for sid,e in list(scenes.items()):
 if sid.startswith('P-M01-'):continue
 personal='我的空间' in (e.select_one('#space-name').get_text() if e.select_one('#space-name') else '')
 scope='personal' if personal else 'enterprise';suffix='PERSONAL' if personal else 'ENT';base=skills(personal)
 for a in list(e.select('[data-go]')):
  label=a.get_text(strip=True);dest=a['data-go'];kind=None
  if dest==base and sid not in state_kinds:kind='manager'
  if dest==f'P-M06-INSTALLED-{suffix}' and label in ['安装到本机','重试安装']:kind='install'
  if dest==f'P-M06-INSTALL-{suffix}' and label in ['查看并安装','安装到本机']:kind='source'
  if not kind:continue
  # Replace the original by one route for every valid state, all in the manifest.
  for i,(key,routes) in enumerate(state_routes[scope].items()):
   v,on,builtin=key.split('|');dest=routes['manager']
   if kind=='install':dest=state_routes[scope]['1.0.0|0|'+builtin]['manager'] if v!='revoked' else state_routes[scope][key]['manager']
   if kind=='source':dest=routes.get('detail',f'P-M06-INSTALL-{suffix}')
   cp=copy.deepcopy(a);cp['data-go']=dest;cp['data-skill-route-scope']=scope;cp['data-skill-route-state']=key
   cp.attrs.pop('data-transition',None)
   if i:cp['hidden']=''
   if kind=='source' and v!='none':txt(cp,'管理本机版本')
   a.insert_before(cp)
  a.decompose()
# Real application permission recovery stays with the same enterprise application.
e=scenes['P-M04-PERM-DENIED']
for n in e.find_all(string=True):
 value=str(n).replace('数据报表生成器','合同审查').replace('来自 数据工坊圈','晨星科技 · 企业应用')
 if value!=str(n):n.replace_with(value)
for a in e.select('[data-go="P-M04-APP-VIEW"]'):a['data-go']='P-M04-APP-CONTRACT'
e=scenes['P-M06-SKILL-DENIED']
for n in e.find_all(string=True):
 value=str(n).replace('增长案例检索','销售周报').replace('来自 晨星增长圈','晨星科技 · 林晓共享').replace('来自 北极星设计圈','晨星科技 · 林晓共享').replace('联系创作者','查看企业共享')
 if value!=str(n):n.replace_with(value)
for a in e.select('[data-go^="P-M07-"]'):a['data-go']='P-M06-DISCOVER-ENT'
# New chat keeps the real composer; suggestion cards fill a draft, never send a task.
for sid in ['P-M05-NEW','P-M05-NEW-ENT']:
 e=scenes[sid];intro=e.select_one('.message.assistant p');txt(intro,'把要做的事告诉我，或添加文件一起处理。我会使用当前空间已启用的 Skill。')
 for a in e.select('.question-actions button'):
  if '汇总' in a.get_text():
   a.attrs.pop('data-go',None);a.attrs.pop('data-transition',None);a['data-fill-draft']='请帮我按客户汇总 Q2 报价，并标出需要跟进的项目。';txt(a,'汇总报价')
 for sel in e.select('.composer-footer select'):
  sel.clear();sel.append(parse('<option>自动选择已启用的 Skill</option><option>本次不使用 Skill</option>'));sel['aria-label']='Skill 使用方式'

# Circle fixture uses one creator distributing the same Skill through two circles,
# matching D-PC-09's same-work identity and alternate-source rule.
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 for n in e.find_all(string=True):
  value=str(n).replace('北极星设计圈','晨星设计圈').replace('北极星设计工作室','晨星增长工作室')
  if value!=str(n):n.replace_with(value)
 if sid.startswith('P-M07-'):
  for row in e.select('.circle-work-row'):
   is_skill=bool(row.select_one('.app-art.teal'))
   if not is_skill:continue
   title=row.select_one('h3')
   if title and '会议纪要' in title.get_text():
    txt(title,'增长案例检索');txt(row.select_one('p'),'检索增长方法和可参考的案例')
   # Available via the still-active free circle even if paid source is expired/left.
   if title and title.get_text(strip=True)=='增长案例检索':
    origin=row.select_one('small');txt(origin,'同一 Skill · 晨星增长圈、晨星设计圈')
    if any(k in sid for k in ['EXPIRED','AFTER-LEAVE','RENEW']):
     txt(row.select_one('.status'),'仍由晨星增长圈授权')
     txt(row.select_one('em'),'本圈来源无效；另一个有效来源仍可使用')
 if sid.startswith('P-M06-'):
  for n in e.find_all(string=True):
   if '晨星增长圈 · 晨星增长工作室' in str(n):n.replace_with(str(n).replace('晨星增长圈 · 晨星增长工作室','晨星增长工作室 · 晨星增长圈 / 晨星设计圈'))
  # One representative built-in Skill with full toggle behavior. Avoid an inert
  # second example pretending to have a supported lifecycle.
  for row in list(e.select('.local-skill-row')):
   if row.select_one('h3') and row.select_one('h3').get_text(strip=True)=='会议纪要':row.decompose()
 # Disabled controls are affordances, not declared executable transitions.
 for a in e.select('button[disabled][data-go]'):
  a.attrs.pop('data-go',None);a.attrs.pop('data-transition',None)
# Fix inherited automatic-resume copy to match PC-F10.
for n in scenes['P-M11-OFFLINE-RUNNING'].find_all(string=True):
 if '联网后自动续上' in str(n):n.replace_with(str(n).replace('联网后自动续上','联网后重新确认，再由你决定是否继续'))
# System results are review arrivals, never buttons that manufacture completion.
for sid in ['P-M02-TARGET-LOADING','P-M11-CONTRACT-DL']:
 for a in list(scenes[sid].select('[data-go]')):
  if any(x in a.get_text() for x in ['加载完成','下载完成']):
   a.attrs.pop('data-go',None);a.attrs.pop('data-transition',None);a['disabled']='';txt(a,'正在准备…' if sid=='P-M02-TARGET-LOADING' else '正在下载…')

for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 for n in e.select('.assistant-header p'):
  if '已开启' in n.get_text():txt(n,'我的空间 · 使用已启用的 Skill' if '我的空间' in n.get_text() else '晨星科技 · 使用已启用的 Skill')
# Render SDK feedback over one matching neutral application, without inherited business chrome.
for sid in ['P-M04-PERM-DENIED','P-M09-APP-BANNER']:
 replace_main(sid,str(scenes['P-M04-APP-CONTRACT'].select_one('.workspace-main').decode_contents()),'workspace-main container-mode')
 txt(scenes[sid].select_one('.tab-activate'),'合同审查')
 if scenes[sid].select_one('.tab-activate'):scenes[sid].select_one('.tab-activate')['data-go']='P-M04-APP-CONTRACT'
 if sid=='P-M09-APP-BANNER':
  scenes[sid].select_one('.workspace-main').insert(0,parse('<div class="capability-status" role="status">企业 AI 额度即将用完；当前操作可继续。'+btn('通知管理员','P-M09-ENT-NOTIFY','button quiet')+'</div>'))
for a in scenes['P-M04-PERM-DENIED'].select('.modal-layer [data-go]'):
 a['data-go']='P-M04-APP-CONTRACT'
modal=scenes['P-M06-SKILL-DENIED'].select_one('.modal-layer')
for n in modal.find_all(string=True):
 value=str(n).replace('来源：晨星增长圈 · 需要圈子授权','来源：晨星科技 · 需要企业分发授权').replace('不影响对话其余部分；可以查看企业共享开通授权，或先用已开启的技能。','不影响其他对话。请联系企业管理员确认分发范围，或先使用已有授权的 Skill。')
 if value!=str(n):n.replace_with(value)
replace_main('P-M06-SKILL-DENIED',str(scenes['P-M06-RESTRICTED-ENT'].select_one('.workspace-main').decode_contents()),'workspace-main assistant-mode')
replace_main('P-M04-PREP-FAILED',str(scenes['P-M04-APP-CONTRACT'].select_one('.workspace-main').decode_contents()),'workspace-main container-mode')
modal=scenes['P-M04-PREP-FAILED'].select_one('.modal-layer')
modal.clear();modal.append(parse('<div class="dialog" role="dialog" aria-label="应用加载失败"><div class="dialog-header"><div><h2>暂时无法打开合同审查</h2><p>应用连接中断，请检查网络后重试。</p></div></div><div class="dialog-footer">'+btn('返回首页','P-M03-HOME-ENT')+btn('重新加载','P-M04-APP-CONTRACT','button primary')+'</div></div>'))
meta['P-M04-PREP-FAILED']['title']='应用加载失败 · 合同审查'
meta['P-M04-PREP-FAILED']['annotation']='应用连接失败保留明确的重试/返回；不再把Web应用当作需要安装旧版的软件包。'
for sid,e in scenes.items():
 for row in e.select('[data-search-text]'):row['data-search-text']=row.get_text(' ',strip=True)

# Focusing an active SDK instance retains its task and conditional close semantics.
scenes['P-M04-APP-ACTIVE'].select_one('.tab-activate')['data-go']='P-M04-APP-ACTIVE'
for sid in ['P-M04-APP-ACTIVE','P-M04-CLOSE-ACTIVE','P-M04-TERM-FAILED','P-M04-BACKGROUND']:
 scenes[sid]['data-app-task']='active'
scenes['P-M03-HOME-ENT-AFTER-CLOSE']['data-app-task']='idle'
clone('P-M04-APP-REPORT','P-M04-REPORT-STOPPED','数据报表生成器 · 后台请求已停止','M04')
scenes['P-M04-REPORT-STOPPED'].select_one('.workspace-main').insert(0,parse('<div class="capability-status" role="status">数据报表生成器的后台请求已停止。</div>'))
for row in scenes['P-M04-RUNTIME-PERSONAL'].select('.runtime-row'):
 if '数据报表生成器' not in row.get_text():continue
 for a in row.select('[data-go]'):
  if a.get_text(strip=True)=='打开':a['data-go']='P-M04-APP-REPORT'
  elif a.get_text(strip=True)=='停止':a['data-go']='P-M04-REPORT-STOPPED'
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 for a in list(e.select('[data-go="P-M04-APP-VIEW"]')):
  a['data-app-route']='idle';cp=copy.deepcopy(a);cp['data-go']='P-M04-APP-ACTIVE';cp['data-app-route']='active';cp['hidden']='';cp.attrs.pop('data-transition',None);a.insert_after(cp)

# Enterprise background example is the enterprise contract app; personal report remains separate.
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 space=e.select_one('#space-name')
 if space and '晨星科技' in space.get_text():
  for n in e.select('.runtime-row,.notification-item,.notification-row,.notification-popover'):
   for textnode in n.find_all(string=True):
    if '数据报表生成器' in str(textnode):textnode.replace_with(str(textnode).replace('数据报表生成器','合同审查'))
# Reconcile declared operations with final DOM; preserve prior transition IDs where possible.
changed=[]
for sid,e in scenes.items():
 if sid.startswith('P-M01-'):continue
 transitions=[];used=set()
 for i,a in enumerate(e.select('[data-go]')):
  tid=a.get('data-transition','')
  if not tid or sid not in tid or tid in used:tid=f'T-{sid}-R6-{i:03d}'
  used.add(tid);a['data-transition']=tid
  label=a.get('aria-label') or a.get_text(' ',strip=True) or '打开'
  transitions.append(dict(id=tid,label=label,to=a['data-go'],feedback=f'{label}；显示{meta.get(a["data-go"],{}).get("title",a["data-go"])}'))
 meta[sid]['transitions']=transitions
 meta[sid]['status']='suggested'
 # Existing anchors removed along with superseded panels are explicitly panel-only.
 for an in meta[sid].get('annotations',[]):
  if an.get('anchor') and not e.select(f'[data-review-anchor="{an["anchor"]}"]'):an['anchor']=None
 changed.append(sid)
# Existing shared scroll/protocol runtime stays unchanged; local search is not a scenario switch.
searchjs='''<script>
(()=>{
const state={personal:'none|0|1',enterprise:'none|0|1'};let active=null,appTask='idle';
function refresh(){const s=document.querySelector('.scene.active');if(!s)return;if(active!==s){active=s;if(s.dataset.appTask)appTask=s.dataset.appTask;if(s.dataset.skillScope&&s.dataset.skillState)state[s.dataset.skillScope]=s.dataset.skillState;}s.querySelectorAll('[data-app-route]').forEach(el=>{el.hidden=el.dataset.appRoute!==appTask;});s.querySelectorAll('[data-skill-route-state]').forEach(el=>{const hide=el.dataset.skillRouteState!==state[el.dataset.skillRouteScope];if(el.hidden!==hide)el.hidden=hide;});const personal=s.querySelector('#space-name')?.textContent.includes('我的空间');const [version,enabled,builtin]=state[personal?'personal':'enterprise'].split('|');const options=['自动选择已启用的 Skill','本次不使用 Skill'];if(builtin==='1')options.push('资料研究 · Polo 内置');if(version!=='none'&&enabled==='1')options.push(personal?'增长案例检索 · 圈子提供':'销售周报 · 企业共享');s.querySelectorAll('.composer-footer select').forEach(sel=>{const value=sel.value;const next=JSON.stringify(options);if(sel.dataset.optionSet!==next){sel.replaceChildren(...options.map(name=>new Option(name,name)));sel.dataset.optionSet=next;if(options.includes(value))sel.value=value;sel.setAttribute('aria-label','Skill 使用方式');}});}
new MutationObserver(refresh).observe(document.querySelector('[data-product-surface]'),{subtree:true,attributes:true,attributeFilter:['class']});refresh();
window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='product-ui-prototype:reset'){state.personal=state.enterprise='none|0|1';appTask='idle';active=null;document.querySelectorAll('[data-search-text]').forEach(e=>e.hidden=false);document.querySelectorAll('[data-search-empty]').forEach(e=>e.hidden=true);refresh();}});
document.addEventListener('input',e=>{if(!e.target.matches('[data-skill-search]'))return;const p=e.target.closest('.local-skills-panel');const q=e.target.value.trim().toLocaleLowerCase();let count=0;p.querySelectorAll('[data-search-text]').forEach(row=>{row.hidden=!row.dataset.searchText.toLocaleLowerCase().includes(q);if(!row.hidden)count++});p.querySelector('[data-search-empty]').hidden=count>0;});
document.addEventListener('click',e=>{const draft=e.target.closest('[data-fill-draft]');if(draft){const input=draft.closest('.scene').querySelector('textarea');input.value=draft.dataset.fillDraft;input.focus();}const send=e.target.closest('.composer-send');if(send){const input=send.closest('form')?.querySelector('textarea');if(input&&!input.value.trim()){e.stopImmediatePropagation();e.preventDefault();input.focus();input.placeholder='先输入要交给助手的任务';}}},true);
})();
</script>''' 
tail=tail.replace('</body>',searchjs+'\n</body>')
(B/'prototype.html').write_text(head+''.join(raws[sid] if sid.startswith('P-M01-') else str(e).replace('viewbox=','viewBox=')+'\n' for sid,e in scenes.items())+tail)
m['scenes']=[meta[sid] for sid in scenes];m['revision']=REV
m['summary']=['桌面壳只负责空间、标签与按需能力反馈；应用点击即打开。','Skill 仅供内置助手使用，区分来源、本机安装和启用。','企业共享支持同事获取与提交；个人圈子补充个人内容。','本轮为用户授权的推荐方案；修改待复看，非产品实现或验收。']
m['change']={'previous_revision':old['revision'],'changed_scenes':changed,'removed_scenes':[],'summary':'按本轮用户要求理顺桌面容器和本机 Skill 管理，修复跨空间与应用身份跳转。'}
sourcepath='docs/mvp-complete-flow-hifi/sources/desktop-container-brief-r6.md'
m['sources'].append(dict(id='desktop-brief-r6',label='本轮用户输入、调研与推荐',revision='desktop-ux-r6',path=sourcepath,sha256=hashlib.sha256((ROOT/sourcepath).read_bytes()).hexdigest()))
review=dict(source='desktop-review-r6',item='desktop-container-local-skills',revision='desktop-ux-r6',current='普通应用被当作任务运行；本机安装与来源授权混合，部分跳转跨空间。',target='应用即开即用；Skill 在助手内管理本机副本；企业共享与个人圈子独立。',reason='匹配 macOS Electron 容器、非技术员工与组织复用的产品定位。',question='应用打开/关闭、本机 Skill 生命周期与企业/圈子内容获取是否符合实际使用？')
p=B/'sources/desktop-review-r6.json';p.write_text(json.dumps(review,ensure_ascii=False,indent=2)+'\n');m['sources'].append(dict(id='desktop-review-r6',label='本轮差异复看',revision='desktop-ux-r6',path=str(p.relative_to(ROOT)),sha256=hashlib.sha256(p.read_bytes()).hexdigest()));m['review']=review
# Explicit review entry for independent system states; do not fabricate product controls.
entries={e['scene']:e for e in m.get('review_entries',[])}
for sid in ['P-M04-PREPARE','P-M04-APP-ACTIVE','P-M04-PERM-DENIED','P-M06-SKILL-DENIED','P-M06-INSTALL-FAILED','P-M06-LOCAL-RESTRICTED']:
 entries[sid]=dict(scene=sid,reason=meta[sid]['annotation'])
# Preserve legacy scene access if removal of an artificial mandatory step disconnects it.
for s in m['scenes']:
 if s['id']!=m['start_scene'] and not any(t['to']==s['id'] for x in m['scenes'] for t in x['transitions']):entries.setdefault(s['id'],dict(scene=s['id'],reason='独立检查此系统状态及恢复路径；不作为正常操作的必经步骤。'))
def story(sid,title,description,ids):
 steps=[]
 for i,scene in enumerate(ids):
  step=dict(id=f'{sid}-{i+1:02d}',scene=scene,description=meta[scene]['title'])
  if i and not any(t['to']==scene for t in meta[ids[i-1]]['transitions']):
   step['arrival']='review';entries.setdefault(scene,dict(scene=scene,reason='独立查看此状态，不通过产品按钮模拟系统结果。'))
  steps.append(step)
 return dict(id=sid,title=title,description=description,steps=steps)
m['stories']=[story('S-DESKTOP','企业员工 · 打开工作应用','企业应用直接打开和关闭；助手作为内置应用完成开放式任务。',['P-M03-HOME-ENT','P-M04-APP-CONTRACT','P-M03-HOME-ENT','P-M03-ALL-APPS-ENT','P-M05-NEW-ENT']),story('S-LOCAL-SKILLS','个人 · 从圈子获取并管理 Skill','圈子提供内容；安装、启用、更新和卸载都管理这台 Mac 上的副本。',['P-M03-HOME-PERSONAL','P-M07-LIST','P-M07-DETAIL-FOCUS','P-M06-INSTALL-PERSONAL','P-M06-INSTALLED-PERSONAL','P-M06-ENABLED-PERSONAL','P-M06-DETAIL-PERSONAL','P-M06-UPDATE-PERSONAL','P-M06-DETAIL-PERSONAL-110-1-1','P-M06-REMOVE-PERSONAL-110-1-1','P-M06-SKILLS-PERSONAL']),story('S-TEAM-SKILLS','企业 · 复用同事 Skill','企业共享不混入个人圈子；安装后明确启用。',['P-M03-HOME-ENT','P-M06-SKILLS','P-M06-DISCOVER-ENT','P-M06-INSTALL-ENT','P-M06-INSTALLED-ENT','P-M06-ENABLED-ENT','P-M05-NEW-ENT']),story('S-TEAM-SHARE','企业 · 分享工作方法','提交企业审核不代表已经发布给同事。',['P-M06-DISCOVER-ENT','P-M06-SHARE-ENT','P-M06-SHARE-SUBMITTED','P-M06-DISCOVER-ENT']),story('S-CAPABILITY','按需授权与后台任务','能力调用的系统状态从评审入口进入；普通打开没有这些步骤。',['P-M04-APP-CONTRACT','P-M04-PREPARE','P-M04-APP-CONTRACT','P-M04-APP-ACTIVE','P-M04-CLOSE-ACTIVE','P-M04-BACKGROUND'])]+m['stories']
# Repair legacy story steps where removed artificial operations used to be mandatory.
for st in m['stories']:
 for i,step in enumerate(st['steps']):
  if i and not any(t['to']==step['scene'] for t in meta[st['steps'][i-1]['scene']]['transitions']):step['arrival']='review';entries.setdefault(step['scene'],dict(scene=step['scene'],reason='单独复看已有状态；本轮不将其强行串入正常应用打开流程。'))
m['review_entries']=list(entries.values());m['default_story']='S-DESKTOP'
for module in m['modules']:
 if module['id']=='M04':module['title']='应用容器与按需能力'
 if module['id']=='M06':module['title']='本机 Skill 与助手能力'
for scene in m['scenes']:
 scene['title']=scene['title'].replace('北极星设计圈','晨星设计圈')
 scene['annotation']=scene['annotation'].replace('北极星设计圈','晨星设计圈')
(B/'prototype-manifest.json').write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
print(f'{REV}: {len(scenes)} scenes, {len(changed)} affected desktop/shared scenes; login preserved.')
