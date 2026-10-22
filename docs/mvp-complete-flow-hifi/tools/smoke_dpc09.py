#!/usr/bin/env python3
"""D-PC-09 多圈授权去重、逐来源失效与企业隔离冒烟。"""

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BUNDLE = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((BUNDLE / "prototype-manifest.json").read_text(encoding="utf-8"))


def main() -> int:
    problems = []
    confirmations = {item["id"] for item in MANIFEST["confirmations"]}
    if "D-PC-09" not in confirmations:
        problems.append("manifest missing D-PC-09")
    if not any(story["id"] == "S4" for story in MANIFEST["stories"]):
        problems.append("manifest missing S4")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.goto((BUNDLE / "surface.html").as_uri() + "#scene=P-M03-ALL-APPS")

        def activate(scene):
            page.evaluate(
                """(scene) => window.postMessage({type:'product-ui-prototype:show-scene', version:1,
                     session:'dpc09', epoch:0, scene, theme:'light', language:'zh-CN'}, '*')""",
                scene,
            )
            page.wait_for_function("(scene) => document.body.dataset.currentScene === scene", arg=scene)

        activate("P-M03-ALL-APPS")
        content = page.locator('.scene.active').inner_text()
        if content.count("会议纪要整理") != 1:
            problems.append(f"dedupe failed: meeting app appears {content.count('会议纪要整理')} times")
        if "2 个有效来源 · 晨星增长圈、晨星设计圈" not in content:
            problems.append("deduped card does not show two valid sources")
        if "晨星增长工作室 · 1 个独有 App · 1 个共同授权作品" not in content:
            problems.append("multi-circle example is not visibly owned by the same creator")

        page.locator('.scene.active [data-go="P-M07-DETAIL-FOCUS"]').first.click()
        page.locator('.scene.active [data-go="P-M07-LEAVE"]').first.click()
        page.locator('.scene.active [data-go="P-M07-SOURCE-FALLBACK"]').click()
        page.wait_for_function("document.body.dataset.currentScene === 'P-M07-SOURCE-FALLBACK'")
        content = page.locator('.scene.active').inner_text()
        if "仍可使用 · 晨星设计圈有效；晨星增长圈来源已撤销" not in content:
            problems.append("single-source loss does not retain alternate source")

        activate("P-M07-EXPIRED")
        row = page.locator('.scene.active .circle-work-row', has_text="会议纪要整理")
        if "仍由晨星增长圈授权" not in row.inner_text():
            problems.append("expired circle does not show alternate source")
        if row.locator('button', has_text="仍可打开").is_disabled():
            problems.append("alternate-source open action is disabled")

        activate("P-M11-BLOCKED-EXPIRED")
        content = page.locator('.scene.active').inner_text()
        if "最后一个有效来源已失效" not in content:
            problems.append("last-source blocked state missing")
        if "晨星科技 · App 工作区" in content or "企业空间 · Member" in content:
            problems.append("personal circle blocked state leaked into enterprise context")
        runtime = page.locator('.scene.active #runtime-menu').inner_text()
        if "运行状态 · 我的空间" not in runtime or "运行状态 · 晨星科技" in runtime:
            problems.append("last-source runtime popover leaked enterprise context")

        activate("P-M03-HOME-ENT")
        content = page.locator('.scene.active').inner_text()
        for forbidden in ("晨星增长圈", "晨星设计圈", "北极星设计圈", "我的圈子"):
            if forbidden in content:
                problems.append(f"enterprise home leaks personal circle content: {forbidden}")
        if "企业内部导入 · 晨星科技" not in content:
            problems.append("enterprise source line missing")

        if errors:
            problems.extend(errors[:5])
        browser.close()

    if problems:
        print("PROBLEMS:")
        for problem in problems:
            print(" -", problem)
        return 1
    print("D-PC-09 smoke OK: dedupe/source fallback/last-source block/enterprise isolation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
