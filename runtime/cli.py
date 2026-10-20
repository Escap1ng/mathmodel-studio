#!/usr/bin/env python3
"""开发期入口：`python runtime/cli.py ...`（或 `npm run mms -- ...`）。

把 `runtime/src` 加进 sys.path 后转调 `mms.cli`，这样在仓库根就能跑，
不必先 pip install -e，也不必在 Windows 与 bash 之间换 PYTHONPATH 写法。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from mms.cli import main  # noqa: E402  （必须先设置 sys.path）

raise SystemExit(main())
