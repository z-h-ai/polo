#!/usr/bin/env python3
"""Round10 journey review - real-click journey chains and semantic probes.

Each chain starts from a natural entry scene, clicks actual buttons in the
active product-surface iframe ([data-go] controls), and records the observed
scene plus visible text after every click. The review shell lazily creates a
second iframe ([data-assistant-viewport] -> design-demos/polo-client-source-
baseline/prototype.html) for assistant-surface scenes; the runner selects the
frame matching the shell's current scene surface after every step.

Chains are independent: demo state is reset via the shell's [data-reset]
control before each chain; hash navigation is used only to establish the
chain's natural start scene and (where marked review_navigation) to enter a
declared review state; all other transitions are real clicks.
"""
import json
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
REVIEW = ROOT / "docs" / "mvp-complete-flow-hifi" / "review.html"
MANIFEST = ROOT / "docs" / "mvp-complete-flow-hifi" / "prototype-manifest.json"

ASSISTANT_MARKER = "polo-client-source-baseline/prototype.html"
META = {s["id"]: s for s in json.loads(MANIFEST.read_text())["scenes"]}

TEXT_JS = r"""
() => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity || '1') !== 0;
  };
  const buttons = [];
  for (const el of document.querySelectorAll('[data-go]')) {
    if (!vis(el)) continue;
    buttons.push({
      go: el.getAttribute('data-go'),
      label: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      cls: el.className.slice(0, 80)
    });
  }
  return {
    frame_scene: document.body.dataset.currentScene || null,
    text: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n'),
    buttons
  };
}
"""


def pick_frame(page, surface):
    for f in page.frames:
        if surface == "assistant":
            if ASSISTANT_MARKER in f.url:
                return f
        else:
            if f.url.startswith(REVIEW.parent.as_uri()) and f != page.main_frame \
                    and ASSISTANT_MARKER not in f.url:
                return f
    return None


def shell_scene(page):
    return page.evaluate("() => document.body.dataset.currentScene || null")


def frame_for_scene(page, scene, timeout=10.0):
    surface = (META.get(scene) or {}).get("surface", "mvp")
    deadline = time.time() + timeout
    while time.time() < deadline:
        f = pick_frame(page, surface)
        if f is not None:
            try:
                if f.evaluate("() => document.readyState") == "complete":
                    return f
            except Exception:  # noqa: BLE001
                pass
        time.sleep(0.08)
    return None


def observe(page, scene):
    f = frame_for_scene(page, scene)
    if f is None:
        return {"frame_scene": None, "text": None, "buttons": [], "error": "frame not found"}
    return f.evaluate(TEXT_JS)


def wait_scene(page, scene, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if shell_scene(page) == scene:
            f = frame_for_scene(page, scene, timeout=2)
            if f is not None:
                try:
                    if f.evaluate("() => document.body.dataset.currentScene || null") == scene:
                        return True
                except Exception:  # noqa: BLE001
                    pass
        time.sleep(0.08)
    return False


def scene_locator(f, target):
    """Scope to the rendered scene: mvp prototype keeps every scene in the DOM
    (.scene.active is the visible one); the assistant baseline renders a single
    scene at a time."""
    if ASSISTANT_MARKER in f.url:
        return f.locator(f"[data-go='{target}']")
    return f.locator(f".scene.active [data-go='{target}']")


def run_chain(page, chain, log):
    chain_id = chain["id"]
    entry = {"chain": chain_id, "purpose": chain["purpose"], "steps": []}
    # reset demo state through the shell control (real DOM click)
    page.evaluate("() => document.querySelector('[data-reset]').click()")
    page.wait_for_timeout(500)
    # navigate to natural start via hash router
    page.evaluate("s => { location.hash = '#scene=' + s }", chain["start"])
    ok = wait_scene(page, chain["start"])
    o = observe(page, chain["start"])
    entry["steps"].append({"action": "start", "expect_scene": chain["start"], "arrived": ok,
                           "observed_scene": o["frame_scene"], "text": o["text"], "buttons": o["buttons"]})
    for step in chain["steps"]:
        target = step["click"]
        label = step.get("label")
        srec = {"action": f"click [data-go='{target}']" + (f" label='{label}'" if label else ""),
                "expect_scene": step["expect"], "note": step.get("note", ""),
                "review_navigation": step.get("review_navigation", False)}
        try:
            if step.get("review_navigation"):
                page.evaluate("s => { location.hash = '#scene=' + s }", target)
                time.sleep(step.get("settle", 0.8))
            else:
                cur = shell_scene(page)
                f = frame_for_scene(page, cur)
                if f is None:
                    raise RuntimeError("no frame for current scene " + str(cur))
                loc = scene_locator(f, target)
                if label:
                    loc = loc.filter(has_text=label)
                btn = loc.first
                if btn.count() == 0:
                    raise RuntimeError("button not found in active scene: " + target)
                srec["button_disabled_before"] = btn.evaluate(
                    "el => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hidden")
                if step.get("type"):
                    ta = (f.locator(".scene.active textarea") if ASSISTANT_MARKER not in f.url
                          else f.locator("textarea")).first
                    ta.fill(step["type"])
                    srec["typed"] = step["type"]
                if step.get("file"):
                    with page.expect_file_chooser(timeout=4000) as fc_info:
                        btn.click(timeout=4000)
                    fc_info.value.set_files({
                        "name": step["file"],
                        "mimeType": "application/json",
                        "buffer": json.dumps({
                            "format": "polo-conversation-content-v1",
                            "title": "导入的对话",
                            "messages": [{"role": "user", "text": "请整理这份会议纪要"}],
                        }).encode("utf-8"),
                    })
                else:
                    try:
                        btn.click(timeout=4000)
                    except Exception as e:  # noqa: BLE001
                        if "Timeout" in repr(e) and srec["button_disabled_before"]:
                            srec["click_rejected"] = "button disabled (click did not go through)"
                            entry["steps"].append(srec)
                            continue
                        raise
            settle = step.get("settle", 1.2)
            deadline = time.time() + settle
            seen = []
            last = None
            while time.time() < deadline:
                cur = shell_scene(page)
                if cur != last:
                    seen.append(cur)
                    last = cur
                time.sleep(0.12)
            o = observe(page, shell_scene(page))
            srec["observed_scene"] = o["frame_scene"]
            srec["shell_scene_sequence"] = seen
            srec["arrived"] = wait_scene(page, step["expect"], timeout=3) or o["frame_scene"] == step["expect"]
            srec["text"] = o["text"]
            srec["buttons"] = o["buttons"]
        except Exception as e:  # noqa: BLE001
            srec["error"] = repr(e)[:300]
        entry["steps"].append(srec)
    log.append(entry)
    print(f"chain {chain_id}: {len(entry['steps'])} steps", flush=True)


def rv(scene, expect, note):
    """review navigation: enter a declared state via the hash router."""
    return {"click": scene, "expect": expect, "note": note, "review_navigation": True, "settle": 0.8}


CHAINS = [
    {
        "id": "CH-01-first-use-golden",
        "purpose": "PC-F01/PC-N01/J-PC-01: 首次登录→唯一个人空间→无使用记录首页展示完整目录→打开应用",
        "start": "P-M01-LOGIN-PASSWORD",
        "steps": [
            {"click": "P-M01-PERSONAL-PREP", "expect": "P-M01-PERSONAL-PREP", "note": "继续"},
            {"click": "P-M03-HOME-ZERO", "expect": "P-M03-HOME-ZERO", "note": "进入首页"},
            {"click": "P-M04-APP-VIEW-PERSONAL", "expect": "P-M04-APP-VIEW-PERSONAL", "note": "打开应用"},
        ],
    },
    {
        "id": "CH-02-prepare-permission",
        "purpose": "PC-F02/C-R06: 打开 App 的透明准备与文件访问权限；拒绝不启动依赖该权限的动作",
        "start": "P-M04-PREPARE",
        "steps": [
            {"click": "P-M04-APP-CONTRACT", "label": "不允许", "expect": "P-M04-APP-CONTRACT", "note": "不允许"},
            rv("P-M04-PREPARE", "P-M04-PREPARE", "回到准备态（评审导航）"),
            {"click": "P-M04-APP-CONTRACT", "label": "允许本次访问", "expect": "P-M04-APP-CONTRACT", "note": "允许本次访问"},
        ],
    },
    {
        "id": "CH-03-os-perm-denied",
        "purpose": "C-R06: OS 权限被拒时留原页、给设置路径、用户主动重试",
        "start": "P-M04-PERM-DENIED",
        "steps": [
            {"click": "P-M04-APP-CONTRACT", "label": "稍后再说", "expect": "P-M04-APP-CONTRACT", "note": "稍后再说"},
            rv("P-M04-PERM-DENIED", "P-M04-PERM-DENIED", "回到被拒场景（评审导航）"),
            {"click": "P-M04-APP-CONTRACT", "label": "重试请求", "expect": "P-M04-APP-CONTRACT", "note": "重试请求"},
        ],
    },
    {
        "id": "CH-04-close-active-background",
        "purpose": "PC-F02/§13.2/C-R04: 关闭运行中 App 的三选项；后台继续为主要动作且说明费用",
        "start": "P-M04-CLOSE-ACTIVE",
        "steps": [
            {"click": "P-M04-BACKGROUND", "expect": "P-M04-BACKGROUND", "note": "后台继续"},
            rv("P-M04-CLOSE-ACTIVE", "P-M04-CLOSE-ACTIVE", "再开关闭对话框（评审导航）"),
            {"click": "P-M04-APP-ACTIVE", "label": "取消", "expect": "P-M04-APP-ACTIVE", "note": "取消"},
            rv("P-M04-CLOSE-ACTIVE", "P-M04-CLOSE-ACTIVE", "再开关闭对话框（评审导航）"),
            {"click": "P-M03-HOME-ENT-AFTER-CLOSE", "expect": "P-M03-HOME-ENT-AFTER-CLOSE", "note": "停止并关闭"},
        ],
    },
    {
        "id": "CH-05-switch-stop-all",
        "purpose": "PC-F06/J-PC-02: 一次确认「停止全部并切换」→进度→自动进入目标；进度页无成功/失败选择",
        "start": "P-M02-CONFIRM",
        "steps": [
            {"click": "P-M02-STOPPING", "expect": "P-M03-HOME-PERSONAL", "settle": 10, "note": "停止全部并切换，观察自动序列"},
        ],
    },
    {
        "id": "CH-06-switch-cancel-before-confirm",
        "purpose": "PC-F06/C-R04: 确认前取消切换保持原空间及运行",
        "start": "P-M02-CONFIRM",
        "steps": [
            {"click": "P-M02-SWITCHER", "label": "取消切换", "expect": "P-M02-SWITCHER", "note": "取消切换"},
        ],
    },
    {
        "id": "CH-07-stop-failed-cancel",
        "purpose": "PC-F06/C-R04: 部分停止失败后取消：不复活已停项、留在原空间",
        "start": "P-M02-STOP-FAILED",
        "steps": [
            {"click": "P-M02-STOP-CANCEL", "expect": "P-M02-STOP-CANCEL", "note": "取消切换"},
            rv("P-M02-STOP-FAILED", "P-M02-STOP-FAILED", "重新进入失败态（评审导航）"),
            {"click": "P-M02-STOPPING", "expect": "P-M02-STOPPING", "note": "重试失败项"},
        ],
    },
    {
        "id": "CH-08-credit-preblock-query",
        "purpose": "PC-N03/J-PC-03: 发送前阻断保留输入；主动单次查询；未到账保持阻断；到账仅解除阻断",
        "start": "A-personal-preblock",
        "steps": [
            {"click": "A-personal-checking", "expect": "A-personal-checking", "note": "已完成，查询结果（单次查询）", "settle": 2.5},
            rv("A-personal-notyet", "A-personal-notyet", "未到账状态（评审导航）"),
            {"click": "A-personal-checking", "expect": "A-personal-checking", "note": "再次主动查询", "settle": 2.5},
            rv("A-personal-resumed", "A-personal-resumed", "到账解除阻断状态（评审导航）"),
        ],
    },
    {
        "id": "CH-09-credit-browser-roundtrip",
        "purpose": "PC-N03/C-R08: 去充值→浏览器→返回 Polo→用户主动查询；取消回阻断页",
        "start": "A-personal-preblock",
        "steps": [
            {"click": "P-M09-BROWSER", "expect": "P-M09-BROWSER", "note": "去充值"},
            {"click": "A-personal-return", "expect": "A-personal-return", "note": "返回 Polo"},
            {"click": "A-personal-checking", "expect": "A-personal-checking", "note": "已完成，查询结果", "settle": 2.5},
            rv("A-personal-preblock", "A-personal-preblock", "回到阻断（评审导航）"),
            {"click": "P-M09-BROWSER", "expect": "P-M09-BROWSER", "note": "去充值（第二次）"},
            {"click": "A-personal-preblock", "expect": "A-personal-preblock", "note": "取消"},
        ],
    },
    {
        "id": "CH-10-credit-generating-cut",
        "purpose": "PC-N03: 生成中积分耗尽停留下一段、保留部分输出、仅末尾提示",
        "start": "A-personal-cut",
        "steps": [
            {"click": "P-M09-BROWSER-STREAM", "expect": "P-M09-BROWSER-STREAM", "note": "去充值"},
            {"click": "A-personal-returnstream", "expect": "A-personal-returnstream", "note": "返回 Polo"},
            {"click": "A-personal-cut", "expect": "A-personal-cut", "note": "还没有（保持阻断）"},
            rv("A-personal-returnstream", "A-personal-returnstream", "回到返回待查（评审导航）"),
            {"click": "A-personal-checkingstream", "expect": "A-personal-checkingstream", "note": "已完成，查询结果", "settle": 2.5},
        ],
    },
    {
        "id": "CH-11-manual-stop-not-credit",
        "purpose": "PC-F04/PC-N03: 用户主动停止显示停止而非余额不足",
        "start": "A-personal-generating",
        "steps": [
            {"click": "A-personal-stopped", "expect": "A-personal-stopped", "note": "停止生成"},
        ],
    },
    {
        "id": "CH-12-circle-join-free",
        "purpose": "PC-F03/J-PC-05/R13: 分享链接→公开页免费加入→桌面同账号核对→不重复确认",
        "start": "P-M07-JOIN-FREE",
        "steps": [
            {"click": "P-M07-PUBLIC-WEB", "expect": "P-M07-PUBLIC-WEB", "note": "打开圈子网页"},
            {"click": "P-M07-RETURN", "expect": "P-M07-RETURN", "note": "返回 Polo"},
            {"click": "P-M07-DETAIL-FOCUS", "expect": "P-M07-DETAIL-FOCUS", "note": "核对我的资格"},
        ],
    },
    {
        "id": "CH-13-circle-leave-fallback",
        "purpose": "D-PC-09/S4: 退出一个来源圈后同一作品仍可打开；取消退出不变更资格",
        "start": "P-M07-LEAVE",
        "steps": [
            {"click": "P-M07-SOURCE-FALLBACK", "expect": "P-M07-SOURCE-FALLBACK", "note": "确认退出"},
            {"click": "P-M04-APP-BRAND", "expect": "P-M04-APP-BRAND", "note": "打开同一作品（仍可使用）"},
            rv("P-M07-LEAVE", "P-M07-LEAVE", "回到退出对话框（评审导航）"),
            {"click": "P-M07-DETAIL-FOCUS", "label": "取消", "expect": "P-M07-DETAIL-FOCUS", "note": "取消退出"},
        ],
    },
    {
        "id": "CH-14-circle-renew-web",
        "purpose": "PC-F03/S-015: 手动续费→浏览器支付→返回核对原单",
        "start": "P-M07-RENEW",
        "steps": [
            {"click": "P-M07-RENEW-WEB", "expect": "P-M07-RENEW-WEB", "note": "去浏览器支付"},
            {"click": "P-M07-RENEW-RETURN", "expect": "P-M07-RENEW-RETURN", "note": "返回 Polo"},
            {"click": "P-M07-RENEW-RESULT", "expect": "P-M07-RENEW-RESULT", "note": "查询原订单和资格", "settle": 2.0},
        ],
    },
    {
        "id": "CH-15-question-answer-once",
        "purpose": "PC-N04: 提问回答一次成一条消息；暂不回答不续答",
        "start": "A-personal-question",
        "steps": [
            {"click": "A-personal-answered", "expect": "A-personal-answered", "note": "提交回答", "type": "最近两周"},
            rv("A-enterprise-question", "A-enterprise-question", "企业提问（评审导航）"),
            {"click": "A-enterprise-deferred", "expect": "A-enterprise-deferred", "note": "暂不回答"},
        ],
    },
    {
        "id": "CH-16-question-reopen-deferred",
        "purpose": "PC-N04/C-R05: 重开恢复问题状态，回答/暂不回答在原会话续答",
        "start": "A-personal-reopen",
        "steps": [
            {"click": "A-personal-deferred", "expect": "A-personal-deferred", "note": "暂不回答"},
            rv("A-personal-reopen", "A-personal-reopen", "回到重开恢复态（评审导航）"),
            {"click": "A-personal-answered", "expect": "A-personal-answered", "note": "提交回答", "type": "最近两周"},
        ],
    },
    {
        "id": "CH-17-skills-acquire-enable",
        "purpose": "PC-F04/§13.6: 技能获取→启用→设备准备区分",
        "start": "A-personal-discover",
        "steps": [
            {"click": "A-personal-acquire", "expect": "A-personal-acquire", "note": "查看技能"},
            {"click": "A-personal-enabledpending", "expect": "A-personal-enabledpending", "note": "为我启用"},
            {"click": "A-personal-installing", "expect": "A-personal-installing", "note": "准备本机"},
            rv("A-personal-enabled", "A-personal-enabled", "设备就绪已启用（评审导航）"),
        ],
    },
    {
        "id": "CH-18-skill-update-fail",
        "purpose": "§13.6: 更新失败保留旧可用版本与重试入口",
        "start": "A-personal-updatefailed",
        "steps": [
            {"click": "A-personal-legacy-detail-110-1-1", "expect": "A-personal-legacy-detail-110-1-1", "note": "更新到 1.1.0（重试入口）"},
        ],
    },
    {
        "id": "CH-19-skill-restricted",
        "purpose": "PC-F08/C-R06: 技能失权不自动恢复；重新授权后不自动运行",
        "start": "A-personal-restricted",
        "steps": [
            {"click": "P-M07-DETAIL-FOCUS", "expect": "P-M07-DETAIL-FOCUS", "note": "查看来源"},
            rv("A-personal-restricted", "A-personal-restricted", "回到失权态（评审导航）"),
            {"click": "A-personal-restricted", "expect": "A-personal-restricted", "note": "重新验证来源（自环，观察是否自动恢复）"},
            rv("A-personal-reauthorized", "A-personal-reauthorized", "重新授权态（评审导航）"),
        ],
    },
    {
        "id": "CH-20-files-transfer",
        "purpose": "C-R07/D-PC-03: 导出允许内容/导入对话内容契约；文件缺失给说明与重选",
        "start": "A-personal-files",
        "steps": [
            {"click": "A-personal-transfer-export", "expect": "A-personal-transfer-export", "note": "导出允许内容"},
            {"click": "A-personal-transfer-exported", "expect": "A-personal-transfer-exported", "note": "下载允许内容"},
            rv("A-personal-transfer-import", "A-personal-transfer-import", "导入对话内容（评审导航）"),
            {"click": "A-personal-transfer-preview", "expect": "A-personal-transfer-preview", "note": "选择导出文件", "file": "notes-export.json"},
            rv("A-personal-missing", "A-personal-missing", "文件缺失状态（评审导航）"),
            {"click": "A-personal-reselected", "expect": "A-personal-reselected", "note": "重新选择文件", "file": "notes-export-2.json"},
        ],
    },
    {
        "id": "CH-21-enterprise-handoff",
        "purpose": "PC-F05/R13: 浏览器邀请完成→桌面核对→主动进入企业",
        "start": "P-M01-INVITE-BROWSER",
        "steps": [
            {"click": "P-M01-RETURN", "expect": "P-M01-RETURN", "note": "打开桌面核对"},
            {"click": "P-M01-ENTERPRISE-READY", "expect": "P-M01-ENTERPRISE-READY", "note": "核对可进入的企业"},
            {"click": "P-M03-HOME-ENT", "expect": "P-M03-HOME-ENT", "note": "主动进入企业"},
        ],
    },
    {
        "id": "CH-22-support-qr",
        "purpose": "POL-115 D-OPS-17/R13: 客服二维码与必要信息复制；返回原对象复验",
        "start": "P-M07-PAY-RETURN-FAIL",
        "steps": [
            {"click": "P-M07-SUPPORT", "expect": "P-M07-SUPPORT", "note": "联系客服"},
            {"click": "P-M07-PAY-RETURN-FAIL", "expect": "P-M07-PAY-RETURN-FAIL", "note": "返回原页面"},
            {"click": "P-M07-SUPPORT", "expect": "P-M07-SUPPORT", "note": "再次进入客服"},
            {"click": "P-M07-PAY-RETURN-FAIL", "expect": "P-M07-PAY-RETURN-FAIL", "note": "返回后仍可查询原订单"},
            {"click": "P-M07-DETAIL-PAID", "expect": "P-M07-DETAIL-PAID", "note": "查询原订单和资格"},
        ],
    },
    {
        "id": "CH-23-account-eligibility",
        "purpose": "PC-F09: 按资格展示管理入口；企业管理后台交接与责任只读",
        "start": "P-M10-MENU",
        "steps": [
            {"click": "P-M10-ADMIN-BROWSER", "expect": "P-M10-ADMIN-BROWSER", "note": "打开企业管理后台（浏览器交接）"},
            rv("P-M10-MENU-RESPONSIBILITY", "P-M10-MENU-RESPONSIBILITY", "创作者责任只读菜单（评审导航）"),
            {"click": "P-M10-RESPONSIBILITY-BROWSER", "expect": "P-M10-RESPONSIBILITY-BROWSER", "note": "打开责任只读页"},
        ],
    },
    {
        "id": "CH-24-contract-gate",
        "purpose": "PC-F11/J-PC-06: 契约不兼容阻断业务；升级失败仍阻断；成功后重查进入",
        "start": "P-M11-CONTRACT",
        "steps": [
            {"click": "P-M11-CONTRACT", "expect": "P-M11-CONTRACT", "note": "稍后处理（保持阻断）"},
            {"click": "P-M11-CONTRACT-DL", "expect": "P-M11-CONTRACT-DL", "note": "下载并安装"},
            rv("P-M11-CONTRACT-FAIL", "P-M11-CONTRACT-FAIL", "升级失败（评审导航）"),
            {"click": "P-M11-CONTRACT-DL", "expect": "P-M11-CONTRACT-DL", "note": "重试下载"},
            rv("P-M11-CONTRACT-READY", "P-M11-CONTRACT-READY", "升级检查通过（评审导航）"),
            {"click": "P-M03-HOME-PERSONAL", "expect": "P-M03-HOME-PERSONAL", "note": "进入我的空间"},
        ],
    },
    {
        "id": "CH-25-offline-home",
        "purpose": "PC-F10: 离线打开不得新开 App/助手执行",
        "start": "P-M11-OFFLINE-HOME",
        "steps": [
            {"click": "P-M04-APP-VIEW-PERSONAL", "expect": "P-M11-OFFLINE-HOME", "note": "尝试打开应用（期望被离线拒绝）"},
            rv("P-M11-OFFLINE-RUNNING", "P-M11-OFFLINE-RUNNING", "运行中断网（评审导航）"),
        ],
    },
    {
        "id": "CH-26-reopen-recovery",
        "purpose": "C-R05/PC-N04: 重开先重验身份与空间，不自动重发旧 Prompt",
        "start": "P-M01-REOPEN",
        "steps": [
            {"click": "P-M11-REOPEN-RECOVERY", "expect": "P-M11-REOPEN-RECOVERY", "note": "重开恢复"},
        ],
    },
    {
        "id": "CH-27-renew-expired-rejoin",
        "purpose": "PC-F03: 到期恢复与重新加入的区分（续费恢复 vs 重新加入）",
        "start": "P-M07-RENEW-EXPIRED",
        "steps": [
            {"click": "P-M07-PAY-BROWSER-EXPIRED", "expect": "P-M07-PAY-BROWSER-EXPIRED", "note": "去浏览器支付（到期恢复）"},
            {"click": "P-M07-PAY-RETURN", "expect": "P-M07-PAY-RETURN", "note": "返回 Polo"},
            {"click": "P-M07-DETAIL-PAID", "expect": "P-M07-DETAIL-PAID", "note": "查询原订单和资格"},
        ],
    },
    {
        "id": "CH-28-query-failed-keeps-block",
        "purpose": "PC-N03: 查询失败保持阻断、可再查，不冒充到账",
        "start": "A-personal-queryfailed",
        "steps": [
            {"click": "A-personal-checking", "expect": "A-personal-checking", "note": "再次主动查询", "settle": 2.5},
            rv("A-personal-queryfailed", "A-personal-queryfailed", "回到查询失败（评审导航）"),
            {"click": "P-M09-BROWSER", "expect": "P-M09-BROWSER", "note": "去充值"},
            {"click": "A-personal-preblock", "expect": "A-personal-preblock", "note": "取消（回到阻断）"},
        ],
    },
]


def main():
    log = []
    page_errors = []
    requests = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda e: page_errors.append(str(e)[:400]))
        page.on("request", lambda r: requests.append(r.url))
        page.goto(REVIEW.as_uri(), wait_until="load")
        page.wait_for_timeout(800)
        for chain in CHAINS:
            run_chain(page, chain, log)
            shot = OUT / "screenshots" / "journeys"
            shot.mkdir(parents=True, exist_ok=True)
            cur = shell_scene(page)
            try:
                sel = "[data-assistant-viewport]" if (META.get(cur) or {}).get("surface") == "assistant" else "[data-prototype-viewport]"
                page.query_selector(sel).screenshot(path=str(shot / f"{chain['id']}-final.png"))
            except Exception:  # noqa: BLE001
                pass
        browser.close()

    ext = []
    for u in requests:
        pr = urlparse(u)
        if pr.scheme not in ("file", "data", "blob", "about"):
            ext.append(u)
        elif pr.scheme == "file" and not u.startswith(ROOT.as_uri()):
            ext.append(u)
    (OUT / "journey-chains.json").write_text(json.dumps(log, ensure_ascii=False, indent=1))
    (OUT / "journey-summary.json").write_text(json.dumps({
        "chains": len(log),
        "click_actions": sum(max(0, len(c["steps"]) - 1) for c in log),
        "page_errors": page_errors,
        "external_requests": sorted(set(ext)),
    }, ensure_ascii=False, indent=1))
    print("chains:", len(log), "page_errors:", len(page_errors), "external:", len(set(ext)))


if __name__ == "__main__":
    main()
