#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from _common import REPO_ROOT, SOURCE_PATH, ToolError, dump_json, load_json
from compare_source import compare, parse_name_status, sections_for, validate_release
from extract_tokens import css_variables, exported_constants, extract
from validate_skill import DESIGN_CONTEXT, local_inventory, validate_design_context


STABLE_RELEASE = {
    "tag_name": "v1.2.3",
    "name": "v1.2.3",
    "published_at": "2026-01-01T00:00:00Z",
    "draft": False,
    "prerelease": False,
}


class ReleaseTests(unittest.TestCase):
    def test_stable_release_is_accepted(self) -> None:
        self.assertEqual(validate_release(dict(STABLE_RELEASE), "v1.2.3")["tag_name"], "v1.2.3")

    def test_draft_prerelease_unpublished_and_wrong_tag_are_rejected(self) -> None:
        cases = [
            {**STABLE_RELEASE, "draft": True},
            {**STABLE_RELEASE, "prerelease": True},
            {**STABLE_RELEASE, "published_at": None},
        ]
        for payload in cases:
            with self.assertRaises(ToolError):
                validate_release(payload, "v1.2.3")
        with self.assertRaises(ToolError):
            validate_release(dict(STABLE_RELEASE), "v9.9.9")


class ChangeTests(unittest.TestCase):
    def test_add_delete_modify_and_rename_are_preserved(self) -> None:
        changes = parse_name_status(
            "A\tapps/electron/src/renderer/components/New.tsx\n"
            "D\tpackages/ui/src/components/Old.tsx\n"
            "M\tapps/electron/src/renderer/index.css\n"
            "R095\tpackages/ui/src/components/OldButton.tsx\tpackages/ui/src/components/Button.tsx\n"
        )
        self.assertEqual([item["status"] for item in changes], ["A", "D", "M", "R"])
        self.assertEqual(changes[-1]["old_path"], "packages/ui/src/components/OldButton.tsx")
        self.assertEqual(changes[-1]["similarity"], "095")

    def test_theme_component_and_non_ui_hints(self) -> None:
        self.assertIn("foundations", sections_for("apps/electron/src/renderer/index.css"))
        self.assertIn("interaction-states", sections_for("packages/ui/src/components/ui/Button.tsx"))
        self.assertEqual(sections_for("apps/electron/src/renderer/state/store.ts"), ["semantic-review"])

    def test_only_non_ui_commit_produces_no_covered_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Skill Test"], cwd=repo, check=True)
            (repo / "ui").mkdir()
            (repo / "ui" / "theme.css").write_text(":root { --accent: red; }\n", encoding="utf-8")
            (repo / "server.txt").write_text("one\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "first"], cwd=repo, check=True)
            first = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            (repo / "server.txt").write_text("two\n", encoding="utf-8")
            subprocess.run(["git", "commit", "-qam", "server only"], cwd=repo, check=True)
            second = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            self.assertEqual(compare(repo, first, second, ["ui"]), [])

            (repo / "ui" / "theme.css").write_text(":root { --accent: blue; }\n", encoding="utf-8")
            subprocess.run(["git", "commit", "-qam", "theme"], cwd=repo, check=True)
            third = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
            changes = compare(repo, second, third, ["ui"])
            self.assertEqual(changes[0]["status"], "M")
            self.assertIn("foundations", changes[0]["sections"])


class ExtractionTests(unittest.TestCase):
    def test_light_and_dark_variables_are_distinct(self) -> None:
        css = ":root { --accent: red; --shadow: 0 1px\n 2px black; }\n.dark { --accent: blue; }"
        self.assertEqual(css_variables(css, ":root")["--accent"], "red")
        self.assertEqual(css_variables(css, ".dark")["--accent"], "blue")
        self.assertEqual(css_variables(css, ":root")["--shadow"], "0 1px 2px black")

    def test_same_commit_is_byte_idempotent(self) -> None:
        first = dump_json(extract(REPO_ROOT, "v0.16.3"))
        second = dump_json(extract(REPO_ROOT, "18e7914c0d432e6d10dad2473c04d6221fa088d9"))
        self.assertEqual(first, second)

    def test_derived_and_platform_constants_are_retained(self) -> None:
        source = "export const GAP = 6\nexport const EDGE = isMac ? 14 : 8\nexport const HALF = GAP / 2\n"
        self.assertEqual(
            exported_constants(source),
            {"GAP": 6, "EDGE": "isMac ? 14 : 8", "HALF": "GAP / 2"},
        )

    def test_invalid_source_does_not_replace_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tokens.json"
            output.write_text("last-valid\n", encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(Path(__file__).with_name("extract_tokens.py")),
                    "--ref",
                    "definitely-not-a-ref",
                    "--output",
                    str(output),
                ],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "last-valid\n")


class DesignContextTests(unittest.TestCase):
    def test_bundled_context_is_the_portable_sot(self) -> None:
        source = load_json(SOURCE_PATH)
        self.assertEqual(validate_design_context(source), [])
        count, digest = local_inventory(DESIGN_CONTEXT)
        self.assertEqual(count, source["design_context"]["file_count"])
        self.assertEqual(digest, source["design_context"]["inventory_sha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
