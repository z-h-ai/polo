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


if __name__ == "__main__":
    unittest.main()
