from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import BIN_DIR


@unittest.skipIf(os.name == "nt", "POSIX wrapper smoke runs on macOS/Linux")
class PoloWrapperSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="polo wrapper 空格 ")
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "Polo 应用 with spaces" / "Contents" / "Resources"
        self.app = self.root / "app"
        self.bin = self.app / "resources" / "bin"
        self.runtime = self.root / "vendor" / "bun" / "bun"
        self.cli = self.app / "dist" / "cli" / "polo-cli.js"
        self.server = self.app / "dist" / "server" / "polo-server.js"
        self.record = self.base / "wrapper record.json"
        for directory in (self.bin, self.runtime.parent, self.cli.parent, self.server.parent):
            directory.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BIN_DIR / "polo", self.bin / "polo")
        shutil.copy2(BIN_DIR / "polo-ai", self.bin / "polo-ai")
        self.cli.write_text("fixture cli\n", encoding="utf-8")
        self.server.write_text("fixture server\n", encoding="utf-8")
        self.runtime.write_text(
            """#!/bin/sh
python3 - "$@" <<'PY'
import json
import os
import sys
with open(os.environ["POLO_WRAPPER_RECORD"], "w", encoding="utf-8") as handle:
    json.dump({
        "argv": sys.argv[1:],
        "bun": os.environ.get("POLO_AI_BUN"),
        "server": os.environ.get("POLO_AI_SERVER_ENTRY"),
        "appRoot": os.environ.get("POLO_AI_APP_ROOT"),
        "resources": os.environ.get("POLO_AI_RESOURCES_PATH"),
        "packaged": os.environ.get("POLO_AI_IS_PACKAGED"),
    }, handle, ensure_ascii=False)
PY
exit "${POLO_WRAPPER_EXIT:-37}"
""",
            encoding="utf-8",
        )
        for executable in (self.bin / "polo", self.bin / "polo-ai", self.runtime):
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_checked_in_wrappers_resolve_and_forward_from_unicode_fixture(self) -> None:
        env = dict(os.environ)
        env["POLO_WRAPPER_RECORD"] = str(self.record)
        env["POLO_WRAPPER_EXIT"] = "37"
        args = ["--fixture", "value with spaces", "参数"]
        result = subprocess.run(
            [str(self.bin / "polo"), *args],
            cwd=self.base,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 37, msg=result.stderr)
        record = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(record["argv"], ["run", str(self.cli), *args])
        self.assertEqual(record["bun"], str(self.runtime))
        self.assertEqual(record["server"], str(self.server))
        self.assertEqual(record["appRoot"], str(self.app))
        self.assertEqual(record["resources"], str(self.app / "resources"))
        self.assertEqual(record["packaged"], "true")

        compat = subprocess.run(
            [str(self.bin / "polo-ai"), "兼容", "space arg"],
            cwd=self.base,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(compat.returncode, 37)
        self.assertIn("deprecated", compat.stderr)
        record = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(record["argv"], ["run", str(self.cli), "兼容", "space arg"])

    def test_checked_in_wrapper_localizes_missing_runtime_with_fallback(self) -> None:
        self.runtime.unlink()
        for locale, expected in (
            ("de_DE.UTF-8", "Die gebündelte Polo-Laufzeit fehlt"),
            ("en_US.UTF-8", "Polo's bundled runtime is missing"),
            ("es_ES.UTF-8", "Falta el entorno de ejecución incluido de Polo"),
            ("hu_HU.UTF-8", "A Polo beépített futtatókörnyezete hiányzik"),
            ("ja_JP.UTF-8", "Polo の内蔵ランタイムがありません"),
            ("pl_PL.UTF-8", "Brakuje dołączonego środowiska uruchomieniowego Polo"),
            ("zh_CN.UTF-8", "Polo 内置运行时缺失"),
            ("fr_FR.UTF-8", "Polo's bundled runtime is missing"),
        ):
            with self.subTest(locale=locale):
                env = dict(os.environ)
                env["POLO_AI_LOCALE"] = locale
                result = subprocess.run(
                    [str(self.bin / "polo"), "--version"],
                    cwd=self.base,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("POLO_E_BUNDLED_RUNTIME_MISSING", result.stderr)
                self.assertIn(expected, result.stderr)

    def test_checked_in_wrapper_localizes_missing_terminal_files_with_fallback(self) -> None:
        self.cli.unlink()
        for locale, expected in (
            ("de_DE.UTF-8", "Polo-Terminaldateien fehlen"),
            ("en_US.UTF-8", "Polo terminal files are missing"),
            ("es_ES.UTF-8", "Faltan los archivos de terminal de Polo"),
            ("hu_HU.UTF-8", "A Polo terminálfájljai hiányoznak"),
            ("ja_JP.UTF-8", "Polo のターミナルファイルがありません"),
            ("pl_PL.UTF-8", "Brakuje plików terminala Polo"),
            ("zh-CN", "Polo 终端文件缺失"),
            ("fr_FR.UTF-8", "Polo terminal files are missing"),
        ):
            with self.subTest(locale=locale):
                env = dict(os.environ)
                env["POLO_AI_LOCALE"] = locale
                result = subprocess.run(
                    [str(self.bin / "polo"), "--version"],
                    cwd=self.base,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 1)
                self.assertIn("POLO_E_TERMINAL_FILES_MISSING", result.stderr)
                self.assertIn(expected, result.stderr)

    def test_compatibility_wrapper_localizes_deprecation_warning(self) -> None:
        env = dict(os.environ)
        env["POLO_WRAPPER_RECORD"] = str(self.record)
        env["POLO_AI_LOCALE"] = "zh_CN.UTF-8"
        result = subprocess.run(
            [str(self.bin / "polo-ai"), "--version"],
            cwd=self.base,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 37)
        self.assertIn("POLO_W_DEPRECATED_COMMAND", result.stderr)
        self.assertIn("已弃用", result.stderr)


if __name__ == "__main__":
    unittest.main()
