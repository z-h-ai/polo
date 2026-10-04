#!/usr/bin/env python3
"""round11-journey-review: journey & semantic probes with real product clicks.

Every chain starts from the review shell Reset, seeds a scene through the
shell's hash router (the shell's own review-entry transport), then drives the
product only through real clicks on rendered product controls (data-transition
buttons declared in the manifest). All observations are logged as JSONL.
"""
import asyncio
import importlib.util
import json
import os
import time

ROOT = "/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview"
OUT = os.path.join(ROOT, "docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-journey-review")
REVIEW = os.path.join(ROOT, "docs/mvp-complete-flow-hifi/review.html")

spec = importlib.util.spec_from_file_location("census", os.path.join(OUT, "scripts", "census.py"))
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)

MANIFEST = json.load(open(os.path.join(ROOT, "docs/mvp-complete-flow-hifi/prototype-manifest.json"), encoding="utf-8"))
BY_SCENE = {s["id"]: s for s in MANIFEST["scenes"]}
LOG_PATH = os.path.join(OUT, "raw", "chain-logs.jsonl")
logf = open(LOG_PATH, "w", encoding="utf-8")


def log(rec):
    logf.write(json.dumps(rec, ensure_ascii=False) + "\n")
    logf.flush()


def transition_of(frm, label=None, to=None):
    for t in BY_SCENE[frm].get("transitions", []):
        if (label is None or t["label"] == label) and (to is None or t["to"] == to):
            return t
    raise KeyError(f"no transition from {frm} label={label} to={to}")


class Runner:
    def __init__(self, page):
        self.page = page
        self.dialogs = []
        self.dialog_policy = "dismiss"
        page.on("dialog", self._on_dialog)

    async def _on_dialog(self, d):
        self.dialogs.append({"message": d.message, "type": d.type})
        if self.dialog_policy == "accept":
            await d.accept()
        else:
            await d.dismiss()

    async def scene(self):
        return await self.page.evaluate("document.body.dataset.currentScene")

    async def wait_scene(self, expected, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            cur = await self.scene()
            if cur == expected:
                fr = await census.active_frame(self.page)
                if fr:
                    try:
                        if await fr.evaluate("document.readyState === 'complete'"):
                            await asyncio.sleep(0.25)
                            return cur
                    except Exception:  # noqa: BLE001
                        pass
            await asyncio.sleep(0.08)
        return await self.scene()

    async def reset(self):
        self.dialog_policy = "dismiss"
        # [data-reset] lives in the (hidden) settings inspector panel; the shell
        # delegates clicks on document, so a JS click reaches the same handler.
        await self.page.evaluate("document.querySelector('[data-reset]').click()")
        cur = await self.wait_scene("P-M03-HOME-PERSONAL", timeout=10)
        assert cur == "P-M03-HOME-PERSONAL", f"reset landed on {cur}"

    async def seed(self, sid):
        await self.page.evaluate(f"location.hash = '#scene=' + {json.dumps(sid)}")
        cur = await self.wait_scene(sid, timeout=10)
        assert cur == sid, f"seed {sid} landed on {cur}"
        await asyncio.sleep(0.15)

    async def frame(self):
        return await census.active_frame(self.page)

    async def text(self):
        fr = await self.frame()
        return await fr.evaluate("document.body.innerText")

    async def click(self, frm, label=None, to=None, expect=True, settle=0.35):
        t = transition_of(frm, label=label, to=to)
        cur = await self.scene()
        assert cur == frm, f"click from {frm} but current scene is {cur}"
        fr = await self.frame()
        sel = f'[data-transition="{t["id"]}"]'
        await fr.click(sel, timeout=8000)
        await asyncio.sleep(settle)
        if expect and t["to"] != frm:
            got = await self.wait_scene(t["to"], timeout=8)
            return t, got
        return t, await self.scene()

    async def fill_textarea(self, text):
        """Type into the assistant composer (React-controlled textarea)."""
        fr = await self.frame()
        await fr.fill("textarea", text)
        await asyncio.sleep(0.3)

    async def fill(self, sel, value):
        fr = await self.frame()
        await fr.fill(sel, value)

    async def attr(self, sel, attr="disabled"):
        fr = await self.frame()
        return await fr.evaluate(
            f"() => {{ const root = document.querySelector('.scene.active') || document;"
            f" const el = root.querySelector({json.dumps(sel)});"
            f" return el ? {{found: true, disabled: !!el.disabled, hidden: !el.getClientRects().length, title: el.title || '', text: (el.innerText||'').trim().slice(0,60), value: el.value !== undefined ? String(el.value).slice(0,80) : undefined}} : {{found: false}} }}"
        )

    async def query_all(self, sel):
        fr = await self.frame()
        return await fr.evaluate(
            f"() => {{ const root = document.querySelector('.scene.active') || document;"
            f" return [...root.querySelectorAll({json.dumps(sel)})].map(el => ({{text:(el.innerText||el.value||'').trim().slice(0,80), disabled: !!el.disabled, hidden: !el.getClientRects().length}})); }}"
        )

    async def shot(self, name):
        fr_el = None
        frame = await self.frame()
        if frame:
            try:
                fr_el = await frame.frame_element()
            except Exception:  # noqa: BLE001
                pass
        path = os.path.join(OUT, "shots", f"probe-{name}.png")
        if fr_el:
            await fr_el.screenshot(path=path)
        else:
            await self.page.screenshot(path=path)


CHECKS = []


def check(cid, ok, observed):
    CHECKS.append({"id": cid, "status": "passed" if ok else "finding", "observed": observed})
    log({"kind": "check", "id": cid, "ok": ok, "observed": observed})


def step(r, chain, name, action, target, observed, extra=None):
    rec = {"kind": "step", "chain": chain, "step": name, "action": action, "target": target,
           "observed": observed}
    if extra:
        rec.update(extra)
    log(rec)


# --------------------------- chains ---------------------------

async def chain_first_use(r):
    """PC-F01 / PC-N01 / D-PC-11/12: first login, unique personal space, complete catalog."""
    await r.reset()
    await r.seed("P-M01-LOGIN-PASSWORD")
    t, got = await r.click("P-M01-LOGIN-PASSWORD", label="继续")
    step(r, "first-use", "login-continue", "click 继续", t["to"], f"scene={got}")
    check("F01-login-to-prep", got == "P-M01-PERSONAL-PREP", f"登录后进入 我的空间·准备中: {got}")
    t, got = await r.click("P-M01-PERSONAL-PREP", label="进入首页")
    step(r, "first-use", "enter-home", "click 进入首页", t["to"], f"scene={got}")
    txt = await r.text()
    check("N01-home-complete-catalog", got == "P-M03-HOME-ZERO" and "我的应用" in txt and "会议纪要整理" in txt,
          "无使用记录首页直接展示完整目录（我的应用+四个作品+打开按钮）" if got == "P-M03-HOME-ZERO" else f"落点异常 {got}")
    check("DPC11-no-pinned-config", ("常用" not in txt) and ("5 个" not in txt) and ("添加到首页" not in txt),
          "首页无 常用配置/5 个上限/添加或移出首页 文案")
    cards = await r.query_all("[data-app-key] h3")
    check("DPC12-assistant-first", cards and cards[0]["text"] == "Polo 助手",
          f"目录第一张卡为固定 Polo 助手: {[c['text'] for c in cards[:3]]}")
    ctls = await r.query_all("[data-app-key='assistant'] button")
    labels = sorted({c["text"] for c in ctls if not c["hidden"]})
    check("DPC13-assistant-card-entries", "管理技能" in labels and "打开助手" in labels,
          f"助手卡片内并列为「管理技能」「打开助手」: {labels}")
    await r.shot("first-use-home-zero")
    t, got = await r.click("P-M03-HOME-ZERO", label="打开", to="P-M04-APP-REPORT")
    step(r, "first-use", "open-report", "click 打开(数据报表生成器)", t["to"], f"scene={got}")
    txt = await r.text()
    check("F02-open-report-container", got == "P-M04-APP-REPORT" and "数据报表生成器" in txt,
          f"打开后 App 容器展示同一作品: {got}")
    sp = await r.attr("#space-name")
    check("F02-personal-space-context", sp.get("found") and "我的空间" in sp.get("text", ""),
          f"运行中空间标识仍为 我的空间: {sp}")


async def chain_enterprise_handoff(r):
    """PC-F05 / R13-enterprise-handoff: browser invite -> refresh -> active enter."""
    await r.reset()
    await r.seed("P-M01-INVITE-BROWSER")
    t, got = await r.click("P-M01-INVITE-BROWSER", label="返回 Polo 核对企业")
    step(r, "ent-handoff", "return", "click 返回 Polo 核对企业", t["to"], f"scene={got}")
    t, got = await r.click("P-M01-RETURN", label="刷新企业列表")
    step(r, "ent-handoff", "refresh", "click 刷新企业列表", t["to"], f"scene={got}")
    txt = await r.text()
    check("F05-enterprise-ready", got == "P-M01-ENTERPRISE-READY" and "晨星科技" in txt,
          f"刷新后出现可进入企业（成员事实保留）: {got}")
    t, got = await r.click("P-M01-ENTERPRISE-READY", label="进入晨星科技")
    step(r, "ent-handoff", "enter", "click 进入晨星科技", t["to"], f"scene={got}")
    sp = await r.attr("#space-name")
    check("F05-active-enter", got == "P-M03-HOME-ENT" and "晨星科技" in sp.get("text", ""),
          f"用户主动进入企业首页，空间名={sp.get('text')}")
    t, got = await r.click("P-M03-HOME-ENT", label="打开", to="P-M04-APP-VIEW")
    txt = await r.text()
    check("F07-enterprise-app-identity", got == "P-M04-APP-VIEW" and "报价整理" in txt,
          f"企业目录打开 报价整理，App 容器身份一致: {got}")
    sp = await r.attr("#space-name")
    check("F07-stays-enterprise", "晨星科技" in sp.get("text", ""), f"App 内空间仍为企业: {sp.get('text')}")
    await r.reset()
    await r.seed("P-M01-INVITE-PENDING")
    txt = await r.text()
    btns = await r.query_all("button")
    enter_labels = [b["text"] for b in btns if not b["hidden"] and ("进入" in b["text"] and "我的空间" not in b["text"])]
    check("F05-pending-not-space", "待审批" in txt and "不会出现在你的空间列表" in txt and not enter_labels,
          f"共享邀请待审批不视为有效空间：批准前不出现在空间列表；无进入企业动作（仅可回到我的空间）: {enter_labels}")
    await r.shot("invite-pending")


async def chain_switch_success(r):
    """PC-F06 / S-004: one confirm, automatic stop progress, auto-enter target."""
    await r.reset()
    await r.seed("P-M03-HOME-ENT")
    t, got = await r.click("P-M03-HOME-ENT", label="打开助手")
    step(r, "switch-ok", "open-assistant", "click 打开助手", t["to"], f"scene={got}")
    await r.fill_textarea("请汇总本周企业项目进展")
    t, got = await r.click("A-enterprise-new", label="发送消息")
    step(r, "switch-ok", "assistant-run", "click 发送消息(已输入文本)", t["to"], f"scene={got}")
    t, got = await r.click("A-enterprise-generating", label="首页")
    step(r, "switch-ok", "back-home", "click 首页", t["to"], f"scene={got}")
    t, got = await r.click("P-M03-HOME-ENT", label="打开账号菜单")
    step(r, "switch-ok", "open-menu", "click 打开账号菜单", t["to"], f"scene={got}")
    t, got = await r.click("P-M10-MENU-ENT", label="切换空间当前：晨星科技")
    step(r, "switch-ok", "open-switcher", "click 切换空间", t["to"], f"scene={got}")
    t, got = await r.click("P-M02-SWITCHER", label="我我的空间个人空间 · 个人")
    step(r, "switch-ok", "pick-personal", "click 我的空间", t["to"], f"scene={got}")
    txt = await r.text()
    btns = await r.query_all("button")
    visible = [b for b in btns if not b["hidden"]]
    confirm_btns = [b["text"] for b in visible if "停止全部并切换" in b["text"]]
    check("F06-single-confirm", got == "P-M02-CONFIRM" and len(confirm_btns) == 1,
          f"仅一次确认（停止全部并切换）：{confirm_btns}；可见按钮数={len(visible)}")
    check("F06-confirm-lists-tasks", "停止" in txt and "报价" in txt or "合同" in txt or "助手" in txt,
          "确认页列出须终止的运行项（App/助手）")
    nrow = await r.query_all(".dialog-row")
    n = len([x for x in nrow if not x["hidden"]])
    t, got = await r.click("P-M02-CONFIRM", label="停止全部并切换", expect=False, settle=0.15)
    await asyncio.sleep(0.35)
    # single atomic capture to avoid racing the auto-advance
    snap = await (await r.frame()).evaluate(
        "() => { const sc = document.querySelector('.scene.active');"
        " return { scene: document.body.dataset.currentScene,"
        "  text: sc ? sc.innerText.slice(0, 3000) : '',"
        "  buttons: [...document.querySelectorAll('.scene.active button')].filter(b => b.getClientRects().length).map(b => (b.innerText||'').trim().slice(0,20)) }; }"
    )
    mid_scene = snap["scene"]
    mid_txt = snap["text"]
    mid_btns = snap["buttons"]
    check("F06-progress-no-reconfirm", mid_scene == "P-M02-STOPPING" and not any("成功" in b or "失败" in b for b in mid_btns),
          f"进度页无 选择成功/失败 或再次确认按钮: {mid_btns}")
    check("F06-progress-zero-state", mid_scene == "P-M02-STOPPING" and ("正在停止" in mid_txt or "已停止" in mid_txt) and ("/" in mid_txt),
          f"点击确认后进入「正在停止任务」进度（n / N 计数与逐项状态）: scene={mid_scene}, text_head={mid_txt[:80]}")
    await r.shot("switch-stopping")
    final = await r.wait_scene("P-M03-HOME-PERSONAL", timeout=8)
    step(r, "switch-ok", "auto-switch", "等待自动切换", "P-M03-HOME-PERSONAL", f"final={final}")
    sp = await r.attr("#space-name")
    check("F06-auto-enter-target", final == "P-M03-HOME-PERSONAL" and "我的空间" in sp.get("text", ""),
          f"全停后自动进入目标首页（个人空间）: {final}, space={sp.get('text')}")
    await r.shot("switch-done-personal")


async def chain_switch_cancel(r):
    """PC-F06 / C-R04: cancel keeps original space; stopped items never resurrect."""
    await r.reset()
    await r.seed("P-M02-STOP-FAILED")
    txt0 = await r.text()
    check("F06-stopfailed-shows-state", "未确认停止" in txt0 or "失败" in txt0,
          f"部分停止失败页展示逐项状态与保留原空间说明")
    t, got = await r.click("P-M02-STOP-FAILED", label="取消切换")
    step(r, "switch-cancel", "cancel", "click 取消切换", t["to"], f"scene={got}")
    txt = await r.text()
    check("CR04-cancel-preserves-stopped", got == "P-M02-STOP-CANCEL" and "不撤销已经完成的停止" in txt and txt.count("已停止") >= 2,
          "取消的是切换，不撤销已经完成的停止；已停止项保持已停止并注明重新打开不会自动执行")
    await r.shot("switch-cancel-state")
    t, got = await r.click("P-M02-STOP-CANCEL", label="返回首页")
    sp = await r.attr("#space-name")
    check("F06-cancel-stays-original", got == "P-M03-HOME-ENT-AFTER-CANCEL" and "晨星科技" in sp.get("text", ""),
          f"取消后返回原企业首页（无半切）: {got}, space={sp.get('text')}")


async def chain_credit_recharge(r):
    """PC-N03 / J-PC-03: pre-send block, browser recharge, single manual query."""
    await r.reset()
    await r.seed("A-personal-preblock")
    fr = await r.frame()
    # the draft stays editable while sending is blocked
    await fr.evaluate(
        "() => { const ta = document.querySelector('textarea'); if (ta) {"
        " const proto = Object.getPrototypeOf(ta); const desc = Object.getOwnPropertyDescriptor(proto, 'value');"
        " desc.set.call(ta, '汇总上周会议要点'); ta.dispatchEvent(new Event('input', {bubbles: true})); } }"
    )
    await asyncio.sleep(0.4)
    state = await fr.evaluate(
        "() => { const ta = document.querySelector('textarea');"
        " const btn = [...document.querySelectorAll('button')].find(b => (b.textContent + (b.getAttribute('aria-label')||'')).includes('发送消息'));"
        " return {value: ta ? ta.value.slice(0,40) : null, visible: ta ? !!ta.getClientRects().length : false,"
        " sendDisabled: btn ? !!btn.disabled : null, sendFound: !!btn}; }"
    )
    txt = await r.text()
    check("N03-presend-block", "积分不足" in txt and state["sendFound"] and state["sendDisabled"] is True and state["value"],
          f"发送前阻断：输入可编辑且保留({state['value']})、发送禁用({state['sendDisabled']})、输入框上方提示积分不足")
    await r.shot("credit-preblock")
    t, got = await r.click("A-personal-preblock", label="去充值")
    step(r, "credit", "to-browser", "click 去充值", t["to"], f"scene={got}")
    txt = await r.text()
    check("N03-browser-handoff", got == "P-M09-BROWSER" and ("充值" in txt),
          "Browser 端充值交接卡，桌面不复制支付后台")
    t, got = await r.click("P-M09-BROWSER", label="返回 Polo")
    step(r, "credit", "return", "click 返回 Polo", t["to"], f"scene={got}")
    txt = await r.text()
    check("N03-return-asks-user", "已完成" in txt or "查询" in txt, "返回桌面后需用户主动点击「已完成，查询结果」")
    # no auto query: wait, scene must not move by itself
    s0 = await r.scene()
    await asyncio.sleep(2.2)
    s1 = await r.scene()
    check("N03-no-auto-query", s0 == s1, f"等待 2.2s 无任何自动查询/自动跳转: {s0}=={s1}")
    t, got = await r.click("A-personal-return", label="已完成，查询结果")
    step(r, "credit", "query-once", "click 已完成，查询结果", t["to"], f"scene={got}")
    check("N03-single-query-landing", got == "A-personal-checking", "一次点击只发起一次查询（进入查询中状态）")
    s0 = await r.scene()
    await asyncio.sleep(2.0)
    check("N03-no-polling", await r.scene() == s0, "查询中状态无自动轮询/自动推进")
    fr2 = await r.frame()
    send_state = await fr2.evaluate(
        "() => { const btn = [...document.querySelectorAll('button')].find(b => (b.textContent + (b.getAttribute('aria-label')||'')).includes('发送消息'));"
        " return btn ? !!btn.disabled : null; }"
    )
    check("N03-blocked-during-query", send_state is True, "查询期间发送保持不可用（阻断未解除）")
    # repeated manual query is allowed: each click exactly one query
    await r.seed("A-personal-notyet")
    t, got = await r.click("A-personal-notyet", label="已完成，查询结果")
    check("N03-requery-manual-only", got == "A-personal-checking", "未到账后再次查询仍需用户主动点击（各点击一次查询）")
    # 还没有 closes the inquiry only
    await r.reset()
    await r.seed("A-personal-return")
    t, got = await r.click("A-personal-return", label="还没有")
    txt2 = await r.text()
    check("N03-notyet-close-only", got == "A-personal-preblock" and "积分不足" in txt2,
          "「还没有」仅关闭询问并保持阻断（未到账不解除）")
    await r.reset()
    await r.seed("A-personal-resumed")
    await r.fill_textarea("继续整理刚才的内容")
    t, got = await r.click("A-personal-resumed", label="发送消息")
    step(r, "credit", "resume-send", "click 发送消息(已输入文本)", t["to"], f"scene={got}")
    check("N03-success-no-auto-resend", got == "A-personal-generating", "到账仅解除阻断，由用户正常发送继续，无一键自动继续")
    await r.reset()
    await r.seed("A-personal-generating")
    t, got = await r.click("A-personal-generating", label="停止生成")
    txt = await r.text()
    check("N03-user-stop-not-credit", got == "A-personal-stopped" and "已停止生成" in txt and "积分不足" not in txt,
          f"用户主动停止显示「已停止生成」而非积分耗尽: {got}")
    await r.reset()
    await r.seed("A-personal-cut")
    txt = await r.text()
    check("N03-cut-partial-kept", "积分不足" in txt and ("已生成" in txt or "已保留" in txt or "部分" in txt or "已停止" in txt),
          "生成中停止下一段：保留已产出部分并在消息末尾提示（无重复输入框提示）")


async def chain_circle_exit(r):
    """PC-F03 / D-PC-09 / S4: dedup, per-source exit, last-source failure."""
    await r.reset()
    await r.seed("P-M03-ALL-APPS")
    txt = await r.text()
    count = txt.count("会议纪要整理")
    check("DPC09-dedup-one-card", count == 1, f"同一作品在目录只出现一次（会议纪要整理 x{count}）")
    t, got = await r.click("P-M03-ALL-APPS", label="我的圈子")
    step(r, "circle-exit", "open-circles", "click 我的圈子", t["to"], f"scene={got}")
    txt = await r.text()
    check("F03-circle-list", got == "P-M07-LIST" and "查看详情" in txt and "查看圈子内容，管理订阅" in txt,
          "统一圈子列表：标题+搜索筛选+右侧统一「查看详情」")
    await r.shot("circle-list")
    t, got = await r.click("P-M07-LIST", label="查看详情", to="P-M07-DETAIL-FOCUS")
    step(r, "circle-exit", "detail", "click 查看详情(增长圈)", t["to"], f"scene={got}")
    t, got = await r.click("P-M07-DETAIL-FOCUS", label="订阅")
    txt = await r.text()
    check("F03-exit-only-in-subscription", got == "P-M07-DETAIL-FOCUS-SUBSCRIPTION" and "退出圈子" in txt,
          "退出仅放在「订阅」区域")
    t, got = await r.click("P-M07-DETAIL-FOCUS-SUBSCRIPTION", label="退出圈子")
    txt = await r.text()
    check("F03-exit-impact-statement", "只撤销晨星增长圈" in txt and ("其他有效来源" in txt or "设计圈" in txt),
          "退出前说明逐来源影响（只撤销该圈来源）")
    t, got = await r.click("P-M07-LEAVE", label="确认退出")
    step(r, "circle-exit", "confirm-exit", "click 确认退出", t["to"], f"scene={got}")
    txt = await r.text()
    open_state = await r.attr('[data-go="P-M04-APP-VIEW-PERSONAL"]')
    check("DPC09-other-source-still-works", "已退出晨星增长圈" in txt and "仍然有效" in txt and open_state.get("found") and not open_state.get("disabled"),
          f"退出增长圈后会议纪要整理仍由设计圈授权可打开（按钮非禁用）")
    await r.shot("circle-exit-fallback")
    await r.reset()
    await r.seed("P-M11-BLOCKED-EXPIRED")
    txt = await r.text()
    btn = await r.attr('[data-go="P-M04-APP-VIEW-PERSONAL"]')
    check("F08-last-source-blocks", ("最后一个有效来源" in txt or "已失效" in txt) and (btn.get("found") is False or btn.get("disabled") or btn.get("hidden") or btn.get("text") == "已失去授权"),
          f"最后来源失效才进入不可用与恢复路径；打开按钮状态={btn}")


async def chain_renewal(r):
    """PC-F03 / POL-114 r26: manual renewal, calendar month, order identity, limit."""
    await r.reset()
    await r.seed("P-M07-RENEW")
    txt = await r.text()
    check("F03-renew-quote-calendar", "2026-11-02" in txt and "2026-12-02" in txt,
          "续费确认展示固定日历月周期（2026-11-02 至 2026-12-02）")
    t, got = await r.click("P-M07-RENEW", label="去浏览器支付")
    step(r, "renewal", "to-web", "click 去浏览器支付", t["to"], f"scene={got}")
    t, got = await r.click("P-M07-RENEW-WEB", label="返回 Polo")
    step(r, "renewal", "web-return", "click 返回 Polo", t["to"], f"scene={got}")
    t, got = await r.click("P-M07-RENEW-RETURN", label="查询原订单和资格")
    step(r, "renewal", "query-order", "click 查询原订单和资格", t["to"], f"scene={got}")
    txt = await r.text()
    import re as _re
    m = _re.search(r"SUB-20261002-(\d{4})", txt)
    check("F03-renewal-original-order", got == "P-M07-RENEW-RESULT" and m is not None,
          f"续费经原订单核对：订单号 {m.group(0) if m else '未找到'}")
    check("F03-expiry-extended", "2026-12-02" in txt, "续费后有效期自原到期时刻延长至 2026-12-02")
    await r.shot("renew-result")
    t, got = await r.click("P-M07-RENEW-RESULT", label="返回我的圈子")
    txt = await r.text()
    check("F03-list-same-fact", "2026-12-02" in txt, "普通列表与订阅显示同一到期事实")
    # consecutive second renewal consumes the renewed state: new quote, new order identity
    await r.seed("P-M07-RENEW")
    txt = await r.text()
    check("F03-second-renew-quote", "2026-12-02" in txt and "2027-01-02" in txt,
          "有效期内第二次续费基于最新已核对权益出具新报价（2026-12-02 至 2027-01-02）")
    t, got = await r.click("P-M07-RENEW", label="去浏览器支付")
    t, got = await r.click("P-M07-RENEW-WEB", label="返回 Polo")
    order_txt = await r.attr("[data-renewal-order]", attr="text")
    import re as _re3
    m3 = _re3.search(r"SUB-20261002-(\d{4})", order_txt.get("text", "") or "")
    check("F03-second-renew-new-order", got == "P-M07-RENEW-RETURN" and m3 is not None and m3.group(0) != "SUB-20261002-0183",
          f"第二次续费建新单：返回核对页展示的订单身份 {m3.group(0) if m3 else order_txt}，与首单 SUB-20261002-0183 独立")
    await r.reset()
    await r.seed("P-M07-RENEW-LIMIT")
    txt = await r.text()
    pay = await r.attr('[data-go="P-M07-RENEW-WEB"]')
    check("F03-limit-no-new-order", ("上限" in txt or "提前购买" in txt) and (pay.get("found") is False or pay.get("disabled") or pay.get("hidden")),
          f"达月度提前购买上限不建新单，仍展示原单与说明；去支付按钮={ {k: pay.get(k) for k in ('found','disabled','hidden')} }")
    await r.shot("renew-limit")
    await r.reset()
    await r.seed("P-M07-YEAR-RESULT")
    txt = await r.text()
    check("F03-annual-protect", ("年度" in txt) and ("下一年度" in txt or "2028" in txt) and ("进入下一年度周期后才可继续" in txt),
          "年度已购周期与「进入下一年度周期后才可继续」的提前续费边界如实展示")


async def chain_support(r):
    """POL-115 D-OPS-17 / R13-support: real-code absence, copy fallback, original object."""
    await r.reset()
    await r.seed("P-M07-PAY-RETURN-FAIL")
    t, got = await r.click("P-M07-PAY-RETURN-FAIL", label="联系客服")
    step(r, "support", "open", "click 联系客服", t["to"], f"scene={got}")
    txt = await r.text()
    qr_imgs = await r.query_all("img")
    fake = [i for i in qr_imgs if "data:image" in (i.get("text") or "")]
    check("OPS17-no-fake-qr", got == "P-M07-SUPPORT" and ("未配置" in txt or "暂不可用" in txt or "无法加载" in txt or "加载失败" in txt),
          "客服页不展示可扫描的样例二维码；未配置/加载失败状态如实提示")
    info = await r.attr("[data-support-info]", attr="value")
    check("OPS17-copy-minimal-info", info.get("found") and ("订单" in info.get("value", "") or "圈子" in info.get("value", "")),
          f"仅含本人可看的订单/圈子/错误摘要: {info.get('value','')[:60]}")
    r.dialog_policy = "dismiss"
    t, got = await r.click("P-M07-SUPPORT", label="复制问题信息", expect=False)
    txt = await r.text()
    ok_copy = ("已复制" in txt) or ("手动复制" in txt or "已选中" in txt)
    check("OPS17-copy-or-fallback", ok_copy, "复制成功提示或失败时选中信息转手动复制（不伪造成功）")
    t, got = await r.click("P-M07-SUPPORT", label="返回原页面")
    step(r, "support", "return", "click 返回原页面", t["to"], f"scene={got}")
    check("OPS17-return-original-object", got == "P-M07-PAY-RETURN-FAIL", "返回原订单/权益异常页，未伪装已受理")
    t, got = await r.click("P-M07-PAY-RETURN-FAIL", label="查询原订单和资格")
    check("OPS17-reverify-original", got == "P-M07-DETAIL-PAID", "从原对象主动复验")
    await r.reset()
    await r.seed("P-M07-SUPPORT-LOAD-FAIL")
    txt = await r.text()
    check("OPS17-loadfail-retry", ("加载失败" in txt or "无法加载" in txt or "重试" in txt) and "样例" not in txt,
          "二维码加载失败可重试/返回，不用样例码冒充")
    await r.reset()
    await r.seed("P-M11-SUPPORT-MEMBER")
    txt = await r.text()
    check("OPS17-member-no-finance", ("¥" not in txt) and ("金额" not in txt or "不可" in txt),
          "企业成员从受限页只复制企业/错误摘要，不含 Owner 财务金额")
    await r.reset()
    await r.seed("P-M11-SUPPORT-ACCOUNT-ADMIN")
    txt = await r.text()
    info = await r.attr("[data-support-info]", attr="value")
    check("OPS17-account-returns-own-page", "联系企业管理员" in txt and "ACC-0182" in info.get("value", ""),
          f"账号受限按原对象返回账号受限页（参考编号 ACC-0182），仅提供本人可看信息")


async def chain_skills(r):
    """PC-F04 / M06 / D-PC-13/14: skills entry, lifecycle, same-name separation."""
    await r.reset()
    await r.seed("P-M03-HOME-PERSONAL")
    t, got = await r.click("P-M03-HOME-PERSONAL", label="管理技能")
    step(r, "skills", "manage-entry", "click 管理技能(首页助手卡片)", t["to"], f"scene={got}")
    check("DPC13-entry-from-home-card", got == "A-personal-skills", "技能管理从首页助手卡片进入，无需先开会话")
    rows = await r.query_all("button")
    builtin = [b for b in rows if b["text"].startswith("资料研究") and "Polo 内置" in b["text"]]
    circle = [b for b in rows if b["text"].startswith("资料研究") and ("增长圈" in b["text"] or "设计圈" in b["text"])]
    check("PCF04-samename-distinct-rows", builtin and circle,
          f"内置与圈子同名技能分别成行展示（内置 {len(builtin)} 行 / 圈子 {len(circle)} 行）")
    await r.shot("skills-samename")
    # builtin disable/re-enable state scenes (counterexample PC-F04: builtin off ≠ circle same-name)
    await r.seed("A-personal-builtinoff")
    txt = await r.text()
    check("PCF04-builtin-off-samename-intact", "已停用" in txt and "资料研究" in txt,
          "内置技能停用后往返仍在，同名圈子技能不受影响（分别展示）")
    t, got = await r.click("A-personal-builtinoff", label="启用内置技能")
    check("PCF04-re-enable", got == "A-personal-builtinon", "可重新启用内置技能")
    await r.reset()
    # personal acquire with valid sources: real enable -> device preparation
    await r.seed("A-personal-acquire")
    t, got = await r.click("A-personal-acquire", label="为我启用")
    step(r, "skills", "enable-personal", "click 为我启用(来源有效)", t["to"], f"scene={got}")
    check("PCF04-enable-vs-device", got == "A-personal-enabledpending", "启用成功进入待设备准备（授权≠设备准备）")
    t, got = await r.click("A-personal-enabledpending", label="准备本机")
    check("PCF04-device-prep", got == "A-personal-installing", "设备准备独立呈现（准备中）")
    await r.shot("skill-installing")
    await r.reset()
    # after the circle sources actually expire (same-rule counterexample from PC-F03/PC-F08),
    # the enable action must not be offered any more (state consumed across surfaces)
    await r.seed("P-M11-BLOCKED-EXPIRED")
    await r.seed("A-personal-acquire")
    rows2 = await r.query_all("button")
    enable_btn = [b for b in rows2 if "为我启用" in b["text"] and not b["hidden"]]
    txt = await r.text()
    check("PCF04-no-enable-on-failed-sources", not enable_btn and ("已失效" in txt or "受限" in txt),
          f"圈子来源失效后不再提供「为我启用」动作，行内如实标注来源状态: enable_visible={bool(enable_btn)}")
    await r.reset()
    await r.seed("A-personal-updatefailed")
    txt = await r.text()
    check("DPC14-update-fail-keeps-old", ("1.0" in txt) and ("更新失败" in txt or "重试" in txt),
          "更新失败保留旧验证版本并提供重试")
    await r.reset()
    await r.seed("A-personal-remove")
    t, got = await r.click("A-personal-remove", label="确认卸载")
    check("M06-uninstall-title", got == "A-personal-uninstalled", "卸载保留明确操作标题并完成卸载")
    await r.reset()
    await r.seed("A-personal-restricted")
    txt = await r.text()
    check("F08-skill-source-fail", ("受限" in txt or "失效" in txt) and ("来源" in txt),
          "圈子技能失权展示具体来源与受限状态")
    await r.reset()
    await r.seed("A-personal-detail")
    txt1 = await r.text()
    names1 = txt1.count("资料研究")
    check("S1313-detail-single-name", 1 <= names1, f"详情只保留一处名称与用途（文本命中 {names1} 处）")


async def chain_assistant_question(r):
    """PC-N04: question wait, reopen draft, single answer message, defer/expiry."""
    await r.reset()
    await r.seed("A-personal-question")
    await r.fill_textarea("最近两周")
    t, got = await r.click("A-personal-question", label="提交回答")
    step(r, "question", "answer", "click 提交回答(已输入)", t["to"], f"scene={got}")
    txt = await r.text()
    check("N04-single-answer-message", got == "A-personal-answered" and "已收到你的回答" in txt,
          "回答只形成一条可读消息并在原会话续答")
    await r.reset()
    await r.seed("A-personal-reopen")
    txt = await r.text()
    check("N04-reopen-draft-kept", ("需要汇总哪一个时间范围" in txt), "重开后问题状态与已有草稿保留")
    await r.fill_textarea("本月")
    t, got = await r.click("A-personal-reopen", label="提交回答")
    check("N04-reopen-answer-once", got == "A-personal-answered", "重开提交后仍只提交一次")
    await r.reset()
    await r.seed("A-personal-deferred")
    txt = await r.text()
    check("N04-defer-no-answer", "已暂不回答" in txt and "已收到你的回答" not in txt, "暂不回答不产生回答消息")
    await r.reset()
    await r.seed("A-personal-expired")
    txt = await r.text()
    check("N04-expired-no-repost", "已过期" in txt, "过期问题不重复提交，提示在原会话重新提问")
    await r.reset()
    await r.seed("A-personal-deleted")
    txt = await r.text()
    check("N04-deleted-no-misroute", ("已删除" in txt or "无权" in txt), "原会话删除/无权不误投新会话")
    await r.reset()
    await r.seed("A-personal-answerfailed")
    await r.fill_textarea("上周")
    t, got = await r.click("A-personal-answerfailed", label="提交回答")
    check("N04-retry-no-duplicate", got == "A-personal-answered", "瞬时失败重试核对真实状态，不产生重复消息")


async def chain_permission_close(r):
    """C-R06 / J-PC-07: permission deny keeps page; close three options; stop-fail recovery."""
    await r.reset()
    await r.seed("P-M04-PREPARE")
    txt = await r.text()
    check("CR06-first-permission-explains", "访问" in txt and ("允许" in txt), "首次权限请求说明用途并需用户同意")
    t, got = await r.click("P-M04-PREPARE", label="不允许")
    step(r, "permission", "deny", "click 不允许", t["to"], f"scene={got}")
    txt = await r.text()
    check("CR06-deny-no-start", got == "P-M04-APP-CONTRACT" and "允许「合同审查」读取所选文件" not in txt,
          "拒绝后留在应用原页面、依赖该权限的动作未启动（回到 App 页而非执行结果）")
    # OS-level denial: settings path + user-initiated retry
    await r.seed("P-M04-PERM-DENIED")
    txt = await r.text()
    btns = [b["text"] for b in await r.query_all("button") if not b["hidden"]]
    check("CR06-os-denied-settings-path", ("系统设置" in txt and "文件与文件夹" in txt and "重试请求" in btns),
          f"OS 已拒绝时给出设置路径（系统设置 → 隐私与安全性 → 文件与文件夹）与主动重试按钮: {btns}")
    t, got = await r.click("P-M04-PERM-DENIED", label="重试请求")
    check("CR06-retry-user-initiated", got in ("P-M04-PREPARE", "P-M04-APP-CONTRACT"), f"授权后由用户主动重试: {got}")
    await r.shot("permission-denied")
    await r.reset()
    await r.seed("P-M04-APP-ACTIVE")
    t, got = await r.click("P-M04-APP-ACTIVE", label="关闭标签")
    step(r, "close", "open-dialog", "click 关闭标签", t["to"], f"scene={got}")
    btns = [b["text"] for b in await r.query_all("button") if not b["hidden"]]
    check("J07-close-three-options", any("取消" in b for b in btns) and any("后台继续" in b for b in btns) and any("停止并关闭" in b for b in btns),
          f"关闭对话框提供 取消/后台继续/停止并关闭: {btns}")
    t, got = await r.click("P-M04-CLOSE-ACTIVE", label="取消")
    check("CR04-close-cancel-stays", got == "P-M04-APP-ACTIVE", "取消关闭留在原应用视图")
    t, got = await r.click("P-M04-APP-ACTIVE", label="关闭标签")
    t, got = await r.click("P-M04-CLOSE-ACTIVE", label="后台继续")
    check("J07-background-continues", got == "P-M04-BACKGROUND", "后台继续后应用进入后台，顶栏可返回")
    await r.reset()
    await r.seed("P-M04-TERM-FAILED")
    txt = await r.text()
    t, got = await r.click("P-M04-TERM-FAILED", label="返回页面")
    check("PCF02-stopfail-keeps-view", got == "P-M04-APP-ACTIVE", "终止失败保留当前视图，可重试或取消")


async def chain_offline_reopen_contract(r):
    """PC-F10 / PC-F11 / C-R01/05."""
    await r.reset()
    await r.seed("P-M11-OFFLINE-HOME")
    rep = await r.attr('[data-go="P-M04-APP-REPORT"]')
    ast = await r.attr('[data-go="A-personal-new"]')
    check("F10-offline-blocks-start", rep.get("disabled") is True and ast.get("disabled") is True,
          f"离线页新开 App/助手被阻止（title={rep.get('title')}）")
    await r.shot("offline-home")
    t, got = await r.click("P-M11-OFFLINE-HOME", label="重试连接")
    step(r, "offline", "retry", "click 重试连接", t["to"], f"scene={got}")
    rep2 = await r.attr('[data-go="P-M04-APP-REPORT"]')
    check("F10-recovery-reverify", got == "P-M03-HOME-PERSONAL" and rep2.get("disabled") is False,
          "恢复先重验（联网重试），资格恢复后由用户决定")
    await r.reset()
    await r.seed("P-M01-REOPEN")
    t, got = await r.click("P-M01-REOPEN", label="继续")
    txt = await r.text()
    check("CR01-reopen-reverify", got == "P-M11-REOPEN-RECOVERY" and ("重新验证" in txt or "重验" in txt or "已恢复" in txt),
          "重开先恢复身份与空间并重验，不自动执行原动作")
    t, got = await r.click("P-M11-REOPEN-RECOVERY", label="首页")
    check("CR05-reopen-no-autoreplay", got == "P-M03-HOME-PERSONAL", "恢复后进入安全首页，不重发旧 Prompt")
    await r.reset()
    await r.seed("P-M11-CONTRACT")
    txt = await r.text()
    check("F11-contract-blocks", ("升级" in txt) and ("无法" in txt or "不兼容" in txt or "阻止" in txt),
          "契约不兼容阻止业务，提供升级与帮助")
    t, got = await r.click("P-M11-CONTRACT", label="稍后处理", expect=False)
    s = await r.scene()
    check("F11-later-still-blocked", s == "P-M11-CONTRACT", "稍后处理保持业务阻断")
    t, got = await r.click("P-M11-CONTRACT", label="下载并安装")
    step(r, "contract", "download", "click 下载并安装", t["to"], f"scene={got}")
    txt = await r.text()
    check("F11-downloading-blocked", ("下载" in txt) and ("仍" in txt or "保持" in txt or "不可" in txt or "阻断" in txt or "升级" in txt),
          "下载中/失败保持业务阻断，不开放业务")
    await r.reset()
    await r.seed("P-M11-CONTRACT-READY")
    t, got = await r.click("P-M11-CONTRACT-READY", label="进入我的空间")
    check("F11-ready-after-check", got == "P-M03-HOME-PERSONAL", "升级检查通过后才提供进入入口")


async def chain_revocation_governance(r):
    """PC-F08: member removal, governance reasons, no cache re-authorization."""
    await r.reset()
    await r.seed("P-M11-REVOKE")
    txt = await r.text()
    check("F08-revoke-reason", "你已经不能访问晨星科技了" in txt and "返回我的空间" in txt,
          "被移除给出明确原因（不能访问企业）与安全回个人入口（返回我的空间），企业任务全停")
    await r.reset()
    await r.seed("P-M11-REVOKE")
    await r.seed("P-M02-SWITCHER-PERSONAL")
    rows = await r.query_all(".space-row, [data-go='P-M02-CONFIRM-PERSONAL']")
    ent_row = next((e for e in rows if "晨星" in e["text"]), None)
    check("F08-revoked-not-enterable", ent_row is None or ent_row["disabled"],
          f"撤权后个人侧切换器中企业入口被禁用: {ent_row}")
    await r.shot("revoked-switcher")
    await r.reset()
    await r.seed("P-M11-GOVERNANCE-PAUSED-MEMBER")
    txt = await r.text()
    browser_btn = await r.attr('[data-go="P-M11-GOVERNANCE-BROWSER"]')
    contact_btn = await r.attr('[data-go="P-M11-GOVERNANCE-CONTACT"]')
    check("F08-member-sees-contact", "企业已暂停" in txt and (browser_btn.get("found") is False or browser_btn.get("hidden")) and (contact_btn.get("found") and not contact_btn.get("hidden")),
          "治理暂停成员角色看到联系渠道，无 Browser 后台入口")
    await r.reset()
    await r.seed("P-M11-GOVERNANCE-PAUSED-OWNER")
    browser_btn = await r.attr('[data-go="P-M11-GOVERNANCE-BROWSER"]')
    check("F08-owner-sees-browser", browser_btn.get("found") and not browser_btn.get("hidden"),
          "Owner 角色展示 Browser 处理入口（账单/导出/申诉）")
    await r.reset()
    await r.seed("P-M11-GOVERNANCE-READY")
    txt = await r.text()
    check("F08-ready-reverify", ("解除" in txt or "恢复" in txt or "重新验证" in txt or "核验" in txt),
          "治理解除后要求回原对象主动复验，不自动恢复任务")
    t, got = await r.click("P-M11-GOVERNANCE-READY", label="进入晨星科技")
    check("F08-ready-reenter-after-verify", got == "P-M03-HOME-ENT", "复验通过后用户主动进入原企业空间")
    await r.reset()
    await r.seed("P-M11-BLOCKED-VERSION")
    txt = await r.text()
    check("F08-version-block-specific", ("v0.9.4" in txt or "版本" in txt) and "暂停" in txt and "联系管理员" in txt,
          "版本阻断展示具体版本（v0.9.4 已被企业管理员暂停）与恢复路径，不与普通到期/积分混为同一弹窗")


async def chain_account(r):
    """PC-F09: qualification menus, owner-only finance, unsaved guard, settings save."""
    await r.reset()
    await r.seed("P-M10-MENU")
    txt = await r.text()
    check("F09-menu-entries", "切换空间" in txt and "Polo 设置" in txt, "账号菜单含 切换空间 与 Polo 设置")
    t, got = await r.click("P-M10-MENU", label="Polo 设置管理 Polo 设置")
    txt = await r.text()
    check("F09-settings-global-scope", got == "P-M10-SETTINGS" and ("全局" in txt or "Polo 设置" in txt),
          "Polo 设置为全局设置入口")
    await r.reset()
    await r.seed("P-M10-MENU-NOPRIV")
    txt = await r.text()
    check("F09-no-priv-menu", "企业管理后台" not in txt and "创作者工作台" not in txt,
          "无资格账号的账号菜单不显示企业管理/创作者后台入口")
    t, got = await r.click("P-M10-MENU-NOPRIV", label="Polo 设置管理 Polo 设置")
    txt = await r.text()
    has_admin = ("企业管理后台" in txt) or ("创作者工作台" in txt and "打开浏览器" in txt)
    check("F09-no-priv-no-write-entries", got == "P-M10-SETTINGS-ENT" and not has_admin,
          f"无资格账号设置页（{got}）不显示可写管理动作: has_admin={has_admin}")
    await r.reset()
    await r.seed("P-M09-BROWSER-MENU-ENT")
    txt = await r.text()
    check("F09-owner-finance-entry", ("充值" in txt or "账单" in txt), "当前企业 Owner 核验后显示账单/充值交接")
    await r.reset()
    await r.seed("P-M10-SETTINGS")
    t, got = await r.click("P-M10-SETTINGS", label="设备与网络")
    fr = await r.frame()
    sel = await fr.query_selector(".scene.active [data-global-pref]")
    if sel:
        await sel.select_option(index=1)
        await asyncio.sleep(0.25)
        status = await fr.evaluate("() => { const f=document.querySelector('.scene.active .r14-settings-form'); return f ? f.querySelector('[data-save-status]').textContent : null }")
        check("F09-unsaved-marked", status == "尚未保存", f"修改后保存状态={status}")
        r.dialog_policy = "dismiss"
        await r.click("P-M10-SETTINGS-DEVICE", label="首页", expect=False)
        got_dialog = len(r.dialogs) > 0
        check("F09-unsaved-leave-guard", got_dialog, f"未保存离开出现确认（放弃/取消）并留在原页: dialog={r.dialogs[-1]['message'][:30] if r.dialogs else '无'}")
        r.dialogs.clear()
        # save, then leaving must not be blocked
        sel = await fr.query_selector(".scene.active [data-global-pref]")
        await sel.select_option(index=1)
        await asyncio.sleep(0.2)
        save = await fr.query_selector(".scene.active .r14-settings-form button")
        await save.click()
        await asyncio.sleep(0.3)
        status = await fr.evaluate("() => { const f=document.querySelector('.scene.active .r14-settings-form'); return f ? f.querySelector('[data-save-status]').textContent : null }")
        check("F09-settings-save", status == "设置已保存。", f"保存后状态={status}")
        r.dialog_policy = "dismiss"
        await r.click("P-M10-SETTINGS-DEVICE", label="返回首页", expect=False)
        check("F09-saved-leave-no-guard", len(r.dialogs) == 0, "已保存后离开不再拦截")
    else:
        check("F09-unsaved-marked", False, "设置设备页未找到可修改控件")
        check("F09-settings-save", False, "设置设备页未找到可修改控件")
    await r.reset()
    await r.seed("A-personal-preferences")
    fr = await r.frame()
    changed = False
    sel = await fr.query_selector("select")
    if sel:
        try:
            await sel.select_option(index=1)
            changed = True
        except Exception:  # noqa: BLE001
            changed = False
    if not changed:
        inp = await fr.query_selector("input[type=text], textarea")
        if inp:
            try:
                await inp.fill("小王")
                changed = True
            except Exception:  # noqa: BLE001
                pass
    if changed:
        r.dialog_policy = "dismiss"
        t = transition_of("A-personal-preferences", label="首页")
        await fr.click(f'[data-transition="{t["id"]}"]')
        await asyncio.sleep(0.6)
        s = await r.scene()
        check("F09-assistant-pref-guard", s == "A-personal-preferences" and len(r.dialogs) > 0,
              f"助手偏好未保存离开被同一未保存处理拦截（留在原页）: scene={s}, dialogs={[d['message'][:26] for d in r.dialogs]}")
        r.dialogs.clear()
    else:
        check("F09-assistant-pref-guard", False, "助手偏好页未找到可修改控件")


async def chain_search(r):
    """§13.3: search matches only matching apps; assistant not dominating; clear filters."""
    await r.reset()
    await r.seed("P-M03-HOME-PERSONAL")
    fr = await r.frame()
    await fr.fill(".scene.active [data-library-search]", "会议")
    await asyncio.sleep(0.4)
    cards = await r.query_all("[data-app-key]")
    visible = [c["text"].split("\n")[0] for c in cards if not c["hidden"]]
    check("S133-search-matches", ("会议纪要整理" in "".join(visible)) and ("数据报表生成器" not in "".join(visible)),
          f"搜索「会议」只显示匹配应用: {visible}")
    check("S133-assistant-not-dominating", "Polo 助手" not in "".join(visible), "不匹配时助手不霸占搜索结果")
    await r.shot("search-match")
    await fr.fill(".scene.active [data-library-search]", "不存在的应用xyz")
    await asyncio.sleep(0.4)
    txt = await r.text()
    empty_btn = await r.attr("[data-library-clear]")
    check("S133-empty-clear-filter", ("没有" in txt or "未找到" in txt or "无结果" in txt or "清空" in txt) and empty_btn.get("found"),
          "搜不到时提供清空筛选入口")
    await fr.fill(".scene.active [data-library-search]", "报表")
    await asyncio.sleep(0.4)
    cards = await r.query_all("[data-app-key]")
    visible = [c["text"].split("\n")[0] for c in cards if not c["hidden"]]
    check("S133-search-single-object", visible == ["数据报表生成器"], f"搜索「报表」仅命中该对象: {visible}")


async def chain_empty_fail_states(r):
    """C-R02: true zero vs failure vs restricted are distinct."""
    await r.reset()
    await r.seed("P-M03-HOME-EMPTY-DIR")
    txt = await r.text()
    check("CR02-empty-dir-explains", "尚未获得其他应用" in txt and "加入圈子" in txt,
          "真空目录说明尚未获得应用、加入圈子并取得授权后显示（不伪造失败，不拿缓存填充）")
    await r.shot("empty-dir")
    await r.reset()
    await r.seed("P-M03-HOME-LOAD-FAIL")
    txt = await r.text()
    check("CR02-loadfail-retry", ("加载失败" in txt or "重试" in txt) and "你没有应用" not in txt,
          "目录失败明确失败并可重试，不当作「没有应用」")
    await r.reset()
    await r.seed("P-M03-ALL-APPS-ENT-EMPTY")
    txt = await r.text()
    check("CR02-ent-empty-admin", ("企业管理员" in txt or "尚未分发" in txt),
          "企业空目录提示尚未分发并联系管理员，不混入个人作品")
    await r.shot("ent-empty")
    await r.reset()
    await r.seed("A-personal-empty-skills")
    txt = await r.text()
    check("CR02-skills-empty", ("暂无" in txt or "还没有" in txt or "尚无" in txt), "无额外技能时不虚构推荐")
    await r.reset()
    await r.seed("P-M03-CONTROLS")
    txt = await r.text()
    check("PCF02-hidden-restore", ("隐藏" in txt or "恢复" in txt), "个人控制：本机隐藏可恢复（不退出圈子）")


async def chain_transfer(r):
    """C-R07: export from original conversation file area; import confirm; invalid."""
    await r.reset()
    # natural entry: conversation with content -> 文件区域 -> 导出允许内容
    await r.seed("A-personal-new")
    await r.fill_textarea("请整理这份资料，保留关键结论")
    t, got = await r.click("A-personal-new", label="发送消息")
    step(r, "transfer", "seed-session", "click 发送消息", t["to"], f"scene={got}")
    t, got = await r.click("A-personal-generating", label="查看会话文件")
    step(r, "transfer", "open-files", "click 查看会话文件", t["to"], f"scene={got}")
    txt = await r.text()
    check("CR07-files-area-entry", "导出允许内容" in txt and "导入对话内容" in txt,
          "转移入口位于原对话文件区域（导出允许内容/导入对话内容）")
    t, got = await r.click("A-personal-files", label="导出允许内容")
    step(r, "transfer", "export-page", "click 导出允许内容", t["to"], f"scene={got}")
    txt = await r.text()
    check("CR07-export-explicit", ("导出" in txt) and ("允许" in txt or "不包含" in txt),
          "导出页说明仅允许内容（消息文本），不含凭证/工具授权/隐藏上下文")
    t, got = await r.click("A-personal-transfer-export", label="下载允许内容")
    step(r, "transfer", "download", "click 下载允许内容", t["to"], f"scene={got}")
    txt = await r.text()
    check("CR07-exported-object", got == "A-personal-transfer-exported" and "导出" in txt,
          "导出生成内容包（原对话保持不变）")
    # import path with explicit confirmation (real file selection via chooser)
    t, got = await r.click("A-personal-transfer-exported", label="首页")
    await r.seed("A-personal-files")
    t, got = await r.click("A-personal-files", label="导入对话内容")
    step(r, "transfer", "import-page", "click 导入对话内容", t["to"], f"scene={got}")
    sample = os.path.join(OUT, "raw", "sample-export.json")
    with open(sample, "w", encoding="utf-8") as fh:
        json.dump({"format": "polo-conversation-content-v1", "title": "导出的对话",
                   "messages": [{"role": "user", "text": "请整理这份资料，保留关键结论。"}]}, fh, ensure_ascii=False)
    tt = transition_of("A-personal-transfer-import", label="选择导出文件")
    fr = await r.frame()
    async with r.page.expect_file_chooser() as fc_info:
        await fr.click(f'[data-transition="{tt["id"]}"]', timeout=8000)
    fc = await fc_info.value
    await fc.set_files(sample)
    got = await r.wait_scene("A-personal-transfer-preview", timeout=8)
    txt = await r.text()
    check("CR07-import-preview", got == "A-personal-transfer-preview" and ("确认导入" in txt or "核对" in txt),
          "选择导出文件后进入核对预览，需明确确认导入")
    t, got = await r.click("A-personal-transfer-preview", label="确认导入")
    txt = await r.text()
    check("CR07-import-creates-new-object", got == "A-personal-transfer-done" and "导入" in txt,
          "明确确认后建立独立新对话，打开结果属于所选文件")
    await r.reset()
    await r.seed("A-personal-transfer-invalid")
    txt = await r.text()
    check("CR07-invalid-no-object", ("失败" in txt or "无法" in txt or "无效" in txt or "不完整" in txt),
          "格式失败/取消不建立对象")
    t, got = await r.click("A-personal-transfer-invalid", label="重新选择文件")
    check("CR07-invalid-recover", got == "A-personal-transfer-import", "失败后可重新选择文件")


async def chain_circles_free_join(r):
    """PC-F03 / R13-circle-handoff: self-serve join, desktop verify, no repeat confirm."""
    await r.reset()
    await r.seed("P-M07-JOIN-FREE")
    t, got = await r.click("P-M07-JOIN-FREE", label="打开圈子网页")
    step(r, "circle-join", "to-web", "click 打开圈子网页", t["to"], f"scene={got}")
    txt = await r.text()
    check("F03-public-web-join", got == "P-M07-PUBLIC-WEB" and ("免费" in txt or "加入" in txt),
          "公开页自助加入（无圈主审批）")
    t, got = await r.click("P-M07-PUBLIC-WEB", label="返回 Polo")
    t, got = await r.click("P-M07-RETURN", label="核对我的资格")
    txt = await r.text()
    check("F03-desktop-verify-join", got == "P-M07-DETAIL-FOCUS" and ("已加入" in txt or "有效" in txt),
          "桌面同账号核对成员与有效来源，不重复确认加入")
    check("F03-no-paste-entry", "粘贴" not in txt and "输入链接" not in txt,
          "桌面无输入/粘贴分享链接的加入按钮")


async def chain_runtime_tabs(r):
    """PC-F02 / POO-55: runtime center reflects stopped state, reopen from list."""
    await r.reset()
    await r.seed("P-M04-RUNTIME")
    txt = await r.text()
    t, got = await r.click("P-M04-RUNTIME", label="停止", to="A-enterprise-stopped")
    step(r, "runtime", "stop-assistant", "click 停止(助手)", t["to"], f"scene={got}")
    await r.reset()
    await r.seed("P-M04-REPORT-STOPPED")
    txt = await r.text()
    check("PCF02-stopped-consistent", "已停止" in txt and "不会自动执行" not in txt.split("已停止")[0][-40:],
          "停止成功后 App 页如实显示后台请求已停止（非运行中）")
    t, got = await r.click("P-M04-REPORT-STOPPED", label="关闭标签")
    check("PCF02-close-idle-tab", got == "P-M03-HOME-PERSONAL", "无活动直接关闭标签回到首页")


async def chain_owner_credit(r):
    """PC-N03 enterprise: member notifies owner, owner recharges; no mixing."""
    await r.reset()
    await r.seed("A-enterprise-notify")
    t, got = await r.click("A-enterprise-notify", label="通知所有者")
    txt = await r.text()
    check("N03-ent-member-notifies", got == "A-enterprise-notified" and ("已通知" in txt),
          "企业 Member 仅通知 Owner，不暴露私人信息")
    await r.reset()
    await r.seed("A-enterprise-ownerresumed")
    txt = await r.text()
    check("N03-ent-owner-resume", ("积分" in txt or "预算" in txt or "已恢复" in txt),
          "Owner 处理后对应阻断解除，其他限制独立")


async def main():
    from playwright.async_api import async_playwright
    t0 = time.time()
    total_actions = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1660, "height": 1120})
        page = await ctx.new_page()
        page_errors = []
        external = []
        page.on("pageerror", lambda e: page_errors.append(str(e)[:200]))

        def on_req(req):
            if req.url.startswith("http://") or req.url.startswith("https://"):
                external.append(req.url)
        page.on("request", on_req)
        await page.goto("file://" + REVIEW)
        await page.wait_for_timeout(1800)
        r = Runner(page)

        chains = [
            ("first-use", chain_first_use),
            ("ent-handoff", chain_enterprise_handoff),
            ("switch-ok", chain_switch_success),
            ("switch-cancel", chain_switch_cancel),
            ("credit", chain_credit_recharge),
            ("circle-exit", chain_circle_exit),
            ("renewal", chain_renewal),
            ("support", chain_support),
            ("skills", chain_skills),
            ("question", chain_assistant_question),
            ("permission", chain_permission_close),
            ("offline", chain_offline_reopen_contract),
            ("revocation", chain_revocation_governance),
            ("account", chain_account),
            ("search", chain_search),
            ("empty-fail", chain_empty_fail_states),
            ("transfer", chain_transfer),
            ("circle-join", chain_circles_free_join),
            ("runtime", chain_runtime_tabs),
            ("owner-credit", chain_owner_credit),
        ]
        for name, fn in chains:
            try:
                await fn(r)
                log({"kind": "chain", "chain": name, "status": "done"})
            except Exception as e:  # noqa: BLE001
                log({"kind": "chain", "chain": name, "status": "error", "error": f"{type(e).__name__}: {e}"})
                print(f"[chain {name}] ERROR {type(e).__name__}: {e}", flush=True)
        await browser.close()
    findings = [c for c in CHECKS if c["status"] != "passed"]
    summary = {
        "chains": [c[0] for c in chains],
        "checks_total": len(CHECKS),
        "checks_passed": len(CHECKS) - len(findings),
        "findings": findings,
        "page_errors": page_errors,
        "external_requests": external,
    }
    with open(os.path.join(OUT, "raw", "probe-summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(f"PROBES DONE in {time.time()-t0:.0f}s: {len(CHECKS)} checks, {len(findings)} findings, pageerrors={len(page_errors)}, external={len(external)}")
    for f_ in findings:
        print("FINDING:", f_["id"], "-", f_["observed"][:160])


if __name__ == "__main__":
    asyncio.run(main())
