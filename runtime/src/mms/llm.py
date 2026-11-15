"""编排器的 LLM 注入层：按阶段调一次模型，拿回校验过的 JSON。

约定：
- 每次调用都是独立的 system+user 两条消息，不带历史；system 里带阶段标记，
  离线假 provider 按标记路由脚本化响应。
- Key 只从调用方按次传入，不落盘、不进事件、不进异常文本。
- 解析失败重试一次（把坏输出回喂）；仍失败抛 LlmError，由调用方回退确定性路径。
  状态变更必须发生在拿到合法 JSON 之后（interrupt 幂等硬约束）。
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

from .provider import CancelledError, ProviderError, fake_completion, stream_completion

STAGE_PREFIX = "[mms-stage:"

# 单次调用的输出预算提示：论文正文最长，其余阶段都是结构化短 JSON。
MAX_HINT_CHARS = 60_000


class LlmError(RuntimeError):
    """模型调用或输出解析失败。文本里不得出现 API Key。"""


def stage_prompt(stage: str, instruction: str) -> str:
    return f"{STAGE_PREFIX}{stage}] {instruction}"


def stage_of(messages: list[dict]) -> str:
    """从 system 消息里认出阶段标记；聊天消息没有标记，返回空串。"""
    for message in messages:
        if message.get("role") != "system":
            continue
        content = str(message.get("content") or "")
        match = re.search(re.escape(STAGE_PREFIX) + r"([a-z0-9-]+)\]", content)
        if match:
            return match.group(1)
    return ""


def _strip_fence(text: str) -> str:
    value = text.strip()
    match = re.match(r"^```[a-zA-Z0-9_-]*\s*\n(.*?)\n?```$", value, re.DOTALL)
    if match:
        value = match.group(1).strip()
    return value


def parse_json(text: str) -> dict:
    """剥掉 markdown 围栏后解析 JSON 对象；失败抛 ValueError。"""
    value = _strip_fence(text)
    try:
        data = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"输出不是合法 JSON：{exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("输出必须是 JSON 对象")
    return data


def complete(
    provider: dict | None,
    api_key: str,
    model: str,
    messages: list[dict],
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
    depth: str = "",
) -> str:
    """跑一次补全，返回全文。fake provider 走本地脚本，不发网络请求。"""
    if not provider:
        raise LlmError("没有可用的服务商")
    stop = should_stop or (lambda: False)
    delta = on_delta or (lambda kind, text: None)
    try:
        if provider.get("id") == "fake":
            completion = fake_completion(messages, delta, stop, delay=0.0)
        else:
            completion = stream_completion(
                provider, api_key, model, messages, None, delta, stop, depth=depth
            )
    except CancelledError:
        raise
    except ProviderError as exc:
        raise LlmError(str(exc)) from exc
    return completion.content


def _retry_loop(
    provider: dict | None,
    api_key: str,
    model: str,
    stage: str,
    instruction: str,
    user_content: str,
    extract: Callable[[str], object],
    retry_hint: str,
    should_stop: Callable[[], bool] | None,
    on_delta: Callable[[str, str], None] | None,
    depth: str,
):
    messages = [
        {"role": "system", "content": stage_prompt(stage, instruction)},
        {"role": "user", "content": user_content},
    ]
    last_error = ""
    for attempt in range(2):
        content = complete(provider, api_key, model, messages, should_stop, on_delta, depth)
        try:
            return extract(content)
        except ValueError as exc:
            last_error = str(exc)
            if attempt == 0:
                messages.append({"role": "assistant", "content": content[:MAX_HINT_CHARS]})
                messages.append(
                    {"role": "user", "content": f"上一次输出无法使用：{last_error}。{retry_hint}"}
                )
    raise LlmError(f"阶段 {stage} 的模型输出两次都不可用：{last_error}")


def complete_json(
    provider: dict | None,
    api_key: str,
    model: str,
    stage: str,
    instruction: str,
    user_content: str,
    validate: Callable[[dict], dict],
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
    depth: str = "",
) -> dict:
    """调模型并拿回校验过的 JSON。坏输出回喂重试一次，仍坏抛 LlmError。"""
    return _retry_loop(
        provider, api_key, model, stage, instruction, user_content,
        lambda content: validate(parse_json(content)),
        "请重新输出，只输出一个合法 JSON 对象，不要围栏、不要解释。",
        should_stop, on_delta, depth,
    )


def complete_text(
    provider: dict | None,
    api_key: str,
    model: str,
    stage: str,
    instruction: str,
    user_content: str,
    validate: Callable[[str], str],
    should_stop: Callable[[], bool] | None = None,
    on_delta: Callable[[str, str], None] | None = None,
    depth: str = "",
) -> str:
    """调模型并拿回校验过的文本（如 LaTeX 稿件）。剥围栏后校验，坏输出重试一次。"""

    def extract(content: str) -> str:
        return validate(_strip_fence(content))

    return _retry_loop(
        provider, api_key, model, stage, instruction, user_content,
        extract,
        "请重新输出完整内容，不要围栏、不要解释。",
        should_stop, on_delta, depth,
    )