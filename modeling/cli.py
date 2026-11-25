#!/usr/bin/env python3
"""数模内核入口：`python modeling/cli.py ...`（或 `npm run mms -- ...`）。

把 `modeling/src` 与 `gateway/src` 加进 sys.path 后转调 `mms_modeling.cli`，
这样在仓库根就能跑，不必先 pip install -e。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "gateway" / "src"))
sys.path.insert(0, str(HERE / "src"))

from mms_modeling.cli import main  # noqa: E402  （必须先设置 sys.path）

raise SystemExit(main())
