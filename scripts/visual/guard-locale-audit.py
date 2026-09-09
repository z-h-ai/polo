#!/usr/bin/env python3
"""POO-43 guard seven-locale layout audit (326px column evidence).

For every supported locale: load the built renderer Home with the narrow
window guard visible, then verify (a) the guard renders that locale's exact
localized copy, (b) the description wraps to the evidence-backed 2-4 line
range inside the 326px column, and (c) there is no horizontal overflow.

Intended invariant (matches the R42 committed acceptance tooling and the
R43 reviewer audit at HEAD 628be0e4): description wrap counts of
zh-Hans=2, en=3, de=3, es=4, hu=4, ja=3, pl=3 are the observed real-font
values; the assertion accepts the full 2-4 range so ±1 line of font
rounding cannot fail the audit, while >4 lines ( runaway wrap) or <2 lines
(clip) still fail.

Backs the fixed 326px column compensation in WindowWidthGuard.tsx across
all supported locales.
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:19050"
LOCALES = ["zh-Hans", "en", "de", "es", "hu", "ja", "pl"]


EXPECTED_COPY = {
    'zh-Hans': {'eyebrow': '窗口保护', 'title': '窗口过窄'},
    'en': {'eyebrow': 'Window protection', 'title': 'Window too narrow'},
    'de': {'eyebrow': 'Fensterschutz', 'title': 'Fenster zu schmal'},
    'es': {'eyebrow': 'Protección de ventana', 'title': 'Ventana demasiado estrecha'},
    'hu': {'eyebrow': 'Ablakvédelem', 'title': 'Az ablak túl keskeny'},
    'ja': {'eyebrow': 'ウィンドウ保護', 'title': 'ウィンドウが狭すぎます'},
    'pl': {'eyebrow': 'Ochrona okna', 'title': 'Okno zbyt wąskie'},
}


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
            expected = EXPECTED_COPY.get(loc, {})
            if metrics.get("eyebrow") != expected.get("eyebrow"):
                failures.append(f"{loc}: eyebrow copy mismatch: got {metrics.get('eyebrow')!r}, want {expected.get('eyebrow')!r}")
            if metrics.get("title") != expected.get("title"):
                failures.append(f"{loc}: title copy mismatch: got {metrics.get('title')!r}, want {expected.get('title')!r}")
            ctx.close()
        try:
            browser.close()
        except Exception:
            pass
    print(json.dumps({"failures": failures, "locales": out}, ensure_ascii=False, indent=1))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
