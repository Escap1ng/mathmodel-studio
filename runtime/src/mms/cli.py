"""`mms` 命令行入口。

退出码沿用上游技能集的 CLI 契约：0 成功 / 1 校验失败 / 2 用法或环境错误。
三码各自可达由 runtime/selfcheck.py 反向验证。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .registry import (
    EXIT_OK,
    EXIT_USAGE_OR_ENV,
    EXIT_VALIDATION_FAILED,
    EnvError,
    load_manifest,
    minimal_validate,
    repo_root,
    skills,
)


def _force_utf8_stdout() -> None:
    # Windows 控制台默认 GBK，打印中文技能名会直接抛 UnicodeEncodeError。
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def _schema_problems(manifest: dict) -> tuple[list[str], str]:
    """优先用 jsonschema 校验契约；缺库则降级为内置最小校验。返回 (问题, 用到的方式)。"""
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return minimal_validate(manifest), "minimal"
    schema_path = repo_root() / "schemas" / "skill-manifest.schema.json"
    if not schema_path.is_file():
        raise EnvError(f"契约文件不存在: {schema_path}")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    problems = [
        f"{'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message}"
        for e in sorted(validator.iter_errors(manifest), key=lambda e: list(e.absolute_path))
    ]
    return problems, "jsonschema"


def cmd_skills(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    entries = skills(manifest)

    if args.check:
        problems, how = _schema_problems(manifest)
        if args.json:
            print(json.dumps({"ok": not problems, "validator": how, "problems": problems}, ensure_ascii=False, indent=2))
        elif problems:
            print(f"注册表校验未通过（{len(problems)} 项，判据来源 {how}）：", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
        else:
            print(f"注册表校验通过（判据来源 {how}，技能 {len(entries)} 个）")
        return EXIT_VALIDATION_FAILED if problems else EXIT_OK

    if args.json:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return EXIT_OK

    print(f"{manifest['title']} · {len(entries)} 个技能 · manifest {manifest['manifest_version']}")
    for s in entries:
        ui = s["ui"]
        print(
            f"  {s['name']:<20} {s['kind']:<10} {s['status']:<9} "
            f"阶段 {','.join(str(p) for p in ui['phases']):<14} 卡点 {','.join(ui['hitl']) or '-'}"
        )
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mms", description="mathmodel-studio 运行时入口")
    parser.add_argument("--version", action="version", version=f"mms {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_skills = sub.add_parser("skills", help="列举、校验技能注册表")
    mode = p_skills.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="按契约校验注册表（退出码 0/1）")
    mode.add_argument("--json", action="store_true", help="输出整份注册表，供程序读取")
    p_skills.set_defaults(func=cmd_skills)
    return parser


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except EnvError as exc:
        print(f"环境或用法错误: {exc}", file=sys.stderr)
        return EXIT_USAGE_OR_ENV
    except FileNotFoundError as exc:
        print(f"环境或用法错误: {exc}", file=sys.stderr)
        return EXIT_USAGE_OR_ENV
    except json.JSONDecodeError as exc:
        print(f"校验失败: 注册表不是合法 JSON — {exc}", file=sys.stderr)
        return EXIT_VALIDATION_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
