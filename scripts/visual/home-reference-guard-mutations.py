#!/usr/bin/env python3
"""POO-43 adversarial mutation suite for the Home reference contract guard.

Durable TRACKED regression coverage (R56→R68). Every reject case runs against
ISOLATED TEMPORARY COPIES of the authority trio (oracle / aligned reference /
companion contract) with the sandbox passed explicitly as ``references_dir``,
and asserts the guard fails for its INTENDED reason. Allow controls assert
explicit success. Case inventory:

- ALL 36 expected-reject and ALL 6 expected-allow cases of the immutable R65
  42-case independent harness (provenance manifest below maps every R65 case
  ID to its covering tracked case);
- prior sealed cases preserved: B1 required-string removal, B2 forbidden
  string, B3 threshold 0.01, B6 tablet binding, B5 aligned-reference-missing,
  B7 frozen-oracle-byte-drift, R59 span-hidden/non-interactive-span, R61
  stylesheet-hidden / ambiguous-duplicate-links / ghost→danger / conflicting
  threshold, R66 comma selector-list reject + inert grouped allow, and the
  R54 supplied-path isolation case.

The emitted JSON asserts provenance completeness (all 42 R65 IDs covered),
category counts (≥36 reject, ≥6 allow), tracked-byte integrity for EVERY file
named by the suite (guard + suite + authority trio), and a green real
baseline after the run. Exit 0 only when everything holds.
"""
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts/visual/home-reference-contract-guard.py"
MUTATION_SUITE = ROOT / "scripts/visual/home-reference-guard-mutations.py"
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
CANONICAL_RAW = "./space-home-poo43-aligned-light-zh-Hans-desktop.html"
CANONICAL = f"[`space-home-poo43-aligned-light-zh-Hans-desktop.html`]({CANONICAL_RAW})"

# ── data-driven reject cases ──
# (label, provenance: [R65 case IDs], target, old, new, intended fragment)
REJECT_CASES = [
    ("R59-A1 manage button -> span hidden", ["R59-A1 manage button -> span hidden"],
     "reference", MANAGE, "<span hidden>管理首页 Apps</span>", "管理首页 Apps"),
    ("R59-A2 all-apps button -> non-interactive span", ["R59-A2 all-apps button -> non-interactive span"],
     "reference", ALL_APPS, "<span>全部 Apps</span>", "全部 Apps"),
    ("R59-A3 canonical link -> nonexistent reference", ["R59-A3 canonical link -> nonexistent reference"],
     "contract",
     "(./space-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "(./space-home-poo43-aligned-nonexistent.html)",
     "alternative candidate or nonexistent binding"),
    ("B1 required string removed", ["B1 required string removed"],
     "reference", MANAGE, "", "管理首页 Apps"),
    ("B2 forbidden string added (运行中 badge)", ["B2 forbidden string added (运行中 badge)"],
     "reference", "<h3>客户访谈整理</h3>",
     '<h3>客户访谈整理</h3><span class="badge">运行中</span>',
     "reference contains excluded control/copy"),
    ("B3 contract threshold weakened to 0.01", ["B3 contract threshold weakened to 0.01"],
     "contract", "`0.02`", "`0.01`", "threshold claims must be exactly 0.02"),
    ("B4 contract exclusion permitted", ["B4 contract exclusion permitted"],
     "contract", "exclusions are not permitted", "exclusions are permitted for icon tiles",
     "'permitted exclusions' claim"),
    ("B6 contract tablet binding removed", ["B6 contract tablet binding removed"],
     "contract", "1024×768", "1023×767", "tablet viewport binding"),
    ("R61 control outside actions group", ["R61 control outside actions group", "R63: control moved outside actions group"],
     "reference",
     f'<div class="head-actions">{MANAGE}{ALL_APPS}</div>',
     f'{MANAGE}<div class="head-actions">{ALL_APPS}</div>', "actions group"),
    ("R61 ambiguous duplicate same-target contract links",
     ["R61 ambiguous duplicate same-target contract links"],
     "contract", CANONICAL,
     CANONICAL + "\n[second candidate](./space-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "ambiguous"),
    ("R61 conflicting extra threshold statement", ["R61 conflicting extra threshold statement"],
     "contract", "The `0.02` region threshold is unchanged",
     "The `0.02` region threshold is unchanged. The catalog threshold is separately `0.03`",
     "threshold claims must be exactly 0.02"),
    ("R61 card action role ghost->danger", ["R61 card action role ghost->danger", "R63: work action ghost to danger"],
     "reference", '<button class="button ghost">打开</button>',
     '<button class="button danger">打开</button>', "actions mismatch"),
    # ── the 8 exact R63 regressions ──
    ("R63-2 visible same-label link outside actions", ["R63-2 visible same-label link outside actions"],
     "reference", '<div class="head-actions">',
     '<a href="#manage-home">管理首页 Apps</a><div class="head-actions">', "ambiguous"),
    ("R63-3 raw canonical traversal", ["R63-3 raw canonical traversal"],
     "contract", CANONICAL,
     "[aligned](./nested/../space-home-poo43-aligned-light-zh-Hans-desktop.html)", "traversal"),
    ("R63-4 canonical plus missing alternate", ["R63-4 canonical plus missing alternate"],
     "contract", CANONICAL, CANONICAL + "\n[alternate](./missing-home-reference.html)",
     "alternative"),
    ("R63-5 ghost danger role tokens", ["R63-5 ghost danger"],
     "reference", '<button class="button ghost">打开</button>',
     '<button class="button ghost danger">打开</button>', "actions mismatch"),
    ("R63-6 primary danger role tokens", ["R63-6 primary danger"],
     "reference", '<button class="button primary">打开助手</button>',
     '<button class="button primary danger">打开助手</button>', "actions mismatch"),
    ("R63-7 hidden stray expected name", ["R63-7 hidden stray expected name"],
     "reference", "<h3>客户访谈整理</h3>",
     "<h3>错误标题</h3><span hidden>客户访谈整理</span>", "heading mismatch"),
    ("R63-8 earlier negation masks affirmative", ["R63-8 earlier negation masks affirmative"],
     "contract", "exclusions are not permitted",
     "exclusions are not permitted; icon exclusions are allowed",
     "'permitted exclusions' claim"),
    # ── R65 adjacent rejects ──
    ("R65 inline style tab whitespace", ["inline style tab whitespace"],
     "reference", MANAGE,
     '<button class="quiet-link" style="display:\t none">管理首页 Apps</button>',
     "管理首页 Apps"),
    ("R65 inline style comment between value", ["inline style comment between value"],
     "reference", MANAGE,
     '<button class="quiet-link" style="display:/* formatted */none">管理首页 Apps</button>',
     "管理首页 Apps"),
    ("R65 outside role button duplicate", ["outside role button duplicate"],
     "reference", '<div class="head-actions">',
     '<span role="button">管理首页 Apps</span><div class="head-actions">', "ambiguous"),
    ("R65 outside onclick duplicate", ["outside onclick duplicate"],
     "reference", '<div class="head-actions">',
     '<span onclick="openAll()">全部 Apps</span><div class="head-actions">', "ambiguous"),
    ("R65 multiple raw traversal segments", ["multiple raw traversal segments"],
     "contract", CANONICAL,
     "[aligned](./a/../../a/../space-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "traversal"),
    ("R65 percent-encoded traversal", ["percent-encoded traversal"],
     "contract", CANONICAL,
     "[aligned](./%2e%2e/space-home-poo43-aligned-light-zh-Hans-desktop.html)", "traversal"),
    ("R65 encoded slash traversal", ["encoded slash traversal"],
     "contract", CANONICAL,
     "[aligned](./safe/%2e%2e%2fspace-home-poo43-aligned-light-zh-Hans-desktop.html)",
     "traversal"),
    ("R65 extra missing markdown candidate", ["extra missing markdown candidate"],
     "contract", CANONICAL, CANONICAL + "\n[notes](./alternate.md)", "alternative"),
    ("R65 extra uppercase HTML candidate", ["extra uppercase HTML candidate"],
     "contract", CANONICAL, CANONICAL + "\n[alternate](./alternate.HTML)", "alternative"),
    ("R65 extra HTML candidate with fragment", ["extra HTML candidate with fragment"],
     "contract", CANONICAL, CANONICAL + "\n[alternate](./alternate.html#desktop)",
     "alternative"),
    ("R65 extra Markdown candidate with query", ["extra Markdown candidate with query"],
     "contract", CANONICAL, CANONICAL + "\n[notes](./alternate.md?raw=1)", "alternative"),
    ("R65 unknown ghost role token", ["unknown ghost role token"],
     "reference", '<button class="button ghost">打开</button>',
     '<button class="button ghost secondary">打开</button>', "actions mismatch"),
    ("R65 conflicting primary ghost tokens", ["conflicting primary ghost tokens"],
     "reference", '<button class="button primary">打开助手</button>',
     '<button class="button primary ghost">打开助手</button>', "actions mismatch"),
    ("R65 missing action role token", ["missing action role token"],
     "reference", '<button class="button ghost">打开</button>',
     '<button class="button">打开</button>', "actions mismatch"),
    ("R65 visible duplicate heading", ["visible duplicate heading"],
     "reference", "<h3>客户访谈整理</h3>",
     "<h3>客户访谈整理</h3><h3>客户访谈整理</h3>", "heading mismatch"),
    ("R65 visible duplicate source", ["visible duplicate source"],
     "reference", '<p class="source">Polo 内置</p>',
     '<p class="source">Polo 内置</p><p class="source">Polo 内置</p>', "source mismatch"),
]

# R65 mixed-separator exclusion claims (8 separators + no-allowed variant)
for sep_label, separator in [
    ("ASCII semicolon", ";"),
    ("fullwidth semicolon", "；"),
    ("ASCII period", "."),
    ("Chinese full stop", "。"),
    ("exclamation", "!"),
    ("question mark", "?"),
    ("newline", "\n"),
    ("comma", ","),
]:
    REJECT_CASES.append((
        f"R65 mixed exclusion claims separated by {sep_label}",
        [f"mixed exclusion claims separated by {sep_label}"],
        "contract",
        "exclusions are not permitted",
        f"exclusions are not permitted{separator}icon exclusions are allowed",
        "'permitted exclusions' claim",
    ))
REJECT_CASES.append((
    "R65 mixed no-allowed then permitted claim",
    ["mixed no-allowed then permitted claim"],
    "contract",
    "exclusions are not permitted",
    "no exclusions are allowed; icon exclusions are permitted",
    "'permitted exclusions' claim",
))
REJECT_CASES.append((
    "R67 canonical target with fragment",
    ["extra: R67 canonical-with-fragment preserved"],
    "contract",
    CANONICAL,
    "[`space-home-poo43-aligned-light-zh-Hans-desktop.html`](./space-home-poo43-aligned-light-zh-Hans-desktop.html#desktop)",
    "without query or fragment",
))
REJECT_CASES.append((
    "R67 canonical target with query",
    ["extra: R67 canonical-with-query preserved"],
    "contract",
    CANONICAL,
    "[`space-home-poo43-aligned-light-zh-Hans-desktop.html`](./space-home-poo43-aligned-light-zh-Hans-desktop.html?raw=1)",
    "without query or fragment",
))
# R67 grouped-selector reject is a SPECIAL genuine-cascade case: the hiding
# rule is inserted AFTER the baseline visible declaration (immediately before
# .quiet-link:hover) so Chromium cascade order really hides the controls, and
# a deterministic Chromium computed-style proof must confirm that before the
# guard rejection counts.  See run_grouped_selector_case() in main().

# ── special reject mutations (functional) ──

def m_b5_reference_missing(paths):
    paths["reference"].unlink()


def m_b7_oracle_byte_drift(paths):
    p = paths["oracle"]
    p.write_bytes(p.read_bytes() + b"\n")


def m_css_rule_plus_button_class(rule_text, button_class):
    def mutate(paths):
        apply_reject_mutation(
            "reference", ".quiet-link { display: inline-flex;",
            f"{rule_text}\n.quiet-link {{ display: inline-flex;", paths,
        )
        apply_reject_mutation(
            "reference", MANAGE,
            f'<button class="quiet-link {button_class}">管理首页 Apps</button>', paths,
        )
        assert button_class in paths["reference"].read_text(encoding="utf-8")
    return mutate


def m_css_rule_plus_ancestor_class(rule_text, ancestor_class):
    def mutate(paths):
        apply_reject_mutation(
            "reference", ".quiet-link { display: inline-flex;",
            f"{rule_text}\n.quiet-link {{ display: inline-flex;", paths,
        )
        apply_reject_mutation(
            "reference", '<div class="head-actions">',
            f'<div class="head-actions {ancestor_class}">', paths,
        )
        assert ancestor_class in paths["reference"].read_text(encoding="utf-8")
    return mutate


SPECIAL_REJECT_CASES = [
    ("R61 stylesheet-hidden class control",
     ["R61 stylesheet-hidden class control"],
     m_css_rule_plus_button_class(".visually-hidden { display: none; }", "visually-hidden"),
     "expected exactly one visible interactive <button>管理首页 Apps"),
    ("R63-1 formatted display newline none",
     ["R63-1 formatted display newline none"],
     m_css_rule_plus_button_class(".formatted-hide { display:\n none; }", "formatted-hide"),
     "管理首页 Apps"),
    ("R65 CSS tab whitespace",
     ["CSS tab whitespace"],
     m_css_rule_plus_button_class(".adjacent-hide { display:\t none; }", "adjacent-hide"),
     "管理首页 Apps"),
    ("R65 CSS comment between display value",
     ["CSS comment between display value"],
     m_css_rule_plus_button_class(".adjacent-hide { display:/* formatted */none; }", "adjacent-hide"),
     "管理首页 Apps"),
    ("R65 CSS ancestor descendant selector",
     ["CSS ancestor descendant selector"],
     m_css_rule_plus_ancestor_class(".ancestor-hide .quiet-link { visibility: hidden; }", "ancestor-hide"),
     "管理首页 Apps"),
    ("B5 aligned reference missing", ["B5 aligned reference missing"],
     m_b5_reference_missing, "aligned reference missing"),
    ("B7 frozen oracle byte drift", ["B7 frozen oracle byte drift"],
     m_b7_oracle_byte_drift, "historical oracle bytes changed"),
]

# ── allow controls (must STAY clean) ──
ALLOW_CASES = [
    ("ALLOW commented-out hiding rule is inert",
     ["commented-out hiding rule is inert"],
     "reference", ".quiet-link { display: inline-flex;",
     "/* .quiet-link { display: none; } */\n.quiet-link { display: inline-flex;"),
    ("ALLOW unmatched ancestor selector is inert",
     ["unmatched ancestor selector is inert"],
     "reference", ".quiet-link { display: inline-flex;",
     ".absent-ancestor .quiet-link { display: none; }\n.quiet-link { display: inline-flex;"),
    ("ALLOW unmatched compound selector is inert",
     ["unmatched compound selector is inert"],
     "reference", ".quiet-link { display: inline-flex;",
     ".absent-class.quiet-link { display: none; }\n.quiet-link { display: inline-flex;"),
    ("ALLOW hidden duplicate heading is ignored",
     ["hidden duplicate heading is ignored"],
     "reference", "<h3>客户访谈整理</h3>",
     "<h3>客户访谈整理</h3><h3 hidden>错误标题</h3>"),
    ("ALLOW hidden duplicate source is ignored",
     ["hidden duplicate source is ignored"],
     "reference", '<p class="source">Polo 内置</p>',
     '<p class="source">Polo 内置</p><p class="source" hidden>错误来源</p>'),
    ("ALLOW preserved POO-47 exclusion statement",
     ["preserved POO-47 exclusion statement"],
     "contract", "exclusions are not permitted",
     "exclusions are not permitted; the POO-47 exclusion is preserved"),
    ("ALLOW normal canonical link unchanged (exact direct)", [],
     "contract", CANONICAL, CANONICAL),
    ("ALLOW comma selector list with no matching alternative",
     ["extra: R66 grouped-selector inert allow"],
     "reference", ".quiet-link { display: inline-flex;",
     ".unused, .unrelated-quiet { display: none; }\n.quiet-link { display: inline-flex;"),
]

# ── Prior sealed case IDs (R59/R6x B-series + R61 + isolation) ──
# Every previously sealed case must remain durably represented: deleting any
# prior case removes its provenance entry and fails the suite.
SEALED_PRIOR_CASE_IDS = [
    "R59-A1 manage button -> span hidden",
    "R59-A2 all-apps button -> non-interactive span",
    "R59-A3 canonical link -> nonexistent reference",
    "B1 required string removed",
    "B2 forbidden string added (运行中 badge)",
    "B3 contract threshold weakened to 0.01",
    "B4 contract exclusion permitted",
    "B5 aligned reference missing",
    "B6 contract tablet binding removed",
    "B7 frozen oracle byte drift",
    "R61 control outside actions group",
    "R61 stylesheet-hidden class control",
    "R61 ambiguous duplicate same-target contract links",
    "R61 conflicting extra threshold statement",
    "R61 card action role ghost->danger",
    "supplied-path isolation from module globals",
]

# ── R65 provenance manifest (immutable harness case ID -> tracked labels) ──
R65_PROVENANCE: dict[str, list[str]] = {}
for _label, _provenance, *_rest in REJECT_CASES:
    for _r65_id in _provenance:
        if not _r65_id.startswith("extra:"):
            R65_PROVENANCE.setdefault(_r65_id, []).append(_label)
for _label, _provenance, _fn, _fragment in SPECIAL_REJECT_CASES:
    for _r65_id in _provenance:
        if not _r65_id.startswith("extra:"):
            R65_PROVENANCE.setdefault(_r65_id, []).append(_label)
for _label, _provenance, *_rest in ALLOW_CASES:
    for _r65_id in _provenance:
        if not _r65_id.startswith("extra:"):
            R65_PROVENANCE.setdefault(_r65_id, []).append(_label)

# Prior-sealed provenance: same mechanism, scoped to the sealed IDs.
SEALED_PRIOR_PROVENANCE: dict[str, list[str]] = {}
for _label, _provenance, *_rest in REJECT_CASES:
    for _sealed_id in _provenance:
        if _sealed_id in SEALED_PRIOR_CASE_IDS:
            SEALED_PRIOR_PROVENANCE.setdefault(_sealed_id, []).append(_label)
for _label, _provenance, _fn, _fragment in SPECIAL_REJECT_CASES:
    for _sealed_id in _provenance:
        if _sealed_id in SEALED_PRIOR_CASE_IDS:
            SEALED_PRIOR_PROVENANCE.setdefault(_sealed_id, []).append(_label)
for _label, _provenance, *_rest in ALLOW_CASES:
    for _sealed_id in _provenance:
        if _sealed_id in SEALED_PRIOR_CASE_IDS:
            SEALED_PRIOR_PROVENANCE.setdefault(_sealed_id, []).append(_label)
# The isolation case registers its provenance at runtime (see
# run_isolation_case) — deleting it leaves the ID missing and fails the suite.

R65_HARNESS_REJECT_IDS = [
    "R63-1 formatted display newline none",
    "R63-2 visible same-label link outside actions",
    "R63-3 raw canonical traversal",
    "R63-4 canonical plus missing alternate",
    "R63-5 ghost danger",
    "R63-6 primary danger",
    "R63-7 hidden stray expected name",
    "R63-8 earlier negation masks affirmative",
    "CSS tab whitespace",
    "CSS comment between display value",
    "inline style tab whitespace",
    "inline style comment between value",
    "CSS ancestor descendant selector",
    "outside role button duplicate",
    "outside onclick duplicate",
    "multiple raw traversal segments",
    "percent-encoded traversal",
    "encoded slash traversal",
    "extra missing markdown candidate",
    "extra uppercase HTML candidate",
    "extra HTML candidate with fragment",
    "extra Markdown candidate with query",
    "unknown ghost role token",
    "conflicting primary ghost tokens",
    "missing action role token",
    "visible duplicate heading",
    "visible duplicate source",
]
R65_HARNESS_REJECT_IDS += [
    f"mixed exclusion claims separated by {label}"
    for label in (
        "ASCII semicolon", "fullwidth semicolon", "ASCII period", "Chinese full stop",
        "exclamation", "question mark", "newline", "comma",
    )
]
R65_HARNESS_REJECT_IDS += ["mixed no-allowed then permitted claim"]
R65_HARNESS_ALLOW_IDS = [
    "commented-out hiding rule is inert",
    "unmatched ancestor selector is inert",
    "unmatched compound selector is inert",
    "hidden duplicate heading is ignored",
    "hidden duplicate source is ignored",
    "preserved POO-47 exclusion statement",
]


def sandbox():
    temp = tempfile.TemporaryDirectory(prefix="poo43-r68-")
    base = Path(temp.name)
    paths = {
        "oracle": base / ORACLE.name,
        "reference": base / REFERENCE.name,
        "contract": base / CONTRACT.name,
    }
    for source, target in ((ORACLE, paths["oracle"]), (REFERENCE, paths["reference"]), (CONTRACT, paths["contract"])):
        target.write_bytes(source.read_bytes())
    return temp, base, paths


def run_reject_case(label, mutate, fragment):
    temp, base, paths = sandbox()
    try:
        mutate(paths)
        failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        intended = any(fragment in failure for failure in failures)
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


def run_allow_case(label, mutate):
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


def apply_reject_mutation(target_name, old, new, paths):
    path = paths[target_name]
    text = path.read_text(encoding="utf-8")
    assert old in text, f"mutation anchor missing in {target_name}: {old!r}"
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def run_isolation_case():
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
        SEALED_PRIOR_PROVENANCE.setdefault(
            "supplied-path isolation from module globals", [],
        ).append("supplied-path isolation from module globals")
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


def chromium_buttons_hidden(reference_path: Path) -> dict:
    """Deterministic Chromium computed-style proof: every required control
    must compute to display:none in the mutated reference."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(reference_path.as_uri(), wait_until="load")
        page.wait_for_timeout(300)
        state = page.evaluate(
            """() => {
              const find = (label) => Array.from(document.querySelectorAll('button'))
                .find((b) => b.textContent.trim() === label);
              const out = {};
              for (const label of ['管理首页 Apps', '全部 Apps']) {
                const el = find(label);
                out[label] = el ? getComputedStyle(el).display : 'missing';
              }
              return out;
            }"""
        )
        browser.close()
        return state


def run_grouped_selector_case() -> bool:
    """Genuine cascade-order grouped-selector reject: insert the matching
    `.unused, .quiet-link { display: none; }` rule after the baseline visible
    declaration (immediately before .quiet-link:hover), prove in Chromium
    that both required controls compute to display:none, then require the
    guard rejection."""
    temp, base, paths = sandbox()
    try:
        apply_reject_mutation(
            "reference",
            ".quiet-link:hover",
            ".unused, .quiet-link { display: none; }\n.quiet-link:hover",
            paths,
        )
        chromium = chromium_buttons_hidden(paths["reference"])
        chromium_hidden = all(value == "none" for value in chromium.values())
        failures = guard.check(paths["oracle"], paths["reference"], paths["contract"], base)
        intended = any("管理首页 Apps" in failure for failure in failures)
        CASES.append({
            "kind": "reject",
            "case": "R67 grouped selector list with matching alternative (genuine cascade hide)",
            "chromiumProofHidden": chromium_hidden,
            "chromiumProof": chromium,
            "guardFailed": bool(failures),
            "intendedReasonObserved": intended,
            "failures": failures[:3],
        })
        return chromium_hidden and intended
    finally:
        temp.cleanup()


def main() -> int:
    tracked_paths = (ORACLE, REFERENCE, CONTRACT, GUARD, MUTATION_SUITE)
    tracked_before = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in tracked_paths
    }

    ok = True

    for label, provenance, target, old, new, fragment in REJECT_CASES:
        case_label = f"{label} [provenance: {', '.join(provenance)}]"
        def mutate(paths, target=target, old=old, new=new):
            apply_reject_mutation(target, old, new, paths)
        ok &= run_reject_case(case_label, mutate, fragment)

    for label, provenance, mutate, fragment in SPECIAL_REJECT_CASES:
        case_label = f"{label} [provenance: {', '.join(provenance)}]"
        ok &= run_reject_case(case_label, mutate, fragment)

    ok &= run_isolation_case()

    ok &= run_grouped_selector_case()

    for label, provenance, target, old, new in ALLOW_CASES:
        case_label = f"{label} [provenance: {', '.join(provenance)}]"
        def allow_mutate(paths, target=target, old=old, new=new):
            apply_reject_mutation(target, old, new, paths)
        ok &= run_allow_case(case_label, allow_mutate)

    tracked_after = {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in tracked_paths
    }
    clean = tracked_before == tracked_after

    baseline = guard.check(ORACLE, REFERENCE, CONTRACT, REFERENCES_DIR)
    rerun_green = not baseline

    # Provenance completeness: EVERY R65 harness case ID must be covered by
    # at least one tracked case.
    missing_reject = [r65_id for r65_id in R65_HARNESS_REJECT_IDS if r65_id not in R65_PROVENANCE]
    missing_allow = [r65_id for r65_id in R65_HARNESS_ALLOW_IDS if r65_id not in R65_PROVENANCE]
    provenance_complete = not missing_reject and not missing_allow
    missing_prior_sealed = [
        sealed_id for sealed_id in SEALED_PRIOR_CASE_IDS
        if sealed_id not in SEALED_PRIOR_PROVENANCE
    ]
    prior_sealed_complete = not missing_prior_sealed

    reject_cases = [c for c in CASES if c["kind"] == "reject"]
    allow_cases = [c for c in CASES if c["kind"] == "allow"]
    isolation_cases = [c for c in CASES if c["kind"] == "isolation"]
    passed_reject = [c for c in reject_cases if c.get("guardFailed") and c.get("intendedReasonObserved")]
    passed_allow = [c for c in allow_cases if c.get("stayedClean")]
    passed_isolation = [
        c for c in isolation_cases
        if c.get("cleanSandboxPassed") and c.get("sandboxDriftFailed") and c.get("driftIntendedReasonObserved")
    ]

    category_counts = {
        "reject": len(reject_cases),
        "allow": len(allow_cases),
        "isolation": len(isolation_cases),
    }
    category_counts_ok = (
        category_counts["reject"] >= len(R65_HARNESS_REJECT_IDS)
        and category_counts["allow"] >= len(R65_HARNESS_ALLOW_IDS)
    )

    passed = (
        ok
        and clean
        and rerun_green
        and provenance_complete
        and prior_sealed_complete
        and category_counts_ok
        and len(passed_reject) == len(reject_cases)
        and len(passed_allow) == len(allow_cases)
        and len(passed_isolation) == len(isolation_cases)
    )
    print(json.dumps({
        "ok": passed,
        "caseCount": len(CASES),
        "cases": CASES,
        "categoryCounts": category_counts,
        "categoryCountsOk": category_counts_ok,
        "rejectCasesPassed": len(passed_reject),
        "allowCasesPassed": len(passed_allow),
        "isolationCasesPassed": len(passed_isolation),
        "provenance": R65_PROVENANCE,
        "provenanceComplete": provenance_complete,
        "provenanceMissingReject": missing_reject,
        "provenanceMissingAllow": missing_allow,
        "priorSealedComplete": prior_sealed_complete,
        "priorSealedProvenance": SEALED_PRIOR_PROVENANCE,
        "priorSealedMissing": missing_prior_sealed,
        "trackedFilesByteForByteClean": clean,
        "trackedDigestSet": sorted(tracked_before),
        "baselineGuardGreenAfterSuite": rerun_green,
    }, ensure_ascii=False, indent=1))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
