#!/usr/bin/env python3
"""POO-43 Home scroll-owner + keyboard-traversal regression.

Real-browser production-path check against renderer-host + the acceptance
boot shim (visual_home scenario):

- the dedicated wrapper owns viewport-bounded vertical scrolling;
- plain Tab traversal from 管理首页 Apps reaches 全部 Apps and every App
  action, advancing the wrapper's scrollTop past the fold.

Run (requires python3 with playwright and Chromium installed):

  # 1. start the acceptance services (admin-stub 19030, headless server
  #    19040/19041, renderer-host 19050) exactly as the A4 execution does
  # 2. python3 scripts/visual/home-scroll-reachability.py

Exit 0 when every check passes; non-zero with a JSON failure report.
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:19050"
SHORT_WINDOW = {"width": 1280, "height": 420}


def wait_home_ready(page, timeout=45.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(
            "document.querySelectorAll('[data-testid=home-quick-entry]').length >= 2"
            " && !document.querySelector('[data-testid=home-quick-access-loading]')"
        ):
            return True
        time.sleep(0.4)
    return False


def main():
    failures = []
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ── scroll owner: short window forces overflow; scrolling must reach
        #    the last management control ──
        page = browser.new_page(viewport=SHORT_WINDOW)
        page.goto(f"{BASE}/?__e2e_view=home&__e2e_scenario=visual_home",
                  wait_until="domcontentloaded", timeout=60000)
        if not wait_home_ready(page):
            failures.append("home did not become ready")
        else:
            time.sleep(1.0)
            state = page.evaluate("""() => {
              const wrapper = document.querySelector('[data-testid=home-app-hub]').parentElement;
              const overflowY = getComputedStyle(wrapper).overflowY;
              const lastManage = document.querySelector('[data-testid=home-manage-quick-access]');
              const before = lastManage.getBoundingClientRect().top;
              wrapper.scrollTop = wrapper.scrollHeight;
              const after = lastManage.getBoundingClientRect().top;
              return {
                overflowY,
                clientHeight: wrapper.clientHeight,
                scrollHeight: wrapper.scrollHeight,
                scrollTop: wrapper.scrollTop,
                lastManageReachable: after < wrapper.getBoundingClientRect().bottom,
              };
            }""")
            results["scrollOwner"] = state
            if state["overflowY"] != "auto":
                failures.append(f"wrapper overflowY={state['overflowY']}")
            if state["scrollHeight"] <= state["clientHeight"]:
                failures.append("fixture did not overflow — test data too small")
            if not state["lastManageReachable"]:
                failures.append("last management control not reachable after scroll")

        # ── keyboard traversal: plain Tab from the management entry ──
        page2 = browser.new_page(viewport=SHORT_WINDOW)
        page2.goto(f"{BASE}/?__e2e_view=home&__e2e_scenario=visual_home",
                   wait_until="domcontentloaded", timeout=60000)
        if not wait_home_ready(page2):
            failures.append("home did not become ready (keyboard pass)")
        else:
            time.sleep(1.0)
            page2.locator("[data-testid=home-manage-quick-access]").focus()
            seen = []
            scrolls = []
            for _ in range(16):
                page2.keyboard.press("Tab")
                time.sleep(0.12)
                seen.append(page2.evaluate(
                    "(document.activeElement?.getAttribute('data-testid') || document.activeElement?.textContent || '').trim().slice(0, 24)"))
                scrolls.append(page2.evaluate(
                    "document.querySelector('[data-testid=home-app-hub]').parentElement.scrollTop"))
            results["keyboard"] = {"visited": seen, "maxWrapperScroll": max(scrolls)}
            if "home-all-apps-open" not in seen:
                failures.append("plain Tab never reached 全部 Apps")
            if not any("打开" in entry for entry in seen):
                failures.append("plain Tab never reached an App action")
            if max(scrolls) <= 0:
                failures.append("focus traversal never advanced the scroll owner")

        page2.close()
        browser.close()

    print(json.dumps({"failures": failures, "results": results},
                     ensure_ascii=False, indent=1))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
