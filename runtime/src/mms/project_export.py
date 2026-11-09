"""把会话产物复制到用户看得见的赛题文件夹（图表/论文）。

复制是附带动作：目标目录不可写或文件被占用时只记一行日志，不阻断渲染与构建。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def copy_outputs(workspace: str, folder: str, sources: dict[str, str]) -> None:
    if not workspace:
        return
    target = Path(workspace) / folder
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"[mms] 创建 {target} 失败：{exc}", file=sys.stderr)
        return
    for source in sources.values():
        path = Path(source)
        if not path.is_file():
            continue
        try:
            shutil.copy2(path, target / path.name)
        except OSError as exc:
            print(f"[mms] 复制 {path.name} 失败：{exc}", file=sys.stderr)
