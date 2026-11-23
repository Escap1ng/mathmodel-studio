"""`mms` 命令行入口。

serve：桌面壳拉起本机通道（stdout 先输出一行握手 JSON）。
run：无界面跑一遍流水线，事件按 JSON Lines 打到 stdout，便于 CI 与排障。

退出码：0 成功 / 1 流水线失败 / 2 用法或环境错误。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import __version__
from .common import utf8_console
from .pipeline import Pipeline
from .provider import find_provider


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import serve

    return serve(args.port)


def _read_problem(args: argparse.Namespace) -> str:
    if args.problem_file:
        path = Path(args.problem_file)
        if not path.is_file():
            raise SystemExit(f"题面文件不存在：{path}")
        return path.read_text(encoding="utf-8", errors="replace")
    return args.problem or ""


def cmd_run(args: argparse.Namespace) -> int:
    problem = _read_problem(args).strip()
    if len(problem) < 10:
        print("题面太短：用 --problem 或 --problem-file 给一段完整题目。", file=sys.stderr)
        return 2

    data_path = Path(args.data).resolve() if args.data else None
    if data_path is not None and (not data_path.is_file() or data_path.suffix.lower() not in (".csv", ".tsv")):
        print(f"数据文件需为存在的 CSV/TSV：{data_path}", file=sys.stderr)
        return 2

    provider = None
    if args.provider and args.provider != "fake":
        provider = find_provider(args.provider)
        if not provider:
            print(f"未知服务商：{args.provider}", file=sys.stderr)
            return 2
        if not os.environ.get("MMS_API_KEY"):
            print("真实服务商需要 MMS_API_KEY 环境变量（不会落盘）。", file=sys.stderr)
            return 2

    stamp = time.strftime("%Y%m%d-%H%M%S")
    job_dir = Path(args.out).resolve() if args.out else (Path.cwd() / "runs" / stamp)
    job_dir.mkdir(parents=True, exist_ok=True)

    def emit(event: str, data: dict) -> None:
        print(json.dumps({"event": event, "data": data}, ensure_ascii=False), flush=True)

    pipeline = Pipeline(
        job_dir=job_dir,
        problem=problem,
        data_path=data_path,
        provider=provider,
        api_key=os.environ.get("MMS_API_KEY", ""),
        model=args.model or ((provider or {}).get("models") or ["offline"])[0],
        emit=emit,
        should_stop=lambda: False,
    )
    summary = pipeline.run()
    print(f"输出目录：{job_dir}", file=sys.stderr)
    return 0 if summary.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    utf8_console()
    parser = argparse.ArgumentParser(prog="mms", description="mathmodel-studio 运行时")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_serve = sub.add_parser("serve", help="启动本机通道服务器（桌面壳使用）")
    p_serve.add_argument("--port", type=int, default=0)
    p_serve.set_defaults(func=cmd_serve)

    p_run = sub.add_parser("run", help="无界面跑一遍：题面 → 选模 → 代码 → 论文")
    p_run.add_argument("--problem", "-p", help="题目文本")
    p_run.add_argument("--problem-file", help="题目文本文件")
    p_run.add_argument("--data", help="CSV/TSV 数据文件（省略则用内置样例）")
    p_run.add_argument("--provider", default="fake", help="服务商 id（默认 fake 离线）")
    p_run.add_argument("--model", help="模型名（省略取服务商第一个）")
    p_run.add_argument("--out", help="输出目录（省略 runs/<时间戳>）")
    p_run.set_defaults(func=cmd_run)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001  顶层兜底，错误要能落到退出码
        print(f"失败：{exc}", file=sys.stderr)
        return 1
