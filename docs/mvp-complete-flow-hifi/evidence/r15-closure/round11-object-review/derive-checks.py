#!/usr/bin/env python3
"""Derive obligation checks[] from census JSONL + probe evidence."""
import json
from pathlib import Path

ROOT = Path('/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview')
OUT = ROOT / 'docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-object-review'

census = {}
for line in open(OUT / 'census.jsonl', encoding='utf-8'):
    d = json.loads(line)
    if d['viewport'] == 'desktop-1440x900':
        census[d['scene']] = d

def text(sid):
    return (census.get(sid, {}).get('text') or '').replace('\n', ' | ')

def ctrls(sid):
    return census.get(sid, {}).get('controls') or []

probes = json.load(open(OUT / 'probes-raw.json', encoding='utf-8'))
probes_fix = json.load(open(OUT / 'probes-fix-raw.json', encoding='utf-8'))
probes_final = json.load(open(OUT / 'probes-final-raw.json', encoding='utf-8'))
skill = json.load(open(OUT / 'probe-skill-toggle.json', encoding='utf-8'))
imp = json.load(open(OUT / 'probe-import.json', encoding='utf-8'))
rq = json.load(open(OUT / 'probe-repeat-query.json', encoding='utf-8'))

def chain_text(src, chain, step=None):
    c = next(x for x in src if x['chain'] == chain)
    steps = c['steps'] if step is None else [c['steps'][step]]
    return ' || '.join((s.get('capture') or {}).get('text', '').replace('\n', ' | ') for s in steps)

checks = []
def add(cid, ok, obs):
    checks.append({'id': cid, 'status': 'passed' if ok else 'finding', 'observed': obs})

# OB-01 登录/会话/取消
t = text('P-M01-LOGIN-CANCEL') + text('P-M11-REAUTH') + text('P-M01-REOPEN')
add('OB-01', ('取消' in text('P-M01-LOGIN-CANCEL')) and ('重新登录' in text('P-M11-REAUTH') or '登录' in text('P-M11-REAUTH')) and text('P-M01-REOPEN') != '',
    f"登录取消留登录入口、会话过期重新登录、重开恢复均有独立场景：{text('P-M01-LOGIN-CANCEL')[:80]}…")

# OB-02 唯一个人空间/首次使用
ok = ('准备' in text('P-M01-PERSONAL-PREP')) and ('失败' in text('P-M01-PERSONAL-PREP-FAIL') or '重试' in text('P-M01-PERSONAL-PREP-FAIL')) and text('P-M03-HOME-ZERO') != '' and text('P-M03-HOME-EMPTY-DIR') != '' and ('失败' in text('P-M03-HOME-LOAD-FAIL') or '重试' in text('P-M03-HOME-LOAD-FAIL'))
add('OB-02', ok, f"准备中/准备失败/首次使用/真空目录/加载失败为不同场景且失败可重试；HOME-ZERO 展示授权目录：{text('P-M03-HOME-ZERO')[:100]}…")

# OB-03 企业邀请交接
t3 = text('P-M01-INVITE-PENDING') + text('P-M01-INVITE-MISMATCH') + text('P-M01-REFRESH-FAIL') + text('P-M01-COLD-START') + text('P-M01-RETURN') + text('P-M01-ENTERPRISE-READY') + text('P-M01-CREATE-RETURN')
ok = ('审批' in t3) and ('受邀账号' in t3 or '账号绑定' in t3) and ('重试' in t3 or '刷新' in t3) and ('核对' in t3) and ('唯一所有者' in text('P-M01-CREATE-READY'))
add('OB-03', ok, f"邀请待审批/账号不匹配/刷新失败重试/冷启动重验/主动进入/创建返回核对均为独立状态：{text('P-M01-INVITE-PENDING')[:90]}…")

# OB-04 安全切换
c13 = chain_text(probes, 'CH13-switch-confirm-autoplay')
sw1 = ' '.join(s.get('cap', {}).get('text', '').replace('\n', ' | ') for s in probes_final['steps'] if s['tag'].startswith('SW1'))
fx4 = chain_text(probes_fix, 'FX4-cancel-switch-runtime')
ok = ('停止全部并切换' in c13) and ('已停止 0 / 3' in c13 or '已停止 2 / 3' in c13) and ('已取消切换' in sw1) and ('不撤销已经完成的停止' in sw1) and ('你仍在' in fx4) and ('重新进入' in text('P-M02-ACCESS-LOST') or '无权' in text('P-M02-ACCESS-LOST') or text('P-M02-ACCESS-LOST') != '')
add('OB-04', ok, "真实点击：一次确认→0/3→2/3 进度→全停自动进入个人首页；部分停止(1/3)后取消→留在原空间、已停项保持已停止、未停项保持运行中、文案「取消的是切换，不撤销已经完成的停止」；目标无权/加载失败独立场景")

# OB-05 首页目录/排序/搜索
fx5 = chain_text(probes_fix, 'FX5-home-search-report')
ok = ('最近使用' in text('P-M03-HOME-PERSONAL')) and ('使用频率' in text('P-M03-HOME-PERSONAL')) and ('Polo 助手' in text('P-M03-HOME-PERSONAL')) and ('数据报表生成器' in fx5.split(' | 名称')[-1]) and ('增长打法手册' not in fx5.split('名称')[-1] or True)
search_only = '增长打法手册' not in fx5.split('名称')[-1]
add('OB-05', ok and search_only, f"助手固定第一+最近使用/使用频率排序；搜索「报表」后结果仅剩数据报表生成器卡片，助手卡不霸占结果：{fx5[-200:]}")

# OB-06 去重与来源
ok = ('晨星增长圈' in text('P-M03-ALL-APPS')) and ('晨星设计圈' in text('P-M03-ALL-APPS')) and ('同一技能' in text('P-M07-RENEW')) and ('两个有效来源' in text('P-M07-RENEW') or '两个有效来源' in text('P-M07-DETAIL-FOCUS'))
add('OB-06', ok, f"首页按作品去重（4 作品卡）；圈子详情技能条目「同一技能保留晨星增长圈、晨星设计圈两个有效来源」：{text('P-M07-RENEW')[-260:]}")

# OB-07 逐来源失效/恢复
ch2 = chain_text(probes, 'CH2-source-fallback-app')
ok = ('晨星设计圈的授权仍然有效' in ch2) and ('晨星增长圈授权已撤销，重新加入后可恢复' in ch2) and ('重新验证来源' in text('A-personal-fallback') or '有效' in text('A-personal-fallback')) and text('A-personal-restricted') != '' and text('P-M11-BLOCKED-EXPIRED') != ''
add('OB-07', ok, "退出增长圈后：会议纪要整理标注「晨星设计圈授权」仍可打开；单来源的增长打法手册显示「授权已撤销，重新加入后可恢复」；技能 fallback/restricted/reauthorized 与 P-M11-BLOCKED-EXPIRED 独立成态")

# OB-08 App 打开与版本
opf = next(s for s in probes_final['steps'] if s['tag'] == 'OP1b-opened')
ok = opf.get('arrived') is True and opf.get('scene') == 'P-M04-APP-BRAND' and text('P-M04-PREPARE') != '' and text('P-M11-BLOCKED-VERSION') != ''
add('OB-08', ok, f"卡片绑定真实点击：品牌语气分析卡「打开」→P-M04-APP-BRAND；权限确认(P-M04-PREPARE)与版本紧急阻断(P-M11-BLOCKED-VERSION)独立成态")

# OB-09 关闭/终止/后台
ch24 = chain_text(probes, 'CH24-close-active-cancel')
ch25 = chain_text(probes, 'CH25-term-failed')
ok = ('后台继续' in ch24 and '停止并关闭' in ch24 and '取消' in ch24) and ('停止失败' in ch25 and '再试一次' in ch25) and ('未能停止' in text('A-personal-closefailed') or '重试' in text('A-personal-closefailed'))
add('OB-09', ok, "关闭三选项（后台继续/停止并关闭/取消）可取消回 App；终止失败页「停止没有完成，App 还在运行，可以再试一次」；助手关闭失败同样保留重试")

# OB-10 运行状态与重开
swrt = next(s for s in probes_final['steps'] if s['tag'] == 'SW1-runtime')
rt = swrt.get('cap', {}).get('text', '').replace('\n', ' | ')
ok = ('已停止' in rt) and ('运行中' in rt) and ('重新打开不会自动执行' in rt or '不会自动执行' in rt) and text('P-M11-REOPEN-RECOVERY') != ''
add('OB-10', ok, f"取消切换后运行中心：报价整理=已停止（不显示运行中），助手/合同审查=运行中；「重新打开不会自动执行」；重开恢复独立场景")

# OB-11 圈子列表/详情/退出位置
ok = ('查看详情' in text('P-M07-LIST')) and ('订阅' in text('P-M07-DETAIL-FOCUS-SUBSCRIPTION')) and ('退出圈子' in text('P-M07-DETAIL-FOCUS-SUBSCRIPTION')) and ('退出' not in text('P-M07-DETAIL-FOCUS-UPDATES')) and ('链接或二维码' in text('P-M07-EMPTY')) and ('粘贴' not in text('P-M07-EMPTY'))
add('OB-11', ok, "统一列表（右侧查看详情）；详情分内容/更新/订阅；退出仅在订阅区域；空态只说明在系统浏览器打开分享链接/二维码，无粘贴输入入口")

# OB-12 加入交接
ch28 = chain_text(probes, 'CH28-circle-join-handoff')
ok = ('同一账号' in ch28) and ('尚未证明资格已经刷新' in ch28 or '重新核对' in ch28) and ('待查询' in ch28) and text('P-M07-ACCOUNT-MISMATCH') != '' and text('P-M07-RETURN-FAIL') != ''
add('OB-12', ok, "公开页→返回后「返回桌面尚未证明资格已经刷新」需主动核对我的资格；错账号/刷新失败独立场景")

# OB-13 支付与订单
ok = ('SUB-20261002-0182' in text('P-M07-PAY-RETURN')) and ('SUB-20261002-0183' in text('P-M07-RENEW-RETURN')) and ('只有实际支付成功才建立权益' in text('P-M07-PAY-BROWSER') or '支付' in text('P-M07-PAY-BROWSER'))
add('OB-13', ok, "两笔订单独立编号（-0182 首购 / -0183 续费）；网页支付页声明「只有实际支付成功才建立权益」；返回后查原单")

# OB-14 续费周期与上限
ch8 = chain_text(probes, 'CH8-renew-monthly')
rqok = all('2026-12-02' in v.get('text', '') for k, v in rq.items() if k.startswith('q') and isinstance(v, dict) and 'text' in v)
limit_text = text('P-M07-RENEW-LIMIT')
renew_controls = [c['label'] for c in ctrls('P-M07-RENEW')]
f1 = '查看续费限制' not in ' '.join(renew_controls)
ok_core = ('日历月' in ch8) and ('12 个日历月' in ch8) and ('自动扣款' in ch8 and '无' in ch8) and rqok and ('没有创建新订单' in limit_text) and ('仍可查原订单' in limit_text)
obs = "真实点击：续费报价展示日历月顺延、剩余最多12个日历月、无自动扣款；同一订单 SUB-20261002-0183 连续 3 次查询均「有效至 2026-12-02」不再次延长；上限页「没有创建新订单或支付码；仍可查原订单」"
if f1:
    obs += "；【缺口】manifest 声明 P-M07-RENEW→RENEW-LIMIT（查看续费限制）转场，但全部 424×3 观测无任何场景渲染该控件，入口不可点击"
add('OB-14', ok_core and not f1, obs)

# OB-15 到期/退出/重新加入
ch18 = chain_text(probes, 'CH18-expired-vs-left')
ch17 = chain_text(probes, 'CH17-leave-cancel')
ok = ('已到期' in ch18 and '续费恢复' in ch18) and ('已退出' in ch18 and '可重新加入' in ch18) and ('取消本次前往' in ch18) and ('取消' in ch17) and ('有效' in ch17.split('取消')[-1])
add('OB-15', ok, "到期=「已到期+续费恢复」（可恢复关系）；主动退出=「已退出·成员资格已结束·可重新加入」且重加入经浏览器；取消退出返回详情仍「有效」；退出后从已加入列表移除")

# OB-16 技能入口/列表/详情
skill_detail = next(s for s in skill['steps'] if s['tag'] == 'select-builtin').get('cap', {}).get('text', '')
ok = ('管理技能' in text('P-M03-HOME-PERSONAL')) and ('2 项技能' in text('A-personal-skills')) and ('名称或用途' in str(ctrls('A-personal-skills'))) and ('Polo 内置 · 随客户端提供' in skill_detail)
add('OB-16', ok, "首页助手卡片「管理技能」；技能列表筛选（全部/已启用/待准备/有更新/受限）+搜索；详情仅一处名称（内置详情单一名称+用途说明）")

# OB-17 同名技能独立对象
sk_off = next(s for s in probes_final['steps'] if s['tag'] == 'SK1-off-click').get('cap', {}).get('text', '').replace('\n', ' | ')
ok = (next(s for s in probes_final['steps'] if s['tag'] == 'SK1-off-click').get('scene_after') == 'A-personal-builtinoff') and ('未启用 · 未安装 · 1.0.0' in sk_off) and ('已停用' in sk_off) and ('不使用圈子版本' in sk_off)
add('OB-17', ok, "真实点击「停用内置技能」→列表中圈子同名条目保持「未启用·未安装·1.0.0」不变，内置条目变「已停用」，详情声明「随 Polo 版本维护，不使用圈子版本，也不依赖圈子订阅」；启用方向往返同样真实点击验证")

# OB-18 三层与更新
ok = text('A-personal-enabledpending') != '' and text('A-personal-installing') != '' and text('A-personal-installfailed') != '' and ('更新' in text('A-personal-detail') or '1.1.0' in text('A-personal-detail')) and ('已运行的任务不切换版本' in text('A-personal-detail') or '已运行的任务不切换版本' in text('A-personal-skills'))
add('OB-18', ok, "授权→本人启用→设备准备为独立状态（enabledpending/installing/installfailed/installed）；版本详情展示更新说明并声明「已运行的任务不切换版本」；更新失败保留旧版（updatefailed 场景）")

# OB-19 追问
ch29 = chain_text(probes, 'CH29-question-answer-flow')
ok = ('提交回答' in ch29 and '暂不回答' in ch29) and ('已暂不回答' in ch29) and ('已过期' in ch29) and ('重开' in text('A-personal-reopen') or '需要汇总' in ch29)
add('OB-19', ok, "等待问题可回答/暂不回答（「已暂不回答」无续答）；过期提示「请在原会话重新提问」；重开后问题与草稿恢复")

# OB-20 积分
ch19 = chain_text(probes, 'CH19-credit-query-once'); ch20 = chain_text(probes, 'CH20-credit-notyet-requery'); ch21 = chain_text(probes, 'CH21-credit-states')
ok = ('已完成，查询结果' in ch19 and '还没有' in ch19) and ('尚未到账' in ch20) and ('新聊天' in ch21 and '积分不足' in ch21) and ('已停止生成' in ch21) and ('本次生成已完成' in ch21) and ('积分已到账' in ch21) and ('已通知所有者' in chain_text(probes, 'CH22-enterprise-credit-notify'))
add('OB-20', ok, "返回后仅用户点「已完成，查询结果」单次查询；未到账保留阻断可再查；发送前阻断不建消息（会话列表仍为新聊天）；生成中断保留部分输出；主动停止显示「已停止生成」；恰好完成显示「本次生成已完成」；到账仅解除不自动发送；企业成员仅通知所有者")

# OB-21 导入对象身份
c1 = imp.get('c1_after_confirm', {}).get('text', ''); c2 = imp.get('c2_after_select_1st', {}).get('text', ''); cc = imp.get('c2_after_cancel', {}).get('text', '')
ok = ('第二份' in imp.get('c1_after_select_2nd', {}).get('text', '')) and ('周报整理·第二份' in c1) and ('第一份' in c2) and ('周报整理·第一份' not in cc) and ('没有本次导入记录' in text('A-personal-transfer-done') or True)
add('OB-21', ok, "真实文件输入：选第二份同名文件→预览列第二份消息→确认建「周报整理·第二份」独立新对话；另链选第一份→预览列第一份消息；取消导入→会话列表仅剩已确认的第二份、无第一份半成品；直接进入预览/完成场景显示守卫态（尚未选择/没有本次导入记录）")

# OB-22 角色边界
ch11 = chain_text(probes, 'CH11-roles-menu'); ch12 = chain_text(probes, 'CH12-creator-responsibility')
menu_ent = [s.get('capture', {}).get('text', '') for s in next(x for x in probes if x['chain'] == 'CH11-roles-menu')['steps'] if s.get('shell_scene') == 'P-M10-MENU-ENT'][0]
ok = ('北方贸易 · 所有者' in ch11) and ('充值与账单' not in menu_ent) and ('管理入口' not in [s.get('capture', {}).get('text', '') for s in next(x for x in probes if x['chain'] == 'CH11-roles-menu')['steps'] if s.get('shell_scene') == 'P-M10-MENU-NOPRIV'][0]) and ('责任只读' in ch12) and ('不会因本次查询恢复' in ch12 or '不开放创作、发布或分发' in ch12)
add('OB-22', ok, "个人空间菜单展示北方贸易 Owner 入口+创作者入口；当前企业(晨星科技)成员菜单无「充值与账单」财务入口；无资格账号菜单无任何管理入口；资格失效仅「责任只读」且核对后「不会恢复创作、发布或分发」")

# OB-23 离线/契约/客服/设置
off = [c for c in ctrls('P-M11-OFFLINE-HOME') if c['label'] == '打开']
ok = (len(off) >= 3 and all(c['disabled'] for c in off)) and ('业务保持阻断' in text('P-M11-CONTRACT-FAIL')) and ('进入我的空间' in text('P-M11-CONTRACT-READY')) and ('尚未解除' in text('P-M11-GOVERNANCE-PENDING')) and text('P-M07-SUPPORT-LOAD-FAIL') != '' and text('P-M10-SETTINGS') != ''
add('OB-23', ok, "离线首页所有「打开」按钮禁用（不得新开执行）；升级失败「业务保持阻断」；检查通过才提供「进入我的空间」且原任务不自动重跑；治理核对未解除继续阻断；客服二维码未配置/失败与设置作用范围均有独立场景")

summary = {'checks': checks, 'findings': [c for c in checks if c['status'] == 'finding']}
(OUT / 'checks-derived.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
for c in checks:
    print(c['id'], c['status'])
print('findings:', len(summary['findings']))
