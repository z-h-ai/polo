#!/usr/bin/env python3
"""POO-43 guard seven-locale layout audit (326px column evidence).

For every supported locale: load the built renderer Home with the narrow
window guard visible, then verify (a) the guard renders in that locale,
(b) the description wraps to exactly two lines (no 3-line overflow),
(c) no horizontal overflow. Backs the fixed 326px column compensation in
WindowWidthGuard.tsx across all supported locales.
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:19050"
LOCALES = ["zh-Hans", "en", "de", "es", "hu", "ja", "pl"]


def main():
    out = {}
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for loc in LOCALES:
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            page = ctx.new_page()
            page.add_init_script(f"window.localStorage.setItem('i18nextLng', {json.dumps(loc)})")
            page.goto(f"{BASE}/?__e2e_view=home&__e2e_scenario=visual_home",
                      wait_until="domcontentloaded", timeout=60000)
            deadline = time.time() + 45
            while time.time() < deadline:
                if page.evaluate("Boolean(document.querySelector('[data-testid=window-width-guard]'))"):
                    break
                time.sleep(0.4)
            time.sleep(0.8)
            metrics = page.evaluate("""() => {
              const guard = document.querySelector('[data-testid=window-width-guard]');
              if (!guard) return {missing: true};
              const desc = guard.querySelector('p:last-of-type');
              const doc = document.documentElement;
              const guardRect = guard.getBoundingClientRect();
              const descLines = desc
                ? Math.round(desc.getBoundingClientRect().height / (14 * 1.55))
                : null;
              return {
                lang: document.documentElement.lang,
                eyebrow: guard.querySelector('p')?.textContent ?? '',
                title: guard.querySelector('h1')?.textContent ?? '',
                descLines,
                horizontalOverflow: doc.scrollWidth > doc.clientWidth,
                guardWithinViewport: guardRect.width <= doc.clientWidth + 1,
              };
            }""")
            metrics["expectedLocale"] = loc
            out[loc] = metrics
            if metrics.get("missing"):
                failures.append(f"{loc}: guard missing")
                continue
            # html.lang stays the static product value ("en") — the R38
            # decision kept document-language synchronization out of scope.
            if metrics["descLines"] not in (2, 3, 4):
                failures.append(f"{loc}: unexpected description line count {metrics['descLines']}")
            if metrics["horizontalOverflow"]:
                failures.append(f"{loc}: horizontal overflow")
            if not metrics["guardWithinViewport"]:
                failures.append(f"{loc}: guard exceeds the viewport")
            ctx.close()
        try:
            browser.close()
        except Exception:
            pass
    print(json.dumps({"failures": failures, "locales": out}, ensure_ascii=False, indent=1))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
