#!/usr/bin/env python3
"""POO-43 guard seven-locale layout audit (326px column evidence).

For every supported locale: load the built renderer Home with the narrow
window guard visible, then verify (a) the guard renders that locale's exact
eyebrow, title, and description copy, (b) the description wraps to the
evidence-backed 2-4 line range inside the 326px column, and (c) there is no
horizontal overflow.

Copy authority (single source of truth): the locale catalogs the runtime
itself loads — packages/shared/src/i18n/locales/<locale>.json. This audit
validates runtime locale WIRING (correct catalog loaded, all three guard
fields rendered verbatim). It deliberately keeps no second hard-coded copy
map; copy-drift detection happens upstream in i18n parity checks.

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
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:19050"
LOCALES = ["zh-Hans", "en", "de", "es", "hu", "ja", "pl"]
CATALOG_DIR = Path(__file__).resolve().parents[2] / "packages" / "shared" / "src" / "i18n" / "locales"
GUARD_PREFIX = "productSpace.windowGuard"
COPY_FIELDS = ("eyebrow", "title", "description")


def load_catalog_copy(locale: str) -> dict:
    """The single copy authority: the locale catalog the runtime loads."""
    data = json.loads((CATALOG_DIR / f"{locale}.json").read_text(encoding="utf-8"))
    return {field: data[f"{GUARD_PREFIX}.{field}"] for field in COPY_FIELDS}


def mutate_rendered(metrics: dict, spec: str) -> dict:
    """Test-only negative-proof hook (used by guard-locale-audit-negative.py).

    `spec` is `<locale>:<field>`; when the extracted metrics belong to that
    locale, the RENDERED copy of that field is substituted with a wrong value
    BEFORE comparison — simulating wrong rendered copy. Production runs never
    pass a mutation spec.
    """
    locale, field = spec.split(":", 1)
    if metrics.get("expectedLocale") == locale and field in metrics:
        metrics[field] = f"__mutated_wrong_{field}__"
    return metrics


def run_audit(locales=None, mutate: str | None = None, base: str = BASE) -> dict:
    """Runs the audit and returns {code, failures, locales}. Prints the JSON report."""
    locales = list(locales) if locales else LOCALES
    out = {}
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for loc in locales:
            ctx = browser.new_context(viewport={"width": 390, "height": 844})
            page = ctx.new_page()
            page.add_init_script(f"window.localStorage.setItem('i18nextLng', {json.dumps(loc)})")
            page.goto(f"{base}/?__e2e_view=home&__e2e_scenario=visual_home",
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
                description: desc?.textContent ?? '',
                descLines,
                horizontalOverflow: doc.scrollWidth > doc.clientWidth,
                guardWithinViewport: guardRect.width <= doc.clientWidth + 1,
              };
            }""")
            metrics["expectedLocale"] = loc
            if mutate:
                metrics = mutate_rendered(metrics, mutate)
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
            expected = load_catalog_copy(loc)
            for field in COPY_FIELDS:
                rendered = metrics.get(field)
                if rendered != expected[field]:
                    failures.append(
                        f"{loc}: {field} copy mismatch vs locale catalog: got {rendered!r}, want {expected[field]!r}"
                    )
            ctx.close()
        try:
            browser.close()
        except Exception:
            pass
    print(json.dumps({"failures": failures, "locales": out}, ensure_ascii=False, indent=1))
    return {"code": 1 if failures else 0, "failures": failures, "locales": out}


def main() -> None:
    sys.exit(run_audit()["code"])


if __name__ == "__main__":
    main()
