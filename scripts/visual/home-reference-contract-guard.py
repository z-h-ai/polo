#!/usr/bin/env python3
"""POO-43 Home aligned-reference contract guard (R60 structural edition).

Deterministic, checked-in regression guard for the Home authority pair.
R60 hardened edition — validation is STRUCTURAL, not substring-based:

- the HISTORICAL frozen POO-41 Home oracle must stay byte-for-byte unchanged
  (pinned SHA-256);
- the aligned reference is parsed with the standard-library HTML parser into
  a DOM tree and validated structurally:
  * `管理首页 Apps` then `全部 Apps` must each be exactly one VISIBLE,
    INTERACTIVE `<button>` inside the home section-head actions group, in
    that order (hidden/aria-hidden/disabled/span-substitutes/duplicate
    labels are rejected — the label merely existing elsewhere never counts);
  * exactly three `.card` articles in order: Polo 助手 (assistant accent
    tile, source `Polo 内置`, primary 打开助手), 客户访谈整理 (`▣`,
    认证创作者 · 北极星共创社, ghost 打开), 素材清洗器 (`▦`, same);
  * excluded Skills/runtime/legacy strings must appear nowhere;
- the companion contract must link the aligned artifact through a real
  Markdown link that resolves to exactly the checked reference path inside
  the repository-owned references directory, plus intact viewport/locale/
  threshold/no-exclusion bindings and the historical provenance hash.

Exit 0 = every invariant holds; non-zero with a JSON failure report.
The checks are factored as `check(oracle, reference, contract)` so the
checked-in adversarial mutation suite can drive them against isolated
temporary copies.
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
    (r"exclusions are not permitted", "no-exclusion binding"),
    (r"zh-Hans", "locale binding"),
    (r"875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887", "historical provenance hash"),
    (r"管理首页 Apps", "required management control"),
    (r"shortcut-only", "shortcut-only dialog binding"),
]
FORBIDDEN_CONTRACT_PATTERNS = [
    (r"threshold[^\n]{0,40}(0\.0(?!2)[1-9]|0\.[1-9][0-9]?|[1-9]\.)", "weakened threshold"),
    (r"exclusion[s]?\s+(are\s+)?(permitted|allowed)", "permitted exclusions"),
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
        if isinstance(child, str):
            parts.append(child)
        else:
            parts.append(text_content(child))
    return "".join(parts)


def class_tokens(node: Node) -> set[str]:
    return set((node.attrs.get("class") or "").split())


def is_hidden(node: Node) -> bool:
    current: Node | None = node
    while current is not None and current.tag != "#root":
        if "hidden" in current.attrs:
            return True
        if (current.attrs.get("aria-hidden") or "").strip().lower() == "true":
            return True
        style = (current.attrs.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style or "opacity:0" in style:
            return True
        if "hidden" in class_tokens(current):
            return True
        current = current.parent
    return False


def is_disabled_button(node: Node) -> bool:
    if node.tag != "button":
        return True
    if "disabled" in node.attrs:
        return True
    aria = (node.attrs.get("aria-disabled") or "").strip().lower()
    return aria == "true"


def find_section_head(root: Node) -> Node | None:
    for node in walk(root):
        if node.tag in ("div", "section") and "section-head" in class_tokens(node):
            return node
    return None


def visible_buttons(node: Node) -> list[Node]:
    return [n for n in walk(node) if n.tag == "button" and not is_hidden(n) and not is_disabled_button(n)]


# ── structural checks ───────────────────────────────────────────────────────

def check_reference_structure(root: Node, failures: list[str]) -> None:
    head = find_section_head(root)
    if head is None:
        failures.append("structure: home section-head not found")
        return

    # Required controls: exactly one visible interactive <button> per label,
    # inside the section-head actions group, in the order 管理首页 Apps → 全部 Apps.
    head_buttons = visible_buttons(head)
    manage = [b for b in head_buttons if text_content(b).strip() == "管理首页 Apps"]
    allapps = [b for b in head_buttons if text_content(b).strip() == "全部 Apps"]
    if len(manage) != 1:
        failures.append(
            f"structure: expected exactly one visible interactive <button>管理首页 Apps in the home "
            f"section head, found {len(manage)} (hidden/aria-hidden/disabled/span-substitutes rejected)")
    if len(allapps) != 1:
        failures.append(
            f"structure: expected exactly one visible interactive <button>全部 Apps in the home "
            f"section head, found {len(allapps)} (non-interactive substitutes rejected)")
    if len(manage) == 1 and len(allapps) == 1:
        order = [id(b) for b in head_buttons]
        if order.index(id(manage[0])) > order.index(id(allapps[0])):
            failures.append("structure: 管理首页 Apps must appear BEFORE 全部 Apps in the section head")

    # Duplicate ambiguity: the labels must not appear on any other button.
    for label in ("管理首页 Apps", "全部 Apps"):
        duplicates = [b for b in visible_buttons(root) if text_content(b).strip() == label]
        if len(duplicates) > 1:
            failures.append(f"structure: ambiguous duplicate visible <button>{label}> found {len(duplicates)} times")

    # Cards: exactly three `.card` articles in the expected order with
    # expected tile/source/action roles.
    cards = [n for n in walk(root) if n.tag == "article" and "card" in class_tokens(n)]
    if len(cards) != 3:
        failures.append(f"structure: expected exactly 3 home cards, found {len(cards)}")
        return
    expected = [
        ("Polo 助手", "✦", "assistant", "Polo 内置", [("打开助手", "primary")]),
        ("客户访谈整理", "▣", "", "认证创作者 · 北极星共创社", [("打开", "ghost")]),
        ("素材清洗器", "▦", "", "认证创作者 · 北极星共创社", [("打开", "ghost")]),
    ]
    for card, (name, glyph, extra_class, source, actions) in zip(cards, expected):
        classes = class_tokens(card)
        label = extra_class if extra_class else "plain"
        if ("assistant" in classes) != bool(extra_class):
            failures.append(f"structure: card {name!r} assistant-class mismatch (expected {label})")
        card_text = text_content(card)
        if f"{name}" not in card_text:
            failures.append(f"structure: card order wrong — expected {name!r} card")
            continue
        arts = [n for n in walk(card) if "art" in class_tokens(n)]
        if not arts or text_content(arts[0]).strip() != glyph:
            failures.append(f"structure: card {name!r} tile glyph mismatch (expected {glyph!r})")
        sources = [n for n in walk(card) if "source" in class_tokens(n)]
        if not sources or text_content(sources[0]).strip() != source:
            failures.append(f"structure: card {name!r} source mismatch (expected {source!r})")
        card_buttons = visible_buttons(card)
        found_actions = [(text_content(b).strip(), ("primary" if "primary" in class_tokens(b) else "ghost")) for b in card_buttons]
        if found_actions != actions:
            failures.append(f"structure: card {name!r} actions mismatch: {found_actions!r} != {actions!r}")


def check_contract_binding(contract_text: str, failures: list[str]) -> None:
    # The contract must reference the aligned artifact through a real Markdown
    # link whose target resolves to EXACTLY the checked reference path inside
    # the repository-owned references directory. A mention elsewhere is not
    # a binding.
    links = re.findall(r"\[[^\]]*\]\(([^)\s]+)\)", contract_text)
    resolved = None
    for target in links:
        candidate = (CONTRACT.parent / target).resolve()
        if candidate == REFERENCE.resolve():
            resolved = candidate
            break
    if resolved is None:
        failures.append(
            f"binding: no contract Markdown link resolves to the checked aligned reference "
            f"{REFERENCE_FILENAME} inside {REFERENCES_DIR}")
    elif not resolved.exists():
        failures.append(f"binding: contract-linked reference does not exist: {resolved}")
    if not any(target.lstrip("./") == REFERENCE_FILENAME for target in links):
        failures.append(f"binding: contract never links the reference filename {REFERENCE_FILENAME} directly")


def check(oracle: Path, reference: Path, contract: Path) -> list[str]:
    failures: list[str] = []

    # 1. Historical oracle: byte-for-byte provenance.
    if not oracle.exists():
        failures.append(f"historical oracle missing: {oracle}")
    else:
        digest = hashlib.sha256(oracle.read_bytes()).hexdigest()
        if digest != PINNED_ORACLE_SHA256:
            failures.append(f"historical oracle bytes changed: {digest} != {PINNED_ORACLE_SHA256}")

    # 2. Aligned reference: present + structural + string layers.
    if not reference.exists():
        failures.append(f"aligned reference missing: {reference}")
    else:
        html = reference.read_text(encoding="utf-8")
        root = parse_html(html)
        check_reference_structure(root, failures)
        for needle in REQUIRED_REFERENCE_STRINGS:
            if needle not in text_content(root):
                failures.append(f"reference missing required string: {needle!r}")
        whole = html
        for needle in FORBIDDEN_REFERENCE_STRINGS:
            if needle in whole:
                failures.append(f"reference contains excluded control/copy: {needle!r}")

    # 3. Companion contract: structural binding + intact patterns.
    if not contract.exists():
        failures.append(f"companion contract missing: {contract}")
    else:
        md = contract.read_text(encoding="utf-8")
        check_contract_binding(md, failures)
        for pattern, label in REQUIRED_CONTRACT_PATTERNS:
            if not re.search(pattern, md):
                failures.append(f"contract missing {label}: /{pattern}/")
        for pattern, label in FORBIDDEN_CONTRACT_PATTERNS:
            if re.search(pattern, md, flags=re.IGNORECASE):
                failures.append(f"contract contains {label}: /{pattern}/")

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
