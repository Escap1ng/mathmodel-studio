"""providers.json -> DSH `llm-pi-ai` 的映射。

这里只做字段翻译，不落盘、不写密钥；profile 里只出现 baseURL 和模型能力，
密钥通过 `MMS_PROVIDER_KEY` 环境注入。深度相关的规则沿用 ChatSession 的
语义：中/高/最大 -> 各模型 wire 值，关闭发送或不识别 -> 发送 `off`。
"""

from __future__ import annotations

import sys

LEVELS = ("medium", "high", "max")


def base_url(provider: dict) -> str:
    value = str(provider.get("base_url") or "").strip().rstrip("/")
    if not value:
        raise ValueError(f"provider {provider.get('id')!r} 缺少 base_url")
    return value


def context_window(provider: dict, context_tokens: int | None) -> int:
    window = int(provider.get("context_len") or 0) or 32768
    if context_tokens:
        window = max(32768, min(window, int(context_tokens)))
    return window


def max_tokens(provider: dict, context_window: int) -> int:
    value = int(provider.get("max_out") or 0) or 8192
    return min(value, 32768, context_window)


def thinking_format(provider: dict) -> str | None:
    """OpenAI 注入 `reasoning_content` 的 provider 统一翻译成 deepseek 格式。"""
    if provider.get("reasoning_field") != "reasoning_content":
        return None
    return "deepseek"


def effort_table(provider: dict, model: str) -> dict[str, str]:
    """把提供商的 shape 归一到 DSH 三档 thinking level。

    模型不在 provider 声明的 `models` 例外清单里时，只走 fallback
    thinking.type，此时返回 `{}` 让 build_patch 标 `reasoningEfforts: false`。
    """
    spec = provider.get("reasoning") or {}
    patterns = [str(pattern) for pattern in (spec.get("models") or [])]
    if patterns and not any(model.startswith(pattern) for pattern in patterns):
        return {}
    mapping = spec.get("map") or {}
    return {level: str(mapping.get(level) or level) for level in LEVELS}


def default_effort(provider: dict, model: str, depth: str, send_thinking: bool) -> str | None:
    """决定 `agent-default-model.reasoningEffort`；None 表示不发该字段。"""
    if not effort_table(provider, model):
        return None
    if not send_thinking:
        return "off"
    if not depth:
        return "off"
    if depth not in LEVELS:
        print(f"[mms] 未知思考深度: {depth}; 回退为 off", file=sys.stderr)
        return "off"
    return depth
