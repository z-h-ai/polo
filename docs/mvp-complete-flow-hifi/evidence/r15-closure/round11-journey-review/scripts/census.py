#!/usr/bin/env python3
"""round11-journey-review: full render census of review.html shell.

Covers every manifest scene x declared logical viewport. Collects visible text,
visible control inventory, pageerror and request events. Writes JSONL per
viewport plus key screenshots. Read-only with respect to the reviewed bundle.
"""
import asyncio
import json
import os
import sys
import time
from urllib.parse import quote

from playwright.async_api import async_playwright

ROOT = "/Users/wow/project/z-h-ai/polo-dir/POO-70/docs/client-journey-policy-interview"
OUT = os.path.join(ROOT, "docs/mvp-complete-flow-hifi/evidence/r15-closure/round11-journey-review")
REVIEW = os.path.join(ROOT, "docs/mvp-complete-flow-hifi/review.html")
VIEWPORTS = [("desktop-1440x900", 1440, 900), ("desktop-1024x768", 1024, 768), ("desktop-800x600", 800, 600)]
SETTLE_MS = 380


async def poll_until(page, expr, arg=None, timeout_s=12.0, interval_s=0.12):
    """Poll page.evaluate until expr is truthy. Avoids wait_for_function (rAF
    polling is starved in this environment's background tasks)."""
    deadline = asyncio.get_event_loop().time() + timeout_s
    last = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            last = await page.evaluate(expr, arg)
        except Exception as e:  # noqa: BLE001
            last = f"eval-error: {e}"
        if last is True:
            return True
        await asyncio.sleep(interval_s)
    return False

EXTRACT_CONTROLS = """() => {
  const doc = document;
  if (!doc || !doc.body) return null;
  const vis = el => {
    const r = el.getClientRects();
    if (!r.length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const sel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [onclick], summary, [tabindex]';
  const seen = new Set();
  const controls = [];
  for (const el of doc.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const key = el.tagName + '|' + label + '|' + (el.id || '') + '|' + (el.className && typeof el.className === 'string' ? el.className.slice(0, 40) : '');
    if (seen.has(key)) continue;
    seen.add(key);
    controls.push({tag: el.tagName.toLowerCase(), label, id: el.id || undefined, cls: typeof el.className === 'string' ? el.className.slice(0, 60) : undefined, disabled: el.disabled || undefined});
  }
  const sceneMarker = doc.querySelector('.scene.active')?.getAttribute('data-prototype-scene') || undefined;
  return {text: doc.body.innerText, controls, sceneMarker};
}"""


async def active_frame(page):
    """Return the Playwright Frame of the currently visible product iframe."""
    best = None
    for fr in page.frames:
        if fr == page.main_frame:
            continue
        try:
            el = await fr.frame_element()
        except Exception:  # noqa: BLE001
            continue
        if await el.is_visible():
            best = fr
    return best


async def run_viewport(pw_browser, vid, width, height, scenes, sem):
    async with sem:
        ctx = await pw_browser.new_context(viewport={"width": width + 220, "height": height + 220})
        page = await ctx.new_page()
        events = {"pageerror": [], "console_error": [], "requests": [], "external": []}
        page.on("pageerror", lambda e: events["pageerror"].append({"where": "page", "msg": str(e)[:300]}))
        page.on("console", lambda m: events["console_error"].append({"where": m.location.get("url", "")[:120] if m.location else "", "msg": m.text[:300]}) if m.type == "error" else None)

        def on_request(req):
            url = req.url
            events["requests"].append(url)
            if url.startswith("http://") or url.startswith("https://"):
                events["external"].append(url)
        page.on("request", on_request)

        await page.goto("file://" + REVIEW)
        await page.wait_for_timeout(1200)
        out = open(os.path.join(OUT, "raw", f"census-{vid}.jsonl"), "w", encoding="utf-8")
        n_ok = 0
        for i, sc in enumerate(scenes):
            sid, surface = sc["id"], sc["surface"]
            rec = {"scene": sid, "viewport": vid, "surface": surface, "module": sc["module"]}
            try:
                await page.evaluate(f"location.hash = '#scene=' + {json.dumps(sid)}")
                # wait for shell currentScene to match
                ok = await poll_until(page, "sid => document.body.dataset.currentScene === sid", arg=sid)
                if not ok:
                    raise RuntimeError("shell currentScene never matched")
                # wait for the active product iframe document to be ready (frame API;
                # file:// iframes are cross-origin so contentDocument is not reachable)
                ok = False
                for _ in range(100):
                    fr = await active_frame(page)
                    if fr is not None:
                        try:
                            if await fr.evaluate("document.readyState === 'complete' && !!document.body"):
                                ok = True
                                break
                        except Exception:  # noqa: BLE001
                            pass
                    await asyncio.sleep(0.12)
                if not ok:
                    raise RuntimeError("iframe document never ready")
                await page.wait_for_timeout(SETTLE_MS)
                fr = await active_frame(page)
                data = await fr.evaluate(EXTRACT_CONTROLS) if fr else None
                if data is None:
                    rec["error"] = "no active iframe document"
                else:
                    rec["text_chars"] = len(data["text"])
                    rec["text"] = data["text"][:24000]
                    rec["controls"] = data["controls"]
                    rec["control_count"] = len(data["controls"])
                    rec["scene_marker"] = data.get("sceneMarker")
                    rec["shell_scene"] = await page.evaluate("document.body.dataset.currentScene")
                    n_ok += 1
            except Exception as e:  # noqa: BLE001
                rec["error"] = f"{type(e).__name__}: {str(e)[:200]}"
            rec["page_errors_so_far"] = len(events["pageerror"])
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if (i + 1) % 50 == 0:
                print(f"[{vid}] {i+1}/{len(scenes)} ok={n_ok} errs={len(events['pageerror'])} ext={len(events['external'])}", flush=True)
        # key screenshots at this viewport: first scene of each module + a fixed key list
        key_ids = key_scene_ids(scenes)
        for sid in key_ids:
            try:
                await page.evaluate(f"location.hash = '#scene=' + {json.dumps(sid)}")
                if not await poll_until(page, "sid => document.body.dataset.currentScene === sid", arg=sid):
                    raise RuntimeError("scene never matched")
                await page.wait_for_timeout(SETTLE_MS + 120)
                frame_el = await page.query_selector("iframe:not([hidden])")
                safe = sid.replace("/", "_")
                await frame_el.screenshot(path=os.path.join(OUT, "shots", f"{safe}-{vid}.png"))
            except Exception as e:  # noqa: BLE001
                print(f"[{vid}] shot fail {sid}: {e}", flush=True)
        summary = {
            "viewport": vid, "scenes": len(scenes), "rendered_ok": n_ok,
            "pageerror": events["pageerror"], "console_errors": events["console_error"][:50],
            "console_error_count": len(events["console_error"]),
            "request_count": len(events["requests"]),
            "external_requests": events["external"],
        }
        with open(os.path.join(OUT, "raw", f"census-{vid}-summary.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=1)
        out.close()
        await ctx.close()
        print(f"[{vid}] DONE ok={n_ok} pageerrors={len(events['pageerror'])} external={len(events['external'])} requests={len(events['requests'])}", flush=True)
        return summary


def key_scene_ids(scenes):
    seen = set()
    keys = []
    for s in scenes:
        if s["module"] not in seen:
            seen.add(s["module"])
            keys.append(s["id"])
    extra = [
        "P-M02-STOP-CONFIRM", "P-M02-STOP-PROGRESS", "P-M02-STOP-FAILED",
        "P-M07-DETAIL-FOCUS", "P-M09-CHECKING", "P-M11-REVOKE",
        "A-personal-preblock", "A-personal-cut", "A-enterprise-question",
    ]
    known = {s["id"] for s in scenes}
    for e in extra:
        if e in known:
            keys.append(e)
    return keys


async def main():
    scenes = json.load(open(os.path.join(OUT, "raw", "scene-list.json"), encoding="utf-8"))
    os.makedirs(os.path.join(OUT, "shots"), exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        sem = asyncio.Semaphore(3)
        summaries = await asyncio.gather(*[
            run_viewport(browser, vid, w, h, scenes, sem) for vid, w, h in VIEWPORTS
        ])
        await browser.close()
        with open(os.path.join(OUT, "raw", "census-total.json"), "w", encoding="utf-8") as f:
            json.dump(summaries, f, ensure_ascii=False, indent=1)
        print("ALL DONE", flush=True)


if __name__ == "__main__":
    t0 = time.time()
    asyncio.run(main())
    print(f"elapsed {time.time()-t0:.0f}s", flush=True)
