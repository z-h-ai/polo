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


def strip_css_comments(css: str) -> str:
    """Remove /* … */ comments (newlines included) BEFORE any rule parsing —
    a commented-out rule is inert even when the comment contains braces."""
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


def parse_css_blocks(css: str) -> list[tuple[str, str]]:
    """Brace-matching rule extraction that descends into @-blocks (e.g.
    @media). Returns (selector, body) pairs with comments already stripped."""
    rules: list[tuple[str, str]] = []
    index = 0
    length = len(css)
    while index < length:
        brace = css.find("{", index)
        if brace == -1:
            break
        selector = css[index:brace].strip()
        depth = 1
        cursor = brace + 1
        while cursor < length and depth:
            if css[cursor] == "{":
                depth += 1
            elif css[cursor] == "}":
                depth -= 1
            cursor += 1
        body = css[brace + 1 : cursor - 1]
        if selector.startswith("@"):
            rules.extend(parse_css_blocks(body))
        else:
            rules.append((selector, body))
        index = cursor
    return rules


HIDING_DECLARATIONS = ("display:none", "visibility:hidden", "opacity:0")


def normalize_declaration(body: str) -> str:
    """Normalize a declaration block: strip comments, then ALL whitespace
    (tabs/newlines/formatted splits) — `display:/*c*/none`, `display:\t none`
    and `display:\n none` all normalize to `display:none`."""
    stripped = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    return re.sub(r"\s+", "", stripped).lower()


def normalize_inline_style(style: str) -> str:
    stripped = re.sub(r"/\*.*?\*/", "", style, flags=re.S)
    return re.sub(r"\s+", "", stripped).lower()


def parse_compound_classes(compound: str) -> list[str]:
    return re.findall(r"\.([A-Za-z_][\w-]*)", compound)


def selector_applies(rule_selector: str, node: Node) -> bool:
    """Minimal descendant-combinator selector evaluation: the LAST compound
    must match the element's own classes and every earlier compound must
    match some ancestor (in order). Compound selectors (`.a.b`) require all
    their classes on one node — an unmatched ancestor or compound selector
    stays inert (no global class-token flattening)."""
    parts = [part for part in re.split(r"\s+", rule_selector.strip()) if part]
    if not parts:
        return False
    last = parse_compound_classes(parts[-1])
    own = class_tokens(node)
    if not last or any(cls not in own for cls in last):
        return False
    remaining = list(reversed(parts[:-1]))
    if not remaining:
        return True
    current = node.parent
    index = 0
    while current is not None and current.tag != "#root":
        if index < len(remaining) and all(
            cls in class_tokens(current) for cls in parse_compound_classes(remaining[index])
        ):
            index += 1
            if index == len(remaining):
                return True
        current = current.parent
    return False


def stylesheet_hiding_rules(root: Node) -> list[tuple[str, str]]:
    """(selector, normalized-body) pairs whose declarations hide the element,
    from every <style> block (comments stripped, @-blocks descended)."""
    rules: list[tuple[str, str]] = []
    for node in walk(root):
        if node.tag == "style":
            for selector, body in parse_css_blocks(strip_css_comments(text_content(node))):
                normalized = normalize_declaration(body)
                if any(declaration in normalized for declaration in HIDING_DECLARATIONS):
                    rules.append((selector, normalized))
    return rules


HIDDEN_CLASS_TOKENS = frozenset({"hidden", "invisible"})


def node_attr_hides(node: Node) -> bool:
    if "hidden" in node.attrs:
        return True
    if (node.attrs.get("aria-hidden") or "").strip().lower() == "true":
        return True
    style = normalize_inline_style(node.attrs.get("style") or "")
    return (
        "display:none" in style
        or "visibility:hidden" in style
        or "opacity:0" in style
    )


def is_hidden(node: Node, hiding_rules: list[tuple[str, str]]) -> bool:
    """Visibility from ACTUAL selector rules applied to the control or an
    ancestor (comment/tab/newline-normalized declarations, no class-token
    flattening), plus attribute/inline/class-name-heuristic defenses."""
    current: Node | None = node
    while current is not None and current.tag != "#root":
        if node_attr_hides(current):
            return True
        for selector, body in hiding_rules:
            if selector_applies(selector, current):
                return True
        tokens = class_tokens(current)
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


def visible_buttons(scope: Node, hiding_rules: list[tuple[str, str]]) -> list[Node]:
    return [
        n
        for n in walk(scope)
        if n.tag == "button" and not is_hidden(n, hiding_rules) and not is_disabled_button(n)
    ]


def is_interactive(node: Node) -> bool:
    """Genuinely interactive elements: <button>, <a href>, role=button,
    onclick-carrying elements. A <span> with the same text never qualifies."""
    if node.tag == "button":
        return True
    if node.tag == "a" and "href" in node.attrs:
        return True
    if (node.attrs.get("role") or "").strip().lower() == "button":
        return True
    return "onclick" in node.attrs


def contains_node(ancestor: Node, node: Node) -> bool:
    current = node.parent
    while current is not None:
        if current is ancestor:
            return True
        current = current.parent
    return False


def visible_interactive(scope: Node, hiding_rules: list[tuple[str, str]]) -> list[Node]:
    result = []
    for n in walk(scope):
        if not is_interactive(n) or is_hidden(n, hiding_rules):
            continue
        # `disabled` semantics apply to buttons; non-button interactive
        # elements (<a href>, role=button) are never excluded by it.
        if n.tag == "button" and is_disabled_button(n):
            continue
        result.append(n)
    return result


# ── structural checks ───────────────────────────────────────────────────────


def check_reference_structure(root: Node, failures: list[str]) -> None:
    hiding_rules = stylesheet_hiding_rules(root)

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
    if not any(contains_node(ancestor, container) for ancestor in heads):
        failures.append("structure: the .head-actions actions group must live inside the home .section-head")

    # ── required controls: inside THAT container, unique, ordered ──
    inside_buttons = visible_buttons(container, hiding_rules)
    manage = [b for b in inside_buttons if text_content(b).strip() == "管理首页 Apps"]
    allapps = [b for b in inside_buttons if text_content(b).strip() == "全部 Apps"]
    if len(manage) != 1:
        failures.append(
            "structure: ambiguous — expected exactly one visible interactive <button>管理首页 Apps "
            f"inside the unique .head-actions actions group, found {len(manage)} (controls outside "
            "the actions group, hidden/aria-hidden/disabled/span-substitutes are rejected)"
        )
    if len(allapps) != 1:
        failures.append(
            "structure: ambiguous — expected exactly one visible interactive <button>全部 Apps "
            f"inside the unique .head-actions actions group, found {len(allapps)} "
            "(non-interactive substitutes rejected)"
        )
    if len(manage) == 1 and len(allapps) == 1:
        if inside_buttons.index(manage[0]) > inside_buttons.index(allapps[0]):
            failures.append("structure: 管理首页 Apps must appear BEFORE 全部 Apps in the actions group")

    # ── duplicate/stray ambiguity: ANY visible interactive same-label element
    # ANYWHERE outside the unique .head-actions (button, <a href>, role=button,
    # …) violates the contract — the label merely existing elsewhere in
    # .section-head never satisfies it, and a second interactive control
    # makes the required control ambiguous ──
    for label in ("管理首页 Apps", "全部 Apps"):
        strays = [
            n
            for n in visible_interactive(root, hiding_rules)
            if text_content(n).strip() == label and not contains_node(container, n)
        ]
        if strays:
            failures.append(
                f"structure: ambiguous — visible interactive same-label <{strays[0].tag}>{label}> "
                f"control outside the unique .head-actions actions group ({len(strays)} found); "
                "the two required controls must be the exact ordered buttons inside the container"
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
    allowed_action_tokens = {"button", "primary", "ghost"}
    for card, (name, glyph, is_assistant, source, actions) in zip(cards, expected):
        classes = class_tokens(card)
        if ("assistant" in classes) != is_assistant:
            failures.append(f"structure: card {name!r} assistant-class mismatch")
        # Visible heading/name: a hidden stray span containing the expected
        # name must not mask a visible heading drift.
        headings = [
            n for n in walk(card)
            if n.tag in ("h1", "h2", "h3", "h4") and not is_hidden(n, hiding_rules)
        ]
        visible_names = [text_content(h).strip() for h in headings]
        if visible_names != [name]:
            failures.append(
                f"structure: card {name!r} visible heading mismatch — visible headings "
                f"{visible_names!r} != [{name!r}]; a hidden element retaining the expected "
                "name does not mask visible drift"
            )
        # Visible source line: exact source in the card.
        sources = [
            n for n in walk(card)
            if "source" in class_tokens(n) and not is_hidden(n, hiding_rules)
        ]
        visible_sources = [text_content(n).strip() for n in sources]
        if visible_sources != [source]:
            failures.append(
                f"structure: card {name!r} visible source mismatch — {visible_sources!r} "
                f"!= [{source!r}]"
            )
        arts = [n for n in walk(card) if "art" in class_tokens(n) and not is_hidden(n, hiding_rules)]
        if not arts or text_content(arts[0]).strip() != glyph:
            failures.append(f"structure: card {name!r} tile glyph mismatch (expected {glyph!r})")
        # Action roles: exact token set — the expected role with NO unknown or
        # conflicting role token. `ghost danger`, `primary danger`, and
        # `ghost→danger` all fail.
        card_buttons = visible_buttons(card, hiding_rules)
        found_actions = []
        for button in card_buttons:
            tokens = class_tokens(button)
            role_tokens = tokens & {"primary", "ghost"}
            extra_role_tokens = tokens - allowed_action_tokens
            label = text_content(button).strip()
            found_actions.append((label, sorted(role_tokens), sorted(extra_role_tokens)))
        expected_actions = [(label, [role], []) for label, role in actions]
        if found_actions != expected_actions:
            failures.append(
                f"structure: card {name!r} actions mismatch (exact role token set required — "
                f"expected {expected_actions!r}, unknown/conflicting role tokens rejected): "
                f"{found_actions!r}"
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
    from urllib.parse import unquote

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

    def is_traversal_target(target: str) -> bool:
        """Traversal detection on the PERCENT-DECODED target: `%2e%2e`
        decodes to `..` and `%2f` to `/`, so encoded escapes are caught by
        the same raw-segment check."""
        decoded = unquote(target)
        return ".." in decoded.split("/")

    # RAW canonical-form check FIRST: the canonical link target must be a
    # clean relative path — any `..` segment (raw or percent-encoded,
    # including encoded separators) is traversal even when resolution would
    # land on the aligned reference.
    for target in links:
        if is_traversal_target(target):
            failures.append(
                f"binding: contract link target contains a traversal ('..') segment "
                f"(percent-decoding included): {target!r}"
            )

    def classification_target(target: str) -> str:
        """Strip query and fragment components before extension/candidate
        classification: `./alternate.html#desktop` and `./alternate.md?raw=1`
        classify as their file extensions."""
        return target.split("#", 1)[0].split("?", 1)[0]

    # Group link targets by their RESOLVED path (relative to the supplied
    # contract; query/fragment stripped) so duplicate same-target and
    # alternative bindings are detectable in any sandbox.
    groups: dict[Path, list[str]] = {}
    for target in links:
        if is_traversal_target(target):
            continue  # traversal targets already rejected above
        candidate = (contract_dir / classification_target(target)).resolve()
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

    # EVERY additional HTML/reference candidate link (alternative) is
    # rejected — including nonexistent, uppercase-extension, fragment, and
    # query variants — regardless of where it resolves. Only the single
    # canonical binding may exist.
    alternatives = {
        target
        for candidate, targets in groups.items()
        if candidate != reference_resolved
        for target in targets
        if re.search(r"\.(html?|md)([?#].*)?$", classification_target(target), re.IGNORECASE)
    }
    if alternatives:
        failures.append(
            f"binding: alternative candidate reference link(s) are forbidden — exactly one "
            f"canonical binding may exist: {sorted(alternatives)!r}"
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

    # Each exclusion clause/claim is parsed INDEPENDENTLY (split on
    # sentence separators) so an earlier line-level negation cannot mask an
    # affirmative permission in a later clause:
    # "exclusions are not permitted; icon exclusions are allowed" fails.
    # Clause boundaries: ASCII/fullwidth semicolon, period, Chinese full
    # stop, newline, exclamation, question mark, comma, and conjunction
    # boundaries — a prior denied assertion may not mask a later
    # allowed/permitted assertion.
    clause_split = re.compile(
        r"[;；.。!！?？,，\n]|\band\b|\bAnd\b|和|与",
    )
    for line in md.splitlines():
        if not re.search(r"exclusion", line, re.IGNORECASE):
            continue
        for clause in clause_split.split(line):
            if not re.search(r"exclusion", clause, re.IGNORECASE):
                continue
            permits = re.search(r"\b(permitted|allowed)\b", clause, re.IGNORECASE)
            negated = re.search(r"\b(not|never|no)\b", clause, re.IGNORECASE)
            if permits and not negated:
                failures.append(
                    "contract contains 'permitted exclusions' claim: "
                    f"{clause.strip()!r}"
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
