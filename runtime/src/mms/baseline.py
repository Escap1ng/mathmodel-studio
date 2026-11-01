"""阶段四 · 基线回归的落地部分：定位数据、生成并执行脚本、收产物。

编排层只负责报进度；这里只做四件事，且不引入 pandas / scikit-learn：
requirements 里只有 numpy 与 matplotlib，基线用最小二乘直接算。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

DATA_SUFFIXES = (".csv", ".tsv")
SCRIPT_NAME = "solution.py"
SAMPLE_NAME = "sample.csv"

SCRIPT = '''"""阶段四 · 基线回归：读一份表，报形状与拟合优度，输出三联图。

由 MathModel Studio 生成，可单独重跑：
    python solution.py --data <csv> --out <dir>
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

TARGET_FALLBACK = True


def read_table(path: Path) -> tuple[list[str], np.ndarray]:
    raw = Path(path).read_bytes()
    text = None
    for encoding in ("utf-8-sig", "gbk", "utf-8"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise SystemExit("数据文件无法解码（试过 utf-8-sig / gbk / utf-8）")
    rows = [row for row in csv.reader(text.splitlines()) if any(cell.strip() for cell in row)]
    if len(rows) < 3:
        raise SystemExit("数据行数不足：至少需要表头加两行数据")
    header = [cell.strip() or f"col{i + 1}" for i, cell in enumerate(rows[0])]
    body = []
    for row in rows[1:]:
        cells = []
        for index in range(len(header)):
            cell = row[index].strip() if index < len(row) else ""
            try:
                cells.append(float(cell))
            except ValueError:
                cells.append(np.nan)
        body.append(cells)
    return header, np.asarray(body, dtype=float)


def numeric_columns(matrix: np.ndarray, ratio: float = 0.6) -> list[int]:
    keep = []
    for index in range(matrix.shape[1]):
        column = matrix[:, index]
        if np.isfinite(column).sum() >= max(3, int(ratio * column.size)):
            keep.append(index)
    return keep


def fit_baseline(matrix: np.ndarray, target: int, features: list[int]):
    y = matrix[:, target]
    mask = np.isfinite(y)
    if features:
        x = matrix[:, features]
        mask &= np.isfinite(x).all(axis=1)
    if mask.sum() < 3 or not features:
        return None
    design = np.column_stack([np.ones(int(mask.sum())), matrix[mask][:, features]])
    observed = y[mask]
    beta, *_ = np.linalg.lstsq(design, observed, rcond=None)
    predicted = design @ beta
    residual = observed - predicted
    ss_res = float(np.sum(residual ** 2))
    ss_tot = float(np.sum((observed - observed.mean()) ** 2))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    rmse = float(np.sqrt(ss_res / len(observed)))
    return {
        "rows": int(mask.sum()),
        "beta": [float(value) for value in beta],
        "r2": r2,
        "rmse": rmse,
        "observed": observed,
        "predicted": predicted,
        "residual": residual,
    }


def draw(target_values, fit, header, target_name, missing, out_dir: Path) -> list[str]:
    fig, axes = plt.subplots(1, 3, figsize=(11.2, 3.4))
    axes[0].hist(target_values[np.isfinite(target_values)], bins=24, color="#4C72B0", edgecolor="white")
    axes[0].set_title(f"Target distribution: {target_name}")
    axes[0].set_xlabel(target_name)
    axes[0].set_ylabel("count")

    if fit is not None:
        axes[1].scatter(fit["observed"], fit["predicted"], s=12, color="#4C72B0", alpha=0.75)
        low = float(min(fit["observed"].min(), fit["predicted"].min()))
        high = float(max(fit["observed"].max(), fit["predicted"].max()))
        axes[1].plot([low, high], [low, high], color="#8E9AAF", linestyle="--", linewidth=1.0)
        axes[1].set_title(f"Observed vs fitted  R2={fit['r2']:.3f}")
        axes[1].set_xlabel("observed")
        axes[1].set_ylabel("fitted")

        axes[2].hist(fit["residual"], bins=24, color="#DD8452", edgecolor="white")
        axes[2].axvline(0.0, color="#8E9AAF", linestyle="--", linewidth=1.0)
        axes[2].set_title(f"Residuals  RMSE={fit['rmse']:.3f}")
        axes[2].set_xlabel("residual")
        axes[2].set_ylabel("count")
    else:
        axes[1].text(0.5, 0.5, "not enough numeric columns\\nfor a baseline fit", ha="center", va="center",
                     transform=axes[1].transAxes, fontsize=9, color="#555555")
        axes[1].set_title("Observed vs fitted")
        names = list(missing.keys())[:12]
        values = [missing[name] for name in names]
        axes[2].barh(names[::-1], values[::-1], color="#DD8452")
        axes[2].set_title("Missing values per column")
        axes[2].set_xlabel("cells without a number")

    fig.suptitle(f"Phase 4 baseline · {target_name}", fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    outputs = []
    for suffix in ("png", "pdf", "svg"):
        path = out_dir / f"figure.{suffix}"
        fig.savefig(path, dpi=160)
        outputs.append(str(path))
    plt.close(fig)
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    header, matrix = read_table(Path(args.data))
    numeric = numeric_columns(matrix)
    if not numeric:
        raise SystemExit("没有可用的数值列：基线需要至少一列数字")
    target = numeric[-1] if len(numeric) > 1 else numeric[0]
    features = [index for index in numeric if index != target]
    missing = {
        header[index]: int((~np.isfinite(matrix[:, index])).sum())
        for index in range(matrix.shape[1])
    }
    fit = fit_baseline(matrix, target, features)
    outputs = draw(matrix[:, target], fit, header, header[target], missing, out_dir)

    result = {
        "ok": True,
        "data": Path(args.data).name,
        "rows": int(matrix.shape[0]),
        "cols": int(matrix.shape[1]),
        "numeric_columns": [header[index] for index in numeric],
        "target": header[target],
        "features": [header[index] for index in features],
        "missing": missing,
        "r2": None if fit is None else round(fit["r2"], 4),
        "rmse": None if fit is None else round(fit["rmse"], 4),
        "fit_rows": None if fit is None else fit["rows"],
        "outputs": outputs,
    }
    (out_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"rows={result['rows']} cols={result['cols']} target={result['target']}")
    if fit is not None:
        print(f"fit_rows={fit['rows']} r2={fit['r2']:.4f} rmse={fit['rmse']:.4f}")
    for path in outputs:
        print(f"output {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''


def find_data(workspace: Path) -> Path | None:
    """工作区里最新的 CSV/TSV；附件副本在 附件/日期/ 下，所以递归找。"""
    if not workspace.is_dir():
        return None
    best: tuple[float, Path] | None = None
    for path in workspace.rglob("*"):
        if path.suffix.lower() not in DATA_SUFFIXES or not path.is_file():
            continue
        if any(part.startswith(".") for part in path.parts):
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, path)
    return best[1] if best else None


def ensure_sample(code_dir: Path) -> Path:
    """工作区没有数据时用一份内置样例把链路跑通，文件名与内容都标明 sample。"""
    path = code_dir / SAMPLE_NAME
    if path.is_file():
        return path
    lines = ["x1,x2,y"]
    seed = 20261101
    for index in range(120):
        seed = (seed * 1103515245 + 12345) % 2147483648
        noise = (seed / 2147483648 - 0.5) * 1.6
        x1 = round((index % 24) * 0.5 + (index // 24) * 0.3, 3)
        x2 = round(1.5 + (index % 7) * 0.2, 3)
        y = round(2.4 * x1 + 0.8 * x2 + noise, 3)
        lines.append(f"{x1},{x2},{y}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def write_script(code_dir: Path) -> tuple[Path, int]:
    code_dir.mkdir(parents=True, exist_ok=True)
    path = code_dir / SCRIPT_NAME
    path.write_text(SCRIPT, encoding="utf-8")
    return path, len(SCRIPT.splitlines())


def run_baseline(
    code_dir: Path, data_path: Path, out_dir: Path, timeout: int = 180
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "MPLCONFIGDIR": str(code_dir / ".mplconfig"),
    }
    command = [
        sys.executable,
        str(code_dir / SCRIPT_NAME),
        "--data",
        str(data_path),
        "--out",
        str(out_dir),
    ]
    try:
        proc = subprocess.run(
            command,
            cwd=str(code_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "exit": -1,
            "stdout": "",
            "stderr": f"基线脚本超时（{timeout}s）",
            "result": {},
            "outputs": {},
            "command": " ".join(command),
        }

    result_path = out_dir / "result.json"
    result: dict = {}
    if result_path.is_file():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            result = {}
    outputs = {
        kind: str(out_dir / f"figure.{kind}")
        for kind in ("png", "pdf", "svg")
        if (out_dir / f"figure.{kind}").is_file()
    }
    ok = proc.returncode == 0 and len(outputs) == 3
    return {
        "ok": ok,
        "exit": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "result": result,
        "outputs": outputs,
        "command": " ".join(command),
    }
