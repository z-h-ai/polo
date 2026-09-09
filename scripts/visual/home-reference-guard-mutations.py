#!/usr/bin/env python3
"""POO-43 adversarial mutation suite for the Home reference contract guard.

Durable TRACKED regression coverage (R56→R66). Every reject case runs against
ISOLATED TEMPORARY COPIES of the authority trio (oracle / aligned reference /
companion contract) with the sandbox passed explicitly as ``references_dir``,
and asserts the guard fails for its INTENDED reason. Allow controls assert
explicit success (no false positives). Cases:

- 16 prior cases (R59 A1-A3 + B1-B7 + R61 ×5, R54 supplied-path isolation)
- 8 exact R63 regressions
- 11 failing R65 adjacent reject cases + 4 mixed-separator exclusion claims
- allow controls: commented-out hiding rule, unmatched ancestor selector,
  unmatched compound selector, hidden duplicate heading/source, POO-47
  exclusion preservation, normal canonical link

The tracked authority files must remain byte-for-byte unchanged and the real
baseline guard must be green after the suite. Exit 0 only when every case
behaves as intended.
"""
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts/visual/home-reference-contract-guard.py"
ORACLE = ROOT / ".pipeline/acceptance-repair-poo43/frozen-sources/poo41/space-home-light-zh-Hans-desktop.html"
REFERENCE = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned-light-zh-Hans-desktop.html"
CONTRACT = ROOT / ".agents/skills/polo-client-design/assets/design-context/references/space-home-poo43-aligned.contract.md"
REFERENCES_DIR = REFERENCE.parent

spec = importlib.util.spec_from_file_location("home_reference_contract_guard", GUARD)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

CASES: list[dict] = []

MANAGE = '<button class="quiet-link">管理首页 Apps</button>'
ALL_APPS = '<button class="quiet-link">全部 Apps</button>'
CANONICAL = "[`space-home-poo43-aligned-light-zh-Hans-desktop.html`](./space-home-poo43-aligned-light-zh-Hans-desktop.html)"
HEAD_ACTIONS_WRAP = '<div class="head-actions">{manage}{allapps}</div>'


# ── data-driven reject cases (target, old, new, intended fragment) ──
REJECT_CASES = [
    # R59 sealed regressions
    ("R59-A1 manage button -> span hidden", "reference",
     MANAGE, "<span hidden>管理首页 Apps</span>", "管理首页 Apps"),
    ("R59-A2 all-apps button -> non-interactive span", "reference",
     ALL_APPS, "<span>全部 Apps</span>", "全部 Apps"),
    ("R59-A3 canonical link -> nonexistent reference", "contract",
     "(./space-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "(./space-home-poo43-aligned-nonexistent.html)",
     "alternative candidate or nonexistent binding"),
    # direct semantic mutations
    ("B1 required string removed", "reference", MANAGE, "", "管理首页 Apps"),
    ("B2 forbidden string added (运行中 badge)", "reference",
     "<h3>客户访谈整理</h3>",
     '<h3>客户访谈整理</h3><span class="badge">运行中</span>',
     "reference contains excluded control/copy"),
    ("B3 contract threshold weakened", "contract", "`0.02`", "`0.01`",
     "threshold claims must be exactly 0.02"),
    ("B4 contract exclusion permitted", "contract",
     "exclusions are not permitted", "exclusions are permitted for icon tiles",
     "'permitted exclusions' claim"),
    ("B6 contract tablet binding removed", "contract", "1024×768", "1023×767",
     "tablet viewport binding"),
    # R61
    ("R61 control outside actions group", "reference",
     f'<div class="head-actions">{MANAGE}{ALL_APPS}</div>',
     f'{MANAGE}<div class="head-actions">{ALL_APPS}</div>', "actions group"),
    # R63 exact regressions
    ("R63-2 visible same-label link outside actions", "reference",
     '<div class="head-actions">',
     '<a href="#manage-home">管理首页 Apps</a><div class="head-actions">', "ambiguous"),
    ("R63-3 raw canonical traversal", "contract",
     CANONICAL,
     "[aligned](./nested/../space-home-poo43-aligned-light-zh-Hans-desktop.html)", "traversal"),
    ("R63-4 canonical plus missing alternate", "contract",
     CANONICAL, CANONICAL + "\n[alternate](./missing-home-reference.html)", "alternative"),
    ("R63-5 ghost danger role tokens", "reference",
     '<button class="button ghost">打开</button>',
     '<button class="button ghost danger">打开</button>', "actions mismatch"),
    ("R63-6 primary danger role tokens", "reference",
     '<button class="button primary">打开助手</button>',
     '<button class="button primary danger">打开助手</button>', "actions mismatch"),
    ("R63-7 hidden stray expected name", "reference",
     "<h3>客户访谈整理</h3>",
     "<h3>错误标题</h3><span hidden>客户访谈整理</span>", "heading mismatch"),
    ("R63-8 earlier negation masks affirmative", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted; icon exclusions are allowed",
     "'permitted exclusions' claim"),
    # R65 adjacent failures
    ("R65 inline style tab whitespace", "reference",
     MANAGE, '<button class="quiet-link" style="display:\t none">管理首页 Apps</button>',
     "管理首页 Apps"),
    ("R65 inline style comment between value", "reference",
     MANAGE,
     '<button class="quiet-link" style="display:/* formatted */none">管理首页 Apps</button>',
     "管理首页 Apps"),
    ("R65 percent-encoded traversal", "contract",
     CANONICAL, "[aligned](./%2e%2e/space-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "traversal"),
    ("R65 encoded slash traversal", "contract",
     CANONICAL, "[aligned](./safe/%2e%2e%2fspace-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "traversal"),
    ("R65 extra HTML candidate with fragment", "contract",
     CANONICAL, CANONICAL + "\n[alternate](./alternate.html#desktop)", "alternative"),
    ("R65 extra Markdown candidate with query", "contract",
     CANONICAL, CANONICAL + "\n[notes](./alternate.md?raw=1)", "alternative"),
    ("R65 mixed exclusion claims (Chinese full stop)", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted。icon exclusions are allowed",
     "'permitted exclusions' claim"),
    ("R65 mixed exclusion claims (exclamation)", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted!icon exclusions are allowed",
     "'permitted exclusions' claim"),
    ("R65 mixed exclusion claims (question mark)", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted?icon exclusions are allowed",
     "'permitted exclusions' claim"),
    ("R65 mixed exclusion claims (comma)", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted,icon exclusions are allowed",
     "'permitted exclusions' claim"),
]

# ── special reject cases (multi-step / functional mutations) ──

def m_outside_actions(paths):
    p = paths["reference"]
    text = p.read_text(encoding="utf-8")
    text = text.replace(
        f'<div class="head-actions">{MANAGE}{ALL_APPS}</div>',
        f'{MANAGE}<div class="head-actions">{ALL_APPS}</div>', 1,
    )
    p.write_text(text, encoding="utf-8")


def m_css_hidden_class(paths):
    p = paths["reference"]
    text = p.read_text(encoding="utf-8")
    assert ".quiet-link { display: inline-flex;" in text
    text = text.replace(
        ".quiet-link { display: inline-flex;",
        ".visually-hidden { display: none; }\n.quiet-link { display: inline-flex;", 1,
    ).replace(MANAGE, '<button class="quiet-link visually-hidden">管理首页 Apps</button>', 1)
    assert "visually-hidden { display: none; }" in text
    p.write_text(text, encoding="utf-8")


def m_ambiguous_duplicate_links(paths):
    p = paths["contract"]
    text = p.read_text(encoding="utf-8")
    assert CANONICAL in text
    p.write_text(
        text.replace(
            CANONICAL,
            CANONICAL + "\n[second candidate](./space-home-poo43-aligned-light-zh-Hans-desktop.html)",
            1,
        ),
        encoding="utf-8",
    )


def m_ghost_to_danger(paths):
    p = paths["reference"]
    text = p.read_text(encoding="utf-8")
    assert '<button class="button ghost">打开</button>' in text
    p.write_text(
        text.replace('<button class="button ghost">打开</button>', '<button class="button danger">打开</button>', 1),
        encoding="utf-8",
    )


def m_conflicting_threshold(paths):
    p = paths["contract"]
    text = p.read_text(encoding="utf-8")
    anchor = "The `0.02` region threshold is unchanged"
    assert anchor in text
    p.write_text(
        text.replace(anchor, anchor + ". The catalog threshold is separately `0.03`", 1),
        encoding="utf-8",
    )


def m_formatted_display(paths):
    apply_reject_mutation(
        "reference",
        ".quiet-link { display: inline-flex;",
        ".formatted-hide { display:\n none; }\n.quiet-link { display: inline-flex;",
        paths,
    )
    apply_reject_mutation(
        "reference",
        MANAGE,
        '<button class="quiet-link formatted-hide">管理首页 Apps</button>',
        paths,
    )
    assert "formatted-hide { display:" in paths["reference"].read_text(encoding="utf-8")


def m_css_comment_value(paths):
    apply_reject_mutation(
        "reference",
        ".quiet-link { display: inline-flex;",
        '.adjacent-hide { display:/* formatted */none; }\n.quiet-link { display: inline-flex;',
        paths,
    )
    apply_reject_mutation(
        "reference",
        MANAGE,
        '<button class="quiet-link adjacent-hide">管理首页 Apps</button>',
        paths,
    )
    assert "adjacent-hide { display:" in paths["reference"].read_text(encoding="utf-8")


SPECIAL_REJECT_CASES = [
    ("R63-1 formatted display newline none", m_formatted_display, "管理首页 Apps"),
    ("R65 CSS comment between display value", m_css_comment_value, "管理首页 Apps"),
    ("R61 stylesheet-hidden class control", m_css_hidden_class,
     "expected exactly one visible interactive <button>管理首页 Apps"),
    ("R61 ambiguous duplicate same-target contract links", m_ambiguous_duplicate_links, "ambiguous"),
    ("R61 card action role ghost->danger", m_ghost_to_danger, "actions mismatch"),
    ("R61 conflicting extra threshold statement", m_conflicting_threshold,
     "threshold claims must be exactly 0.02"),
]

# ── allow controls (must STAY clean) ──
ALLOW_CASES = [
    ("ALLOW commented-out hiding rule is inert", "reference",
     ".quiet-link { display: inline-flex;",
     "/* .quiet-link { display: none; } */\n.quiet-link { display: inline-flex;"),
    ("ALLOW unmatched ancestor selector is inert", "reference",
     ".quiet-link { display: inline-flex;",
     ".absent-ancestor .quiet-link { display: none; }\n.quiet-link { display: inline-flex;"),
    ("ALLOW unmatched compound selector is inert", "reference",
     ".quiet-link { display: inline-flex;",
     ".absent-class.quiet-link { display: none; }\n.quiet-link { display: inline-flex;"),
    ("ALLOW hidden duplicate heading is ignored", "reference",
     "<h3>客户访谈整理</h3>",
     "<h3>客户访谈整理</h3><h3 hidden>错误标题</h3>"),
    ("ALLOW hidden duplicate source is ignored", "reference",
     '<p class="source">Polo 内置</p>',
     '<p class="source">Polo 内置</p><p class="source" hidden>错误来源</p>'),
    ("ALLOW preserved POO-47 exclusion statement", "contract",
     "exclusions are not permitted",
     "exclusions are not permitted; the POO-47 exclusion is preserved"),
    ("ALLOW normal canonical link unchanged", "contract",
     CANONICAL, CANONICAL),
]


def sandbox():
    temp = tempfile.TemporaryDirectory(prefix="poo43-r66-")
    base = Path(temp.name)
    paths = {
        "oracle": base / ORACLE.name,
        "reference": base / REFERENCE.name,
        "contract": base / CONTRACT.name,
    }
    for source, target in ((ORACLE, paths["oracle"]), (REFERENCE, paths["reference"]), (CONTRACT, paths["contract"])):
        target.write_bytes(source.read_bytes())
    return temp, base, paths


def run_reject_case(label: str, mutate, expect_fragment: str) -> bool:
    temp, base, paths = sandbox()
    try:
        mutate(paths)
        failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        intended = any(expect_fragment in failure for failure in failures)
        CASES.append({
            "kind": "reject",
            "case": label,
            "guardFailed": bool(failures),
            "intendedReasonObserved": intended,
            "failures": failures[:3],
        })
        return bool(failures) and intended
    finally:
        temp.cleanup()


def run_allow_case(label: str, mutate) -> bool:
    temp, base, paths = sandbox()
    try:
        mutate(paths)
        failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        CASES.append({
            "kind": "allow",
            "case": label,
            "stayedClean": not failures,
            "failures": failures[:3],
        })
        return not failures
    finally:
        temp.cleanup()


def run_isolation_case() -> bool:
    """Supplied-path isolation: globals pointed at nonexistent files must not
    influence the sandbox evaluation, and sandbox drift must be seen."""
    temp, base, paths = sandbox()
    saved = (guard.ORACLE, guard.REFERENCE, guard.CONTRACT, guard.REFERENCES_DIR)
    try:
        guard.ORACLE = base / "global-missing-oracle.html"
        guard.REFERENCE = base / "global-missing-reference.html"
        guard.CONTRACT = base / "global-missing-contract.md"
        guard.REFERENCES_DIR = base / "global-missing-references"
        clean_failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        text = paths["reference"].read_text(encoding="utf-8")
        paths["reference"].write_text(text.replace(MANAGE, "", 1), encoding="utf-8")
        drift_failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        CASES.append({
            "kind": "isolation",
            "case": "supplied-path isolation from module globals",
            "cleanSandboxPassed": not clean_failures,
            "sandboxDriftFailed": bool(drift_failures),
            "driftIntendedReasonObserved": any("管理首页 Apps" in f for f in drift_failures),
        })
        return not clean_failures and bool(drift_failures) and any(
            "管理首页 Apps" in f for f in drift_failures
        )
    finally:
        guard.ORACLE, guard.REFERENCE, guard.CONTRACT, guard.REFERENCES_DIR = saved
        temp.cleanup()


def apply_reject_mutation(target_name: str, old: str, new: str, paths: dict) -> None:
    path = paths[target_name]
    text = path.read_text(encoding="utf-8")
    assert old in text, f"mutation anchor missing in {target_name}: {old!r}"
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> int:
    tracked_before = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ORACLE, REFERENCE, CONTRACT, GUARD)
    }

    ok = True

    for label, target, old, new, fragment in REJECT_CASES:
        def mutate(paths, target=target, old=old, new=new):
            apply_reject_mutation(target, old, new, paths)
        ok &= run_reject_case(label, mutate, fragment)

    for label, mutate, fragment in SPECIAL_REJECT_CASES:
        ok &= run_reject_case(label, mutate, fragment)

    ok &= run_isolation_case()

    for label, target, old, new in ALLOW_CASES:
        def allow_mutate(paths, target=target, old=old, new=new):
            apply_reject_mutation(target, old, new, paths)
        ok &= run_allow_case(label, allow_mutate)

    tracked_after = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ORACLE, REFERENCE, CONTRACT, GUARD)
    }
    clean = tracked_before == tracked_after

    baseline = guard.check(ORACLE, REFERENCE, CONTRACT, REFERENCES_DIR)
    rerun_green = not baseline

    reject_cases = [c for c in CASES if c["kind"] in ("reject",)]
    passed_reject = [
        c for c in reject_cases
        if c.get("guardFailed") and c.get("intendedReasonObserved")
    ]
    passed_allow = [c for c in CASES if c["kind"] == "allow" and c.get("stayedClean")]
    passed = (
        ok
        and clean
        and rerun_green
        and len(passed_reject) == len(reject_cases)
        and len(passed_allow) == len([c for c in CASES if c["kind"] == "allow"])
    )
    print(json.dumps({
        "ok": passed,
        "caseCount": len(CASES),
        "rejectCaseCount": len(reject_cases),
        "rejectCasesPassed": len(passed_reject),
        "allowCaseCount": len([c for c in CASES if c["kind"] == "allow"]),
        "allowCasesPassed": len(passed_allow),
        "trackedFilesByteForByteClean": clean,
        "baselineGuardGreenAfterSuite": rerun_green,
        "cases": CASES,
    }, ensure_ascii=False, indent=1))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
