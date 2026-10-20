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
from .invoke import FIGURE_SKILL, invoke, list_templates
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


def cmd_templates(args: argparse.Namespace) -> int:
    rows = list_templates()
    if args.json:
        print(json.dumps({"ok": True, "total": len(rows), "templates": rows}, ensure_ascii=False, indent=2))
        return EXIT_OK
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["skill"]] = counts.get(row["skill"], 0) + 1
    summary = " + ".join(f"{name} {n}" for name, n in counts.items())
    print(f"模板 {len(rows)} 个（{summary}）")
    for row in rows:
        print(f"  {row['skill']:<20} {row['id']:<28} {row['title']}")
    return EXIT_OK


def cmd_invoke(args: argparse.Namespace) -> int:
    code, result = invoke(
        args.skill,
        args.template,
        Path(args.out) if args.out else None,
        args.theme,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
    if code == EXIT_OK:
        if result["stdout"].strip():
            print(result["stdout"].rstrip())
        print(f"\n产物目录: {result['out']}")
        for kind, path in result["outputs"].items():
            print(f"  {kind.upper():<4} {path}")
    else:
        print(f"渲染失败: {result.get('error')}", file=sys.stderr)
        if result.get("stdout", "").strip():
            print(result["stdout"].rstrip(), file=sys.stderr)
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mms", description="mathmodel-studio 运行时入口")
    parser.add_argument("--version", action="version", version=f"mms {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_skills = sub.add_parser("skills", help="列举、校验技能注册表")
    mode = p_skills.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="按契约校验注册表（退出码 0/1）")
    mode.add_argument("--json", action="store_true", help="输出整份注册表，供程序读取")
    p_skills.set_defaults(func=cmd_skills)

    p_templates = sub.add_parser("templates", help="列举技能内置模板（figure + diagram）")
    p_templates.add_argument("--json", action="store_true", help="输出机器可读清单")
    p_templates.set_defaults(func=cmd_templates)

    p_invoke = sub.add_parser("invoke", help="调用技能模板（subprocess，按退出码判定）")
    p_invoke.add_argument("skill", help=f"技能名，M1 支持 figure（{FIGURE_SKILL}）")
    p_invoke.add_argument("template", help="模板 id / 别名 / 中文图题片段")
    p_invoke.add_argument("--out", default=None, help="工作目录（默认系统临时目录下的 mms-invoke/）")
    p_invoke.add_argument("--theme", default=None, help="主题名或 .theme.json 路径")
    p_invoke.add_argument("--json", action="store_true", help="输出机器可读结果")
    p_invoke.set_defaults(func=cmd_invoke)
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
