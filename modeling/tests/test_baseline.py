"""基线脚本的多数据契约：--data 可重复，result.json 记录每份数据的形状。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mms_modeling import baseline  # noqa: E402


def write_csv(path: Path, header: list[str], rows: list[list[float]]) -> None:
    lines = [",".join(header)]
    lines += [",".join(str(value) for value in row) for row in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class BaselineScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.code = self.root / "code"
        self.code.mkdir()
        (self.code / "solution.py").write_text(baseline.SCRIPT, encoding="utf-8")
        self.out = self.root / "out"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_script(self, *data: Path) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "MPLCONFIGDIR": str(self.root / ".mplconfig"),
        }
        return subprocess.run(
            [sys.executable, str(self.code / "solution.py"), "--data", *map(str, data), "--out", str(self.out)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=120,
            check=False,
        )

    def result(self) -> dict:
        return json.loads((self.out / "result.json").read_text(encoding="utf-8"))

    def test_single_dataset(self) -> None:
        first = self.root / "one.csv"
        write_csv(first, ["x", "y"], [[index, 2 * index + 1] for index in range(12)])
        proc = self.run_script(first)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = self.result()
        self.assertEqual(result["data"], "one.csv")
        self.assertEqual([item["name"] for item in result["datasets"]], ["one.csv"])

    def test_multiple_datasets_keep_order(self) -> None:
        first = self.root / "产量.csv"
        second = self.root / "说明.csv"
        write_csv(first, ["温度", "压力", "产量"], [[20 + i * 0.1, 1.2, 50 + i * 0.2] for i in range(20)])
        write_csv(second, ["字段", "含义"], [[1, 2], [3, 4], [5, 6]])
        proc = self.run_script(first, second)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = self.result()
        self.assertEqual(result["data"], "产量.csv")
        self.assertEqual([item["name"] for item in result["datasets"]], ["产量.csv", "说明.csv"])
        self.assertEqual(
            [(item["rows"], item["cols"]) for item in result["datasets"]], [(20, 3), (3, 2)]
        )
        for suffix in ("png", "pdf", "svg"):
            self.assertTrue((self.out / f"figure.{suffix}").is_file())


if __name__ == "__main__":
    unittest.main()
