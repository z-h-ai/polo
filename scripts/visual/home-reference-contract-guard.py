#!/usr/bin/env python3
"""POO-43 Home aligned-reference contract guard (R62 hardened edition).

Deterministic, checked-in regression guard for the Home authority pair.
Validation is fully STRUCTURAL and SELF-CONTAINED:

- the HISTORICAL frozen POO-41 Home oracle must stay byte-for-byte unchanged
  (pinned SHA-256);
- the aligned reference is parsed with the standard-library HTML parser into
  a DOM tree and validated structurally:
  * exactly ONE `.head-actions` actions group must exist inside the home
    `section-head`, and `管理首页 Apps` then `全部 Apps` must each be exactly
    one VISIBLE, INTERACTIVE `<button>` inside THAT container, in order.
    A valid-looking control elsewhere in `.section-head` does not satisfy
    the contract; hidden/aria-hidden/disabled/span-substitutes/duplicate
    labels are rejected;
  * visibility is evaluated from the reference's OWN CSS as well: any class
    on the control or its ancestors whose stylesheet rule sets
    `display:none`, `visibility:hidden`, or `opacity:0` invalidates it
    (generic rule evaluation — no class-name allowlist);
  * exactly three `.card` articles in order (Polo 助手 / 客户访谈整理 /
    素材清洗器) with exact tile glyph, source, and action ROLE tokens:
    `primary` is only primary and `ghost` is only ghost — any other role
    class is a mismatch;
  * excluded Skills/runtime/legacy strings must appear nowhere;
- the companion contract binding is SELF-CONTAINED: every helper resolves
  relative to the SUPPLIED contract path and compares against the SUPPLIED
  reference path (never module globals). Exactly one canonical Markdown link
  must bind the aligned reference; zero, duplicate same-target, alternative
  candidate, traversal/outside, missing, malformed, or mere-text bindings
  are rejected, and the supplied reference must resolve inside the
  repository-owned references directory and exist;
- threshold and exclusion contract values are parsed as CLAIMS: every
  threshold-mentioning line's numeric claims must be exactly {0.02}, and
  every exclusion-mentioning line must unambiguously prohibit exclusions
  (contradictory permitted/allowed text fails).

Exit 0 = every invariant holds; non-zero with a JSON failure report.
`check(oracle, reference, contract)` is factored out so the checked-in
adversarial mutation suite can drive it against isolated temporary copies.
"""
import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ORACLE = ROOT / ".pipeline/acceptance-repair-poo43/frozen-sources/poo41/space-home-light-zh-Hans-desktop.html"
PINNED_ORACLE_SHA256 = "875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887"
REFERENCES_DIR = ROOT / ".agents/skills/polo-client-design/assets/design-context/references"
REFERENCE = REFERENCES_DIR / "space-home-poo43-aligned-light-zh-Hans-desktop.html"
REFERENCE_FILENAME = "space-home-poo43-aligned-light-zh-Hans-desktop.html"
CONTRACT = REFERENCES_DIR / "space-home-poo43-aligned.contract.md"

REQUIRED_REFERENCE_STRINGS = [
    "我的圈子 · 3 个",
    "常用 Apps",
    "认证创作者 · 北极星共创社",
]
FORBIDDEN_REFERENCE_STRINGS = [
    "管理 Skills",
    "2 个 Skill 已启用",
    "运行中",
    "认证创作者 · 北极星工作室",
]

REQUIRED_CONTRACT_PATTERNS = [
    (r"1440×900", "desktop viewport binding"),
    (r"1024×768", "tablet viewport binding"),
    (r"`0\.02`", "region threshold binding"),
    (r"zh-Hans", "locale binding"),
    (r"875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887", "historical provenance hash"),
    (r"管理首页 Apps", "required management control"),
    (r"shortcut-only", "shortcut-only dialog binding"),
]

# ── minimal stdlib DOM ──────────────────────────────────────────────────────


class Node:
    __slots__ = ("tag", "attrs", "parent", "children")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.parent = parent
        self.children = []  # Node | str


VOID_TAGS = {"meta", "link", "br", "img", "input", "hr", "source", "wbr"}


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse_html(html: str) -> Node:
    builder = TreeBuilder()
    builder.feed(html)
    return builder.root


def walk(node: Node):
    for child in node.children:
        if isinstance(child, Node):
            yield child
            yield from walk(child)


def text_content(node: Node) -> str:
    parts = []
    for child in node.children:
        parts.append(child if isinstance(child, str) else text_content(child))
    return "".join(parts)


def class_tokens(node: Node) -> set[str]:
    return set((node.attrs.get("class") or "").split())


def stylesheet_hiding_classes(root: Node) -> frozenset[str]:
    """Class tokens whose stylesheet rule hides the element (generic — the
    rule bodies are evaluated, no class-name allowlist). Rules inside @media
    blocks are treated conservatively as hiding (fail closed)."""
    hiding: set[str] = set()
    for node in walk(root):
        if node.tag == "style":
            css = text_content(node)
            for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
                selectors = match.group(1)
                body = match.group(2).replace(" ", "").lower()
                if (
                    "display:none" in body
                    or "visibility:hidden" in body
                    or "opacity:0" in body
                ):
                    for token in re.findall(r"\.([A-Za-z_][\w-]*)", selectors):
                        hiding.add(token)
    return frozenset(hiding)


HIDDEN_CLASS_TOKENS = frozenset({"hidden", "invisible"})


def node_attr_hides(node: Node) -> bool:
    if "hidden" in node.attrs:
        return True
    if (node.attrs.get("aria-hidden") or "").strip().lower() == "true":
        return True
    style = (node.attrs.get("style") or "").replace(" ", "").lower()
    return (
        "display:none" in style
        or "visibility:hidden" in style
        or "opacity:0" in style
    )


def is_hidden(node: Node, hiding_classes: frozenset[str]) -> bool:
    current: Node | None = node
    while current is not None and current.tag != "#root":
        if node_attr_hides(current):
            return True
        tokens = class_tokens(current)
        if tokens & hiding_classes:
            return True
        # Class-name heuristic (supplements the CSS-rule evaluation): the
        # universal `hidden`/`invisible` utility tokens hide the element
        # even when this reference ships no matching rule.
        if tokens & HIDDEN_CLASS_TOKENS:
            return True
        current = current.parent
    return False


def is_disabled_button(node: Node) -> bool:
    if node.tag != "button":
        return True
    if "disabled" in node.attrs:
        return True
    return (node.attrs.get("aria-disabled") or "").strip().lower() == "true"


def visible_buttons(scope: Node, hiding_classes: frozenset[str]) -> list[Node]:
    return [
        n
        for n in walk(scope)
        if n.tag == "button" and not is_hidden(n, hiding_classes) and not is_disabled_button(n)
    ]


# ── structural checks ───────────────────────────────────────────────────────


def check_reference_structure(root: Node, failures: list[str]) -> None:
    hiding = stylesheet_hiding_classes(root)

    # ── unique section head + unique head-actions container ──
    heads = [n for n in walk(root) if "section-head" in class_tokens(n)]
    if len(heads) != 1:
        failures.append(f"structure: expected exactly one home .section-head, found {len(heads)}")
    containers = [n for n in walk(root) if "head-actions" in class_tokens(n)]
    if len(containers) != 1:
        failures.append(
            f"structure: expected exactly one .head-actions actions group, found {len(containers)}"
        )
        return
    container = containers[0]
    if not any(container is ancestor or container in walk(ancestor) for ancestor in heads):
        failures.append("structure: the .head-actions actions group must live inside the home .section-head")

    # ── required controls: inside THAT container, unique, ordered ──
    inside_buttons = visible_buttons(container, hiding)
    manage = [b for b in inside_buttons if text_content(b).strip() == "管理首页 Apps"]
    allapps = [b for b in inside_buttons if text_content(b).strip() == "全部 Apps"]
    if len(manage) != 1:
        failures.append(
            "structure: expected exactly one visible interactive <button>管理首页 Apps inside the unique "
            f".head-actions actions group, found {len(manage)} (controls outside the actions group, "
            "hidden/aria-hidden/disabled/span-substitutes are rejected)"
        )
    if len(allapps) != 1:
        failures.append(
            "structure: expected exactly one visible interactive <button>全部 Apps inside the unique "
            f".head-actions actions group, found {len(allapps)} (non-interactive substitutes rejected)"
        )
    if len(manage) == 1 and len(allapps) == 1:
        if inside_buttons.index(manage[0]) > inside_buttons.index(allapps[0]):
            failures.append("structure: 管理首页 Apps must appear BEFORE 全部 Apps in the actions group")

    # ── duplicate ambiguity: the labels must not appear on any other
    # visible button ANYWHERE (a valid-looking control elsewhere in
    # .section-head does not satisfy the contract) ──
    for label in ("管理首页 Apps", "全部 Apps"):
        everywhere = [b for b in visible_buttons(root, hiding) if text_content(b).strip() == label]
        if len(everywhere) > 1:
            failures.append(
                f"structure: ambiguous duplicate visible <button>{label}> found {len(everywhere)} times — "
                "a control outside the actions group does not satisfy the contract"
            )

    # ── cards ──
    cards = [n for n in walk(root) if n.tag == "article" and "card" in class_tokens(n)]
    if len(cards) != 3:
        failures.append(f"structure: expected exactly 3 home cards, found {len(cards)}")
        return
    expected = [
        ("Polo 助手", "✦", True, "Polo 内置", [("打开助手", "primary")]),
        ("客户访谈整理", "▣", False, "认证创作者 · 北极星共创社", [("打开", "ghost")]),
        ("素材清洗器", "▦", False, "认证创作者 · 北极星共创社", [("打开", "ghost")]),
    ]
    for card, (name, glyph, is_assistant, source, actions) in zip(cards, expected):
        classes = class_tokens(card)
        if ("assistant" in classes) != is_assistant:
            failures.append(f"structure: card {name!r} assistant-class mismatch")
        card_text = text_content(card)
        if name not in card_text:
            failures.append(f"structure: card order wrong — expected {name!r} card")
            continue
        arts = [n for n in walk(card) if "art" in class_tokens(n)]
        if not arts or text_content(arts[0]).strip() != glyph:
            failures.append(f"structure: card {name!r} tile glyph mismatch (expected {glyph!r})")
        sources = [n for n in walk(card) if "source" in class_tokens(n)]
        if not sources or text_content(sources[0]).strip() != source:
            failures.append(f"structure: card {name!r} source mismatch (expected {source!r})")
        card_buttons = visible_buttons(card, hiding)
        found_actions = []
        for button in card_buttons:
            tokens = class_tokens(button)
            if "primary" in tokens:
                role = "primary"
            elif "ghost" in tokens:
                role = "ghost"
            else:
                role = None  # unknown role class (danger, …) — never mapped to ghost
            found_actions.append((text_content(button).strip(), role))
        if found_actions != actions:
            failures.append(
                f"structure: card {name!r} actions mismatch (exact primary/ghost roles required): "
                f"{found_actions!r} != {actions!r}"
            )


def check_contract_binding(
    contract_path: Path,
    reference_path: Path,
    references_dir: Path,
    failures: list[str],
) -> None:
    """SELF-CONTAINED binding validation: everything resolves relative to the
    SUPPLIED contract path and compares against the SUPPLIED reference path —
    module globals are never consulted."""
    md = contract_path.read_text(encoding="utf-8")
    links = re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", md)
    contract_dir = contract_path.resolve().parent
    references_resolved = references_dir.resolve()
    reference_resolved = reference_path.resolve()

    def inside_references(candidate: Path) -> bool:
        try:
            candidate.relative_to(references_resolved)
            return True
        except ValueError:
            return False

    # Group link targets by their RESOLVED path (relative to the supplied
    # contract) so duplicate same-target, alternative-candidate, and
    # traversal/outside bindings are all detectable in any sandbox.
    groups: dict[Path, list[str]] = {}
    for target in links:
        candidate = (contract_dir / target).resolve()
        groups.setdefault(candidate, []).append(target)

    canonical_targets = groups.get(reference_resolved, [])
    if len(canonical_targets) == 0:
        if links:
            failures.append(
                "binding: contract link(s) exist but none resolves to the checked aligned "
                f"reference {REFERENCE_FILENAME} — alternative candidate or nonexistent binding"
            )
        else:
            failures.append(
                "binding: contract contains no Markdown link at all — malformed or mere-text "
                "mentions do not bind the aligned reference"
            )
    elif len(canonical_targets) > 1:
        failures.append(
            f"binding: ambiguous — {len(canonical_targets)} duplicate same-target contract links "
            "bind the aligned reference; exactly one canonical link is required"
        )
    else:
        if not inside_references(reference_resolved):
            failures.append(
                "binding: the bound reference resolves outside the repository-owned references "
                f"directory (traversal/outside): {reference_resolved}"
            )
        if not reference_resolved.exists():
            failures.append(f"binding: contract-linked reference file does not exist: {reference_resolved}")

    alternative_candidates = [
        candidate
        for candidate in groups
        if candidate != reference_resolved and candidate.exists() and inside_references(candidate)
    ]
    if alternative_candidates:
        failures.append(
            "binding: alternative candidate binding inside the references directory: "
            f"{alternative_candidates!r}"
        )


def check_contract_values(md: str, failures: list[str]) -> None:
    """Threshold and exclusion bindings are parsed as CLAIMS, not as
    any-occurrence substrings: every threshold-mentioning line's numeric
    claims must be exactly {0.02}, and every exclusion-mentioning line must
    unambiguously prohibit exclusions."""
    threshold_claims: set[str] = set()
    for line in md.splitlines():
        if re.search(r"threshold", line, re.IGNORECASE):
            # Standalone numeric claims only — digits embedded in identifiers
            # (POO-43, v1.6.0) are not threshold claims.
            for number in re.findall(r"(?<![\w.-])(\d+\.\d+|\d+)(?![\w.-])", line):
                threshold_claims.add(number)
    if threshold_claims != {"0.02"}:
        failures.append(
            f"contract threshold claims must be exactly 0.02; found {sorted(threshold_claims)} — "
            "a conflicting threshold statement weakens the binding"
        )

    for line in md.splitlines():
        if not re.search(r"exclusion", line, re.IGNORECASE):
            continue
        # A contradictory permission claim (permitted/allowed WITHOUT a
        # negation) unambiguously weakens the binding; mere mentions of
        # retained exclusions (e.g. "the POO-47 exclusion is preserved")
        # are consistent and pass.
        permits = re.search(r"\b(permitted|allowed)\b", line, re.IGNORECASE)
        negated = re.search(r"\b(not|never|no)\b", line, re.IGNORECASE)
        if permits and not negated:
            failures.append(
                "contract contains 'permitted exclusions' claim: "
                f"{line.strip()!r}"
            )


def check(
    oracle: Path,
    reference: Path,
    contract: Path,
    references_dir: Path | None = None,
) -> list[str]:
    references = references_dir if references_dir is not None else REFERENCES_DIR
    failures: list[str] = []

    # 1. Historical oracle: byte-for-byte provenance.
    if not oracle.exists():
        failures.append(f"historical oracle missing: {oracle}")
    else:
        digest = hashlib.sha256(oracle.read_bytes()).hexdigest()
        if digest != PINNED_ORACLE_SHA256:
            failures.append(f"historical oracle bytes changed: {digest} != {PINNED_ORACLE_SHA256}")

    # 2. Aligned reference: structural + string layers.
    if not reference.exists():
        failures.append(f"aligned reference missing: {reference}")
    else:
        html = reference.read_text(encoding="utf-8")
        root = parse_html(html)
        check_reference_structure(root, failures)
        plain = text_content(root)
        for needle in REQUIRED_REFERENCE_STRINGS:
            if needle not in plain:
                failures.append(f"reference missing required string: {needle!r}")
        for needle in FORBIDDEN_REFERENCE_STRINGS:
            if needle in html:
                failures.append(f"reference contains excluded control/copy: {needle!r}")

    # 3. Companion contract: self-contained binding + intact values/patterns.
    if not contract.exists():
        failures.append(f"companion contract missing: {contract}")
    else:
        md = contract.read_text(encoding="utf-8")
        check_contract_binding(contract, reference, references, failures)
        check_contract_values(md, failures)
        for pattern, label in REQUIRED_CONTRACT_PATTERNS:
            if not re.search(pattern, md):
                failures.append(f"contract missing {label}: /{pattern}/")

    return failures


def main() -> int:
    failures = check(ORACLE, REFERENCE, CONTRACT)
    print(json.dumps({
        "ok": not failures,
        "oracleSha256": hashlib.sha256(ORACLE.read_bytes()).hexdigest() if ORACLE.exists() else None,
        "failures": failures,
    }, ensure_ascii=False, indent=1))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
