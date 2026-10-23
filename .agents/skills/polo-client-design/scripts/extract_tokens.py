#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path

from _common import REPO_ROOT, SOURCE_PATH, ToolError, dump_json, load_json, resolve_commit, show_bytes


CSS_FILES = {
    "electron_renderer": "apps/electron/src/renderer/index.css",
    "shared_ui": "packages/ui/src/styles/index.css",
}
PANEL_CONSTANTS = "apps/electron/src/renderer/components/app-shell/panel-constants.ts"
SHARED_LAYOUT = "packages/ui/src/lib/layout.ts"


def block(source: str, selector: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(selector)}\s*\{{", source)
    if not match:
        raise ToolError(f"missing CSS block {selector}")
    start = match.end()
    depth = 1
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index]
    raise ToolError(f"unterminated CSS block {selector}")


def css_variables(source: str, selector: str) -> dict[str, str]:
    body = re.sub(r"/\*.*?\*/", "", block(source, selector), flags=re.S)
    variables: dict[str, str] = {}
    for match in re.finditer(r"(--[A-Za-z0-9_.\\-]+)\s*:\s*(.*?)\s*;", body, re.S):
        value = re.sub(r"\s+", " ", match.group(2)).strip()
        variables[match.group(1)] = value
    return variables


def exported_constants(source: str) -> dict[str, int | float | str]:
    values: dict[str, int | float | str] = {}
    for name, raw in re.findall(r"^export const ([A-Z][A-Z0-9_]*)\s*=\s*([^\n]+)", source, re.M):
        normalized = raw.strip().rstrip(";")
        if re.fullmatch(r"-?\d+", normalized):
            values[name] = int(normalized)
        elif re.fullmatch(r"-?\d+\.\d+", normalized):
            values[name] = float(normalized)
        else:
            values[name] = normalized
    return values


def quoted_constants(source: str, object_name: str) -> dict[str, str | int | float]:
    object_match = re.search(rf"export const {re.escape(object_name)}\s*=\s*\{{(.*?)\}}\s*as const", source, re.S)
    if not object_match:
        raise ToolError(f"missing object {object_name}")
    values: dict[str, str | int | float] = {}
    for name, quoted, number in re.findall(
        r"^\s*(\w+):\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))\s*,", object_match.group(1), re.M
    ):
        values[name] = quoted if quoted else (float(number) if "." in number else int(number))
    return values


def extract(repo: Path, ref: str) -> dict[str, object]:
    commit = resolve_commit(repo, ref)
    themes: dict[str, object] = {}
    for name, path in CSS_FILES.items():
        css = show_bytes(repo, commit, path).decode("utf-8")
        themes[name] = {
            "file": path,
            "light": css_variables(css, ":root"),
            "dark": css_variables(css, ".dark"),
        }
    panel_source = show_bytes(repo, commit, PANEL_CONSTANTS).decode("utf-8")
    layout_source = show_bytes(repo, commit, SHARED_LAYOUT).decode("utf-8")
    return {
        "schema_version": 1,
        "source_commit": commit,
        "themes": themes,
        "layout": {
            "panel_file": PANEL_CONSTANTS,
            "panel_constants": exported_constants(panel_source),
            "shared_file": SHARED_LAYOUT,
            "chat": quoted_constants(layout_source, "CHAT_LAYOUT"),
            "overlay": quoted_constants(layout_source, "OVERLAY_LAYOUT"),
        },
    }


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract deterministic Polo design tokens from a git commit.")
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--ref")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    manifest = load_json(SOURCE_PATH)
    ref = args.ref or manifest["release"]["commit"]
    content = dump_json(extract(args.repo.resolve(), ref))
    if args.output:
        output = args.output if args.output.is_absolute() else REPO_ROOT / args.output
        atomic_write(output, content)
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolError as exc:
        raise SystemExit(f"error: {exc}")
