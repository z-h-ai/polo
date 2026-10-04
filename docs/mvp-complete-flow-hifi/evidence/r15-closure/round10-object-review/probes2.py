#!/usr/bin/env python3
"""round10-object-review 对象与权限探测第二轮：按 data-transition 精确点击、
处理快速自动推进与需要输入的提交按钮。每条链独立 Reset。"""
import json, time
from playwright.sync_api import sync_playwright

ROOT = '/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview'
OUT = f'{ROOT}/docs/mvp-complete-flow-hifi/evidence/r15-closure/round10-object-review'
RAW = f'{OUT}/raw'

CHAINS = [
 {"id": "PR1b-free-circle-leave-shared-app-opens", "obligation": "PC-F03/08/D-PC-09 退出增长圈：确认退出→来源回退说明→共享作品仍可打开", "start": "P-M07-DETAIL-FOCUS-SUBSCRIPTION",
  "steps": [
    {"tr": "P-M07-DETAIL-FOCUS-SUBSCRIPTION-R14-16", "expect": "P-M07-LEAVE", "note": "退出圈子确认"},
    {"tr": "T-P-M07-LEAVE-021-P-M07-SOURCE-FALLBACK", "expect": "P-M07-SOURCE-FALLBACK", "note": "确认退出"},
    {"tr": "P-M07-SOURCE-FALLBACK-CLEANUP-3", "expect": "P-M04-APP-REPORT", "note": "共享作品（多来源）仍可打开"},
  ]},
 {"id": "PR2b-paid-circle-cancel-then-confirm-leave", "obligation": "C-R04 取消退出不变更资格；确认退出后唯一来源应用只能重新加入、多来源应用仍可打开", "start": "P-M07-DETAIL-PAID-SUBSCRIPTION",
  "steps": [
    {"tr": "P-M07-DETAIL-PAID-SUBSCRIPTION-R14-19", "expect": "P-M07-LEAVE-PAID", "note": "退出圈子确认"},
    {"tr": "T-P-M07-LEAVE-PAID-023-P-M07-DETAIL-PAID", "expect": "P-M07-DETAIL-PAID", "note": "取消退出"},
    {"tr": "P-M07-DETAIL-PAID-R14-17", "expect": "P-M07-DETAIL-PAID-SUBSCRIPTION", "note": "回订阅区"},
    {"tr": "P-M07-DETAIL-PAID-SUBSCRIPTION-R14-19", "expect": "P-M07-LEAVE-PAID", "note": "再次退出确认"},
    {"tr": "T-P-M07-LEAVE-PAID-024-P-M07-DETAIL-PAID-AFTER-LEAVE", "expect": "P-M07-DETAIL-PAID-AFTER-LEAVE", "note": "确认退出"},
    {"tr": "T-P-M07-DETAIL-PAID-AFTER-LEAVE-017-P-M04-APP-VIEW-PERSONAL", "expect": "P-M04-APP-VIEW-PERSONAL", "note": "多来源会议纪要仍可打开"},
  ]},
 {"id": "PR4b-renew-limit-query-original", "obligation": "PC-F03 达上限不建新单仍可查原单；原单核对结果一致", "start": "P-M07-RENEW-LIMIT",
  "steps": [
    {"tr": "P-M07-RENEW-LIMIT-R13-1", "expect": "P-M07-RENEW-RETURN", "note": "查看原订单"},
    {"tr": "P-M07-RENEW-RETURN-R13-1", "expect": "P-M07-RENEW-RESULT", "note": "查询原订单"},
  ]},
 {"id": "PR5b-builtin-toggle-independence", "obligation": "PC-F04 同名内置/圈子技能独立启停", "start": "A-personal-skills",
  "steps": [
    {"text": "查看内置技能", "expect": None, "note": "切换查看内置同名技能"},
    {"text": "停用内置技能", "expect": "A-personal-builtinoff", "note": "停用内置", "optional": True},
    {"text": "启用内置技能", "expect": "A-personal-builtinon", "note": "启用内置", "optional": True},
  ]},
 {"id": "PR7b-transfer-cancel-then-confirm", "obligation": "C-R07 取消导入不建对象；确认导入建立独立新对话", "start": "A-personal-transfer-import",
  "steps": [
    {"tr": "A-personal-transfer-import-select-import", "expect": "A-personal-transfer-preview", "note": "选择导出文件（input）"},
    {"tr": "A-personal-transfer-preview-cancel-transfer", "expect": "A-personal-conversation", "note": "取消导入"},
    {"goto": "A-personal-transfer-import", "expect": "A-personal-transfer-import", "note": "重新进入导入入口"},
    {"tr": "A-personal-transfer-import-select-import", "expect": "A-personal-transfer-preview", "note": "再次选择文件"},
    {"tr": "A-personal-transfer-preview-confirm-import", "expect": "A-personal-transfer-done", "note": "确认导入建立新对象"},
    {"tr": "A-personal-transfer-done-open-imported", "expect": "A-personal-conversation", "note": "打开导入对话", "optional": True},
  ]},
 {"id": "PR8b-cancel-mid-stop-no-revive", "obligation": "C-R04/PC-F06 停止进行中取消：已停项不复活；重新确认按剩余任务推进", "start": "P-M02-CONFIRM",
  "steps": [
    {"tr": "P-M02-CONFIRM-R14-C-18", "expect": "P-M02-STOPPING", "fast": True, "then_click": {"tr": "P-M02-STOPPING-R14-C-17", "expect": "P-M02-STOP-CANCEL", "note": "停止进行中立即取消切换"}},
    {"text": "重新选择空间", "expect": "P-M02-SWITCHER", "note": "取消后重新选择空间", "optional": True},
    {"text": "我的空间个人空间", "expect": "P-M02-CONFIRM", "note": "再次确认切换，观察剩余任务数", "optional": True},
  ]},
 {"id": "PR10b-owner-resumed-user-resends", "obligation": "PC-N03 解除阻断后由用户主动发送（不自动续写）", "start": "A-enterprise-ownerresumed",
  "steps": [
    {"fill": {"label": "消息", "value": "请继续汇总。"}, "expect": None, "note": "输入消息"},
    {"text": "发送消息", "expect": "A-enterprise-generating", "note": "用户主动发送"},
  ]},
 {"id": "PR12b-admin-handoff-cancel", "obligation": "PC-F09 取消管理交接回原菜单；交接目标保留所选企业", "start": "P-M10-ADMIN-BROWSER-ENT",
  "steps": [
    {"tr": "P-M10-ADMIN-BROWSER-ENT-cancel", "expect": None, "note": "取消本次前往"},
  ]},
 {"id": "PR17b-question-answer-with-input", "obligation": "PC-N04 回答需内容，提交后原会话一条消息续答", "start": "A-personal-question",
  "steps": [
    {"fill": {"label": "回答问题", "value": "最近两周。"}, "expect": None, "note": "填写回答"},
    {"tr": "A-personal-question-answer", "expect": "A-personal-answered", "note": "提交回答"},
  ]},
 {"id": "PR18b-pay-return-to-list", "obligation": "PC-F03/C-R08 支付返回仅是该端事实，需主动核对", "start": "P-M07-PAY-BROWSER",
  "steps": [
    {"tr": "P-M07-PAY-BROWSER-R13-1", "expect": "P-M07-PAY-RETURN", "note": "返回 Polo"},
    {"tr": "P-M07-PAY-RETURN-R13-2", "expect": "P-M07-LIST", "note": "返回我的圈子"},
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
  return {scene: document.body.dataset.currentScene, text_tail: t.slice(-1500)};
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

CLICK_TR_JS = """(tid) => {
  const esc = (window.CSS && CSS.escape) ? CSS.escape(tid) : tid.replace(/"/g,'\\\\"');
  const el = document.querySelector('[data-transition="' + esc + '"]');
  if (!el) return null;
  const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') return 'hidden';
  el.click(); return 'clicked';
}"""
CLICK_TEXT_JS = """(label) => {
  const els = [...document.querySelectorAll('button,[role=button],a,input')];
  for (const el of els) {
    const st = getComputedStyle(el); if (st.display==='none'||st.visibility==='hidden') continue;
    const r = el.getBoundingClientRect(); if (!(r.width>0&&r.height>0)) continue;
    const txt = (el.getAttribute('aria-label')||el.textContent||el.value||'').trim().replace(/\\s+/g,' ');
    if (txt === label) { el.click(); return txt; }
  }
  return null;
}"""
FILL_JS = """(arg) => {
  const els = [...document.querySelectorAll('textarea,input')];
  for (const el of els) {
    if ((el.getAttribute('aria-label')||el.placeholder||'') !== arg.label) continue;
    const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(el, arg.value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    return 'filled';
  }
  return null;
}"""

def wait_scene(page, expected, timeout_ms, poll=40):
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
        page.wait_for_timeout(poll)
    return timeline, last

def main():
    log = open(f'{RAW}/probes2.jsonl', 'w', encoding='utf-8')
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
                # goto 起点场景
                if 'goto' in chain:
                    ok = page.evaluate(CLICK_LINK_JS, chain['goto'])
                else:
                    ok = page.evaluate(CLICK_LINK_JS, chain['start'])
                tl, cur = wait_scene(page, chain['start'], 8000)
                log.write(json.dumps({'chain': chain['id'], 'action': 'RESET+goto', 'scene': chain['start'], 'nav_ok': bool(ok and cur == chain['start'])}, ensure_ascii=False) + '\n')
                fr = active_frame(page)
                log.write(json.dumps({'chain': chain['id'], 'action': 'snapshot', 'scene': chain['start'], 'snap': fr.evaluate(SNAP_JS) if fr else None}, ensure_ascii=False) + '\n')
                for i, step in enumerate(chain['steps']):
                    entry = {'chain': chain['id'], 'step': i, 'note': step.get('note',''), 'expect': step.get('expect')}
                    fr = active_frame(page)
                    if fr is None:
                        entry['error'] = 'no-active-frame'
                        log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                        continue
                    if step.get('goto'):
                        page.evaluate(CLICK_LINK_JS, step['goto'])
                        tl, cur = wait_scene(page, step.get('expect'), 8000)
                        entry.update({'clicked_goto': step['goto'], 'timeline': tl, 'observed_scene': cur,
                                      'expect_met': (step.get('expect') is None) or (cur == step.get('expect'))})
                        actions += 1
                    elif step.get('fill'):
                        r = fr.evaluate(FILL_JS, step['fill'])
                        entry.update({'filled': r, 'observed_scene': frame_scene(fr)})
                        actions += 1
                    elif step.get('tr'):
                        r = fr.evaluate(CLICK_TR_JS, step['tr'])
                        entry['clicked_tr'] = step['tr']
                        entry['click_result'] = r
                        actions += 1
                        if r != 'clicked':
                            entry['error'] = f'button-{r or "not-found"}'
                            if step.get('optional'):
                                entry['skipped'] = True
                            log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                            continue
                        if step.get('fast'):
                            # 快速轮询到达期望场景后立刻执行 then_click
                            tl, cur = wait_scene(page, step.get('expect'), 6000, poll=25)
                            entry['timeline'] = tl
                            entry['observed_scene'] = cur
                            tc = step.get('then_click')
                            if tc:
                                fr2 = active_frame(page)
                                r2 = fr2.evaluate(CLICK_TR_JS, tc['tr']) if fr2 else None
                                actions += 1
                                entry['then_click'] = {'tr': tc['tr'], 'result': r2}
                                if r2 == 'clicked':
                                    tl2, cur2 = wait_scene(page, tc.get('expect'), 8000, poll=25)
                                    entry.update({'then_timeline': tl2, 'final_scene': cur2,
                                                  'then_expect_met': (tc.get('expect') is None) or (cur2 == tc.get('expect'))})
                            else:
                                entry['expect_met'] = (step.get('expect') is None) or (cur == step.get('expect'))
                        else:
                            tl, cur = wait_scene(page, step.get('expect'), 9000)
                            entry.update({'timeline': tl, 'observed_scene': cur,
                                          'expect_met': (step.get('expect') is None) or (cur == step.get('expect'))})
                    elif step.get('text'):
                        r = fr.evaluate(CLICK_TEXT_JS, step['text'])
                        entry['clicked_text'] = step['text']
                        entry['click_result'] = r
                        actions += 1
                        if r is None:
                            entry['error'] = 'button-not-found'
                            if step.get('optional'):
                                entry['skipped'] = True
                            log.write(json.dumps(entry, ensure_ascii=False) + '\n')
                            continue
                        tl, cur = wait_scene(page, step.get('expect'), 9000)
                        entry.update({'timeline': tl, 'observed_scene': cur,
                                      'expect_met': (step.get('expect') is None) or (cur == step.get('expect'))})
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
    json.dump({'real_click_actions_round2': actions}, open(f'{RAW}/probes2-summary.json', 'w'))

if __name__ == '__main__':
    main()
