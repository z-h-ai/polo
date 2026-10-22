#!/usr/bin/env python3
"""round10-object-review 对象与权限探测：真实点击的连续链（每条链独立 Reset）。
每步点击原型内已渲染的 data-transition 按钮，等待声明目标场景（含系统自动推进）。
只读评审：除本评审目录外不写任何文件。"""
import json, time, sys
from playwright.sync_api import sync_playwright

ROOT = '/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'
OUT = f'{ROOT}/docs/mvp-complete-flow-hifi/evidence/r15-closure/round10-object-review'
RAW = f'{OUT}/raw'

# 每条链：reset 后从 start 开始，依序执行 steps；click=转场按钮 data-transition 前缀匹配
# wait_auto_ms：到达 step 场景后继续观察系统自动推进的时间窗
CHAINS = [
 {"id": "PR1-source-fallback-leave-free-circle", "obligation": "PC-F03/08/D-PC-09 逐来源失效：退出增长圈后共享作品仍可用", "start": "P-M07-DETAIL-FOCUS-SUBSCRIPTION",
  "steps": [
    {"click": "确认退出", "expect": "P-M07-SOURCE-FALLBACK", "note": "免费圈确认退出"},
    {"click": "打开", "expect": "P-M04-APP-REPORT", "note": "多来源作品（会议纪要）仍可打开"},
  ]},
 {"id": "PR2-cancel-leave-then-leave-paid", "obligation": "C-R04 取消退出不变更资格；退出付费圈后唯一来源应用只能重新加入", "start": "P-M07-DETAIL-PAID-SUBSCRIPTION",
  "steps": [
    {"click": "退出圈子", "expect": "P-M07-LEAVE-PAID", "note": "打开退出确认"},
    {"click": "取消", "expect": "P-M07-DETAIL-PAID", "note": "取消退出"},
    {"click": "退出圈子", "expect": "P-M07-LEAVE-PAID", "note": "再次打开退出确认"},
    {"click": "确认退出", "expect": "P-M07-DETAIL-PAID-AFTER-LEAVE", "note": "确认退出后详情"},
    {"click": "打开", "expect": "P-M04-APP-VIEW-PERSONAL", "note": "仍有多来源的会议纪要可打开"},
  ]},
 {"id": "PR3-renew-order-repeat-query", "obligation": "PC-F03/S-015 手动续费：重复查询同一订单不再次延长；取消新报价不改已购权益", "start": "P-M07-RENEW",
  "steps": [
    {"click": "取消", "expect": "P-M07-DETAIL-PAID", "note": "取消续费报价"},
    {"click": "续费", "expect": "P-M07-RENEW", "note": "重新打开续费"},
    {"click": "去浏览器支付", "expect": "P-M07-RENEW-WEB", "note": "跨端交接"},
    {"click": "返回 Polo", "expect": "P-M07-RENEW-RETURN", "note": "返回桌面核对原单"},
    {"click": "查询原订单和资格", "expect": "P-M07-RENEW-RESULT", "note": "第 1 次查询"},
    {"click": "查看原订单", "expect": "P-M07-RENEW-RETURN", "note": "再查原单"},
    {"click": "查询原订单和资格", "expect": "P-M07-RENEW-RESULT", "note": "第 2 次查询同一订单"},
  ]},
 {"id": "PR4-renew-limit-still-queryable", "obligation": "PC-F03 达提前购买上限不建新单仍可查原单", "start": "P-M07-RENEW",
  "steps": [
    {"click": "查看续费限制", "expect": "P-M07-RENEW-LIMIT", "note": "达上限提示"},
    {"click": "查看原订单", "expect": "P-M07-RENEW-RETURN", "note": "仍可查原订单"},
    {"click": "查询原订单和资格", "expect": "P-M07-RENEW-RESULT", "note": "原单核对"},
  ]},
 {"id": "PR5-builtin-vs-circle-skill", "obligation": "PC-F04/§13.13 同名内置与圈子技能独立；停用内置不影响圈子技能", "start": "A-personal-skills",
  "steps": [
    {"click": "停用内置技能", "expect": "A-personal-builtinoff", "note": "停用内置资料研究"},
    {"click": "启用内置技能", "expect": "A-personal-builtinon", "note": "重新启用内置"},
    {"click": "为我停用", "expect": "A-personal-installed", "note": "圈子技能本人停用"},
  ]},
 {"id": "PR6-restricted-uninstall-no-restore", "obligation": "PC-F04/PC-F08 资格失效：卸载/取消不恢复资格；内置同名不受影响", "start": "A-personal-restricted",
  "steps": [
    {"click": "卸载本机副本", "expect": "A-personal-restricted-remove", "note": "打开卸载确认"},
    {"click": "取消", "expect": "A-personal-restricted", "note": "取消卸载仍受限"},
    {"click": "卸载本机副本", "expect": "A-personal-restricted-remove", "note": "再次打开卸载确认"},
    {"click": "确认卸载", "expect": "A-personal-restricted-uninstalled", "note": "卸载后仍不可调用"},
  ]},
 {"id": "PR7-transfer-import-cancel-vs-confirm", "obligation": "C-R07 取消不建对象；确认后建立独立新对话", "start": "A-personal-transfer-import",
  "steps": [
    {"click": "选择导出文件", "expect": "A-personal-transfer-preview", "note": "选择文件进入核对"},
    {"click": "取消导入", "expect": "A-personal-conversation", "note": "取消导入"},
    {"click": "导入对话内容", "expect": "A-personal-transfer-import", "note": "重新进入导入（经会话入口，若无可达则记录）", "optional": True},
    {"click": "选择导出文件", "expect": "A-personal-transfer-preview", "note": "再次选择文件", "optional": True},
    {"click": "确认导入", "expect": "A-personal-transfer-done", "note": "确认导入建立新对象"},
    {"click": "打开导入对话", "expect": "A-personal-conversation", "note": "打开结果属于所选文件"},
  ]},
 {"id": "PR8-cancel-switch-does-not-revive", "obligation": "C-R04/PC-F06 部分停止后取消切换不复活已停任务；进度页无成功/失败选择", "start": "P-M02-CONFIRM",
  "steps": [
    {"click": "停止全部并切换", "expect": "P-M02-STOPPING", "note": "确认后停止进度", "wait_auto_ms": 1500},
    {"click": "取消切换", "expect": "P-M02-STOP-CANCEL", "note": "部分停止后取消"},
    {"click": "返回首页", "expect": "P-M03-HOME-ENT-AFTER-CANCEL", "note": "回原空间首页"},
    {"click": "重新选择空间", "expect": None, "note": "经首页后台任务入口观察剩余任务", "optional": True},
  ]},
 {"id": "PR9-stop-failed-retry", "obligation": "PC-F06 终止失败只重试失败项", "start": "P-M02-STOP-FAILED",
  "steps": [
    {"click": "重试失败项", "expect": "P-M02-STOPPING", "note": "重试失败项", "wait_auto_ms": 15000},
  ]},
 {"id": "PR10-owner-recharge-roundtrip", "obligation": "PC-N03 Owner 去充值→返回→单次查询→仅解除阻断→用户主动继续", "start": "A-enterprise-ownerblock",
  "steps": [
    {"click": "去充值", "expect": "P-M09-BROWSER-OWNER", "note": "跨表面到浏览器充值"},
    {"click": "返回 Polo", "expect": "A-enterprise-ownerreturn", "note": "返回桌面询问"},
    {"click": "还没有", "expect": "A-enterprise-ownerblock", "note": "还没有仅关闭询问"},
    {"click": "去充值", "expect": "P-M09-BROWSER-OWNER", "note": "再次去充值"},
    {"click": "返回 Polo", "expect": "A-enterprise-ownerreturn", "note": "再次返回"},
    {"click": "已完成，查询结果", "expect": "A-enterprise-ownerchecking", "note": "主动单次查询", "wait_auto_ms": 15000},
    {"click": "发送消息", "expect": "A-enterprise-generating", "note": "解除阻断后用户主动发送"},
  ]},
 {"id": "PR11-member-budget-notify", "obligation": "PC-N03 Member 仅通知 Owner，不暴露财务", "start": "A-enterprise-notified",
  "steps": [
    {"click": "已完成，查询结果", "expect": None, "note": "成员查询预算状态", "wait_auto_ms": 6000},
  ]},
 {"id": "PR12-admin-handoff-keeps-enterprise", "obligation": "PC-F09 企业管理交接保留所选企业对象；取消回原菜单", "start": "P-M10-MENU-ENT",
  "steps": [
    {"click": "企业管理后台", "expect": "P-M10-ADMIN-BROWSER-ENT", "note": "打开企业管理交接"},
    {"click": "取消本次前往", "expect": None, "note": "取消回原菜单"},
  ]},
 {"id": "PR13-creator-responsibility-readonly", "obligation": "PC-F09 创作者资格失效保留责任只读；取消回原菜单", "start": "P-M10-MENU-RESPONSIBILITY",
  "steps": [
    {"click": "创作者责任只读", "expect": "P-M10-RESPONSIBILITY-BROWSER", "note": "打开责任只读交接"},
    {"click": "取消本次前往", "expect": None, "note": "取消回原菜单"},
  ]},
 {"id": "PR14-permission-cancel-no-start", "obligation": "C-R06/PC-F02 拒绝权限不启动依赖动作", "start": "P-M04-PERM-DENIED",
  "steps": [
    {"click": "稍后再说", "expect": "P-M04-APP-CONTRACT", "note": "稍后再说"},
    {"click": "关闭标签", "expect": "P-M03-HOME-ENT", "note": "关闭标签"},
  ]},
 {"id": "PR15-close-three-branches", "obligation": "PC-F02/§13.2 关闭三分支", "start": "P-M04-CLOSE-ACTIVE",
  "steps": [
    {"click": "取消", "expect": "P-M04-APP-ACTIVE", "note": "取消留原页"},
    {"click": "关闭", "expect": "P-M04-CLOSE-ACTIVE", "note": "再打开关闭对话框"},
    {"click": "后台继续", "expect": "P-M04-BACKGROUND", "note": "后台继续"},
    {"click": "后台任务", "expect": None, "note": "查看运行入口", "optional": True},
  ]},
 {"id": "PR16-question-answer-vs-defer", "obligation": "PC-N04 回答一次一条消息；暂不回答不续答", "start": "A-personal-question",
  "steps": [
    {"click": "暂不回答", "expect": "A-personal-deferred", "note": "暂不回答"},
    {"click": "所有会话", "expect": None, "note": "回会话列表", "optional": True},
  ]},
 {"id": "PR17-question-answer", "obligation": "PC-N04 提交回答在原会话续答", "start": "A-personal-question",
  "steps": [
    {"click": "提交回答", "expect": "A-personal-answered", "note": "提交回答"},
  ]},
 {"id": "PR18-pay-cancel-return-detail", "obligation": "PC-F03 付款取消回详情；查询失败留原对象", "start": "P-M07-PAY-BROWSER",
  "steps": [
    {"click": "取消本次前往", "expect": "P-M07-DETAIL-PAID", "note": "取消前往浏览器"},
    {"click": "去浏览器支付", "expect": "P-M07-PAY-BROWSER", "note": "再次前往", "optional": True},
    {"click": "返回 Polo", "expect": "P-M07-PAY-RETURN", "note": "返回核对"},
    {"click": "返回我的圈子", "expect": "P-M07-LIST", "note": "回列表"},
  ]},
]

RESET_JS = "() => { const rb = document.querySelector('[data-reset]'); if (rb) { rb.click(); return true; } return false; }"
CLICK_LINK_JS = """(sid) => {
  const esc = (window.CSS && CSS.escape) ? CSS.escape(sid) : sid.replace(/"/g,'\\\\"');
  const btn = document.querySelector('[data-scene-link="' + esc + '"]');
  if (!btn) return false; btn.click(); return true;
}"""
SNAP_JS = """() => {
  const t = (document.body.innerText||'').replace(/\\n{3,}/g,' | ');
  const btns = [];
  for (const el of document.querySelectorAll('button,[role=button]')) {
    const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') continue;
    const r = el.getBoundingClientRect(); if (!(r.width>0&&r.height>0)) continue;
    btns.push({label:(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60), tr: el.getAttribute('data-transition'), disabled: !!el.disabled});
  }
  return {scene: document.body.dataset.currentScene, text_tail: t.slice(-1400), buttons: btns};
}"""

def active_frame(page):
    for sel in ('[data-prototype-viewport]', '[data-assistant-viewport]'):
        for el in page.query_selector_all(sel):
            if el.get_attribute('hidden') is None:
                fr = el.content_frame()
                if fr is not None:
                    return fr
    return None

def frame_scene(fr):
    try:
        return fr.evaluate("() => (document.body && document.body.dataset.currentScene) || null")
    except Exception:
        return None

def click_transition(fr, label):
    return fr.evaluate("""(label) => {
      const els = [...document.querySelectorAll('button,[role=button]')];
      for (const el of els) {
        const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') continue;
        const r = el.getBoundingClientRect(); if (!(r.width>0&&r.height>0)) continue;
        const txt = (el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' ');
        if (txt === label || txt.startsWith(label)) { el.click(); return txt; }
      }
      return null;
    }""", label)

def wait_scene(page, expected, timeout_ms):
    timeline = []
    t0 = time.time()
    last = None
    while (time.time() - t0) * 1000 < timeout_ms:
        fr = active_frame(page)
        cur = frame_scene(fr) if fr else None
        if cur != last:
            timeline.append({'ms': round((time.time()-t0)*1000), 'scene': cur})
            last = cur
        if expected and cur == expected:
            return timeline, cur
        page.wait_for_timeout(80)
    return timeline, last

def main():
    log = open(f'{RAW}/probes.jsonl', 'w', encoding='utf-8')
    actions = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--allow-file-access-from-files'])
        try:
            for chain in CHAINS:
                ctx = browser.new_context(viewport={'width': 1500, 'height': 1000}, device_scale_factor=1)
                page = ctx.new_page()
                page.goto(f'file://{ROOT}/docs/mvp-complete-flow-hifi/review.html')
                page.wait_for_selector('[data-prototype-viewport]', timeout=30000)
                for _ in range(120):
                    fr0 = active_frame(page)
                    if fr0 and frame_scene(fr0):
                        break
                    page.wait_for_timeout(500)
                page.evaluate("() => { const b=document.querySelector('[data-panel-entry=\"index\"]'); if (b) b.click(); }")
                page.wait_for_function("() => document.querySelectorAll('[data-scene-link]').length > 100", timeout=30000)
                page.evaluate("""() => { const sel=document.querySelector('[data-viewport-select]'); sel.value='desktop-1440x900'; sel.dispatchEvent(new Event('change',{bubbles:true})); }""")
                page.wait_for_timeout(300)
                page.evaluate(RESET_JS)
                page.wait_for_timeout(200)
                ok = page.evaluate(CLICK_LINK_JS, chain['start'])
                tl, cur = wait_scene(page, chain['start'], 8000)
                log.write(json.dumps({'chain': chain['id'], 'action': 'RESET+goto', 'scene': chain['start'], 'nav_ok': bool(ok and cur == chain['start']), 'timeline': tl, 'obligation': chain['obligation']}, ensure_ascii=False) + '\n')
                fr = active_frame(page)
                snap = fr.evaluate(SNAP_JS) if fr else None
                log.write(json.dumps({'chain': chain['id'], 'action': 'snapshot', 'scene': chain['start'], 'snap': snap}, ensure_ascii=False) + '\n')
                for i, step in enumerate(chain['steps']):
                    entry = {'chain': chain['id'], 'step': i, 'click': step['click'], 'note': step.get('note',''), 'expect': step.get('expect')}
                    fr = active_frame(page)
                    if fr is None:
                        entry['error'] = 'no-active-frame'
                        log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                        continue
                    clicked = click_transition(fr, step['click'])
                    entry['clicked_label'] = clicked
                    actions += 1
                    if clicked is None:
                        entry['error'] = 'button-not-found'
                        if step.get('optional'):
                            entry['skipped'] = True
                        log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                        continue
                    tl, cur = wait_scene(page, step.get('expect'), 9000)
                    auto_ms = step.get('wait_auto_ms')
                    if auto_ms:
                        tl2, cur2 = wait_scene(page, None, auto_ms)
                        tl = tl + tl2
                        cur = cur2
                    entry['timeline'] = tl
                    entry['observed_scene'] = cur
                    entry['expect_met'] = (step.get('expect') is None) or (cur == step.get('expect'))
                    fr = active_frame(page)
                    entry['snap'] = fr.evaluate(SNAP_JS) if fr else None
                    log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                ctx.close()
                print(f"chain {chain['id']} done", flush=True)
        finally:
            log.close()
            try:
                browser.close()
            except Exception:
                pass
    json.dump({'real_click_actions': actions, 'chains': len(CHAINS)}, open(f'{RAW}/probes-summary.json', 'w'))

if __name__ == '__main__':
    main()
