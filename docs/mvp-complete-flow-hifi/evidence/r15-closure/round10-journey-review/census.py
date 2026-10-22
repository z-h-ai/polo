#!/usr/bin/env python3
"""Round10 journey review - full scene x viewport census.

Independent reviewer script. Drives docs/mvp-complete-flow-hifi/review.html
via its hash router (#scene=<id>) and the declared viewport select, and
records per observation: visible text, visible controls, shell/frame scene
agreement, page errors and network requests.
"""
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[5]  # repo root
OUT = Path(__file__).resolve().parent
REVIEW = ROOT / "docs" / "mvp-complete-flow-hifi" / "review.html"
MANIFEST = ROOT / "docs" / "mvp-complete-flow-hifi" / "prototype-manifest.json"

VIEWPORTS = ["desktop-1440x900", "desktop-1024x768", "desktop-800x600"]
SCREENSHOT_VIEWPORT = "desktop-1440x900"
# parallel workers may filter which viewports this process handles
_vp_filter = os.environ.get("CENSUS_VIEWPORTS")
if _vp_filter:
    VIEWPORTS = [v for v in VIEWPORTS if v in _vp_filter.split(",")]

manifest = json.loads(MANIFEST.read_text())
scene_ids = [s["id"] for s in manifest["scenes"]]
_limit = int(os.environ.get("CENSUS_SCENE_LIMIT", "0"))
if _limit > 0:
    scene_ids = scene_ids[:_limit]
scene_meta = {s["id"]: s for s in manifest["scenes"]}
story_step_scenes = []
for st in manifest["stories"]:
    for step in st.get("steps", []):
        if step["scene"] not in story_step_scenes:
            story_step_scenes.append(step["scene"])

COLLECT_JS = r"""
() => {
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    if (parseFloat(st.opacity || '1') === 0) return false;
    return true;
  };
  const label = el => {
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (t) return t.slice(0, 160);
    const al = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('value') || '';
    return al.trim().replace(/\s+/g, ' ').slice(0, 160);
  };
  const controls = [];
  const sel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], summary, [onclick], [data-action]';
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const st = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    controls.push({
      tag: el.tagName.toLowerCase(),
      kind: el.getAttribute('role') || (el.tagName === 'INPUT' ? el.type || 'text' : el.tagName.toLowerCase()),
      label: label(el),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      hidden_attr: el.hasAttribute('hidden'),
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(','),
      opacity: st.opacity,
      pointer_events: st.pointerEvents
    });
  }
  return {
    frame_scene: document.body.dataset.currentScene || null,
    title: document.title,
    text: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n'),
    controls
  };
}
"""

ASSISTANT_MARKER = "polo-client-source-baseline/prototype.html"


def pick_frame(page, surface):
    """Return the content frame for the scene's product surface.

    The review shell lazily creates a second iframe ([data-assistant-viewport],
    src = design-demos/polo-client-source-baseline/prototype.html) for
    assistant-surface scenes and hides the other frame.
    """
    for f in page.frames:
        if surface == "assistant":
            if ASSISTANT_MARKER in f.url:
                return f
        else:
            if f.url.startswith(REVIEW.parent.as_uri()) and f != page.main_frame \
                    and ASSISTANT_MARKER not in f.url:
                return f
    return None


def main():
    errors = []
    requests = []
    observations = 0
    census_path = OUT / ("census.jsonl" if not os.environ.get("CENSUS_OUT") else os.environ["CENSUS_OUT"])
    shot_dir = OUT / "screenshots" / "census"
    shot_dir.mkdir(parents=True, exist_ok=True)
    # resume support: skip (scene, viewport) pairs already recorded
    done = set()
    if census_path.exists():
        for line in census_path.read_text().splitlines():
            try:
                r = json.loads(line)
                done.add((r["scene"], r["viewport"]))
            except Exception:  # noqa: BLE001
                pass
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda e: errors.append({"where": "shell", "message": str(e)[:500]}))
        page.on("request", lambda r: requests.append(r.url))
        page.goto(REVIEW.as_uri(), wait_until="load")
        page.wait_for_timeout(800)
        frame_el = page.query_selector("[data-prototype-viewport]")

        vp_select = page.query_selector("[data-viewport-select]")
        for vp in VIEWPORTS:
            # the select lives in the (closed) settings panel; set value and
            # dispatch change the same way the shell's own listener expects
            page.evaluate(
                "v => { const s = document.querySelector('[data-viewport-select]'); s.value = v; s.dispatchEvent(new Event('change', {bubbles: true})); }",
                vp,
            )
            page.wait_for_timeout(400)
            for sid in scene_ids:
                if (sid, vp) in done:
                    continue
                surface = scene_meta[sid].get("surface", "mvp")
                rec = {"scene": sid, "surface": surface,
                       "title": scene_meta[sid].get("title"), "viewport": vp}
                try:
                    page.evaluate("s => { location.hash = '#scene=' + s }", sid)
                    # wait for the surface frame for this scene
                    deadline = time.time() + 12
                    inner = None
                    while time.time() < deadline:
                        inner = pick_frame(page, surface)
                        if inner is not None:
                            try:
                                if inner.evaluate("() => document.readyState") == "complete":
                                    break
                            except Exception:  # noqa: BLE001
                                pass
                        page.wait_for_timeout(80)
                    if inner is None:
                        raise RuntimeError("surface frame not found for " + surface)
                    # wait for frame scene to match
                    deadline = time.time() + 8
                    ok = False
                    while time.time() < deadline:
                        cur = inner.evaluate("() => document.body.dataset.currentScene || null")
                        if cur == sid:
                            ok = True
                            break
                        page.wait_for_timeout(60)
                    page.wait_for_timeout(260)  # let transitions/settle
                    data = inner.evaluate(COLLECT_JS)
                    rec["frame_scene"] = data["frame_scene"]
                    rec["scene_match"] = ok and data["frame_scene"] == sid
                    rec["text"] = data["text"]
                    rec["controls"] = data["controls"]
                    rec["control_count"] = len(data["controls"])
                except Exception as e:  # noqa: BLE001
                    rec["error"] = repr(e)[:400]
                    try:
                        page.goto(REVIEW.as_uri() + "#scene=" + sid, wait_until="load")
                        page.wait_for_timeout(600)
                    except Exception:
                        pass
                observations += 1
                with census_path.open("a") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                if vp == SCREENSHOT_VIEWPORT and sid in story_step_scenes:
                    try:
                        sel = "[data-assistant-viewport]" if surface == "assistant" else "[data-prototype-viewport]"
                        el = page.query_selector(sel)
                        el.screenshot(path=str(shot_dir / f"{sid}@{vp}.png"))
                    except Exception as e:  # noqa: BLE001
                        errors.append({"where": "screenshot", "scene": sid, "message": repr(e)[:200]})
            print(f"viewport {vp} done, observations={observations}", flush=True)
        browser.close()

    external = []
    for u in requests:
        pr = urlparse(u)
        if pr.scheme not in ("file", "data", "blob", "about"):
            external.append(u)
        elif pr.scheme == "file" and not u.startswith(ROOT.as_uri()):
            external.append(u)
    summary = {
        "run_viewports": VIEWPORTS,
        "observations_this_run": observations,
        "resumed_already_done": len(done),
        "page_errors": errors,
        "external_requests": sorted(set(external)),
        "request_count": len(requests),
    }
    (OUT / ("census-summary.json" if not os.environ.get("CENSUS_OUT") else os.environ["CENSUS_OUT"] + ".summary.json")).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "page_errors"}, ensure_ascii=False))
    print("page_errors:", len(errors))


if __name__ == "__main__":
    main()
