"""OpenAI 兼容 provider 的流式客户端。

只做三件事：把 SSE chunk 归一成 content / reasoning / tool_calls；
把历史里的 reasoning 字段剥掉再回放；对 429 与 5xx 做**有界**重试。

密钥只从调用方按次传入，不落盘、不写日志、不放进异常文本。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib import error, request
from urllib.parse import urlparse

RETRYABLE = (429, 500, 502, 503, 504)
MAX_ATTEMPTS = 3
TIMEOUT_SECONDS = 120
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# 回放历史时只允许这些键。reasoning / reasoning_content 一律不带回去：
# 部分 provider 在重放 reasoning 时会报错或重复计费。
HISTORY_KEYS = {"role", "content", "tool_calls", "tool_call_id", "name"}


class ProviderError(RuntimeError):
    """provider 调用失败。错误文本里不得出现 API Key。"""


class CancelledError(RuntimeError):
    """用户取消了这次对话。"""


@dataclass
class Completion:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    finish_reason: str = ""
    usage: dict | None = None


def load_providers() -> list[dict]:
    path = Path(__file__).with_name("providers.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    return list(data.get("providers") or [])


def find_provider(provider_id: str) -> dict | None:
    for item in load_providers():
        if item.get("id") == provider_id:
            return dict(item)
    return None


def validate_base_url(url: str) -> str:
    """公网只许 https；http 只许本机回环，防止把密钥送到明文公网。"""
    value = (url or "").strip().rstrip("/")
    if not value:
        raise ProviderError("自定义端点缺少 base URL")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ProviderError("base URL 只支持 http/https")
    if parsed.username or parsed.password:
        raise ProviderError("base URL 里不要带凭据")
    if not parsed.hostname:
        raise ProviderError("base URL 缺少主机名")
    if parsed.scheme == "http" and parsed.hostname not in LOOPBACK_HOSTS:
        raise ProviderError("公网 base URL 必须是 https；http 只接受 127.0.0.1 / localhost / ::1")
    return value


def strip_reasoning(messages: list[dict]) -> list[dict]:
    return [{k: v for k, v in m.items() if k in HISTORY_KEYS} for m in messages]


def apply_reasoning(payload: dict, provider: dict, model: str, depth: str) -> dict:
    """把界面的「中/高/最大」翻成各服务商认识的思考参数。

    预设里写清楚哪一档映射到什么值；不认识的模型名走 fallback（例如 Kimi K2.x
    只认 thinking.type）。自定义端点由调用方决定是否发送，避免给不支持的端点塞参数。
    """
    spec = provider.get("reasoning") or {}
    if not depth or not spec:
        return payload
    patterns = [str(p) for p in (spec.get("models") or [])]
    if patterns and not any(model.startswith(p) for p in patterns):
        fallback = spec.get("fallback") or {}
        if isinstance(fallback, dict):
            payload.update(fallback)
        return payload
    value = (spec.get("map") or {}).get(depth)
    if value:
        payload[str(spec.get("param") or "reasoning_effort")] = value
    return payload


def chat_url(base_url: str) -> str:
    base = validate_base_url(base_url)
    if base.endswith("/chat/completions"):
        return base
    return base + "/chat/completions"


def _retry_delay(exc: error.HTTPError, attempt: int) -> float:
    raw = (exc.headers.get("Retry-After") or "").strip() if exc.headers else ""
    try:
        return max(0.0, min(10.0, float(raw)))
    except ValueError:
        return 1.0 * (attempt + 1)


def _short(text: str, limit: int = 300) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


def _post_stream(payload: dict, api_key: str, url: str):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": "mathmodel-studio/0.2",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = request.Request(url, data=body, headers=headers, method="POST")

    for attempt in range(MAX_ATTEMPTS):
        try:
            return request.urlopen(req, timeout=TIMEOUT_SECONDS)
        except error.HTTPError as exc:
            detail = ""
            try:
                detail = _short(exc.read(4096).decode("utf-8", "replace"))
            except OSError:
                pass
            if exc.code in RETRYABLE and attempt < MAX_ATTEMPTS - 1:
                time.sleep(_retry_delay(exc, attempt))
                continue
            raise ProviderError(f"provider 返回 HTTP {exc.code}{('：' + detail) if detail else ''}") from exc
        except error.URLError as exc:
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise ProviderError(f"连不上 provider：{exc.reason}") from exc
    raise ProviderError("服务商连续重试后仍失败")


def stream_completion(
    provider: dict,
    api_key: str,
    model: str,
    messages: list[dict],
    tools: list[dict] | None,
    on_delta,
    should_stop,
    depth: str = "",
) -> Completion:
    """跑一次流式补全。on_delta(kind, text) 会收到 token 或 reasoning。"""
    base = provider.get("base_url") or ""
    url = chat_url(base)
    payload: dict = {
        "model": model,
        "messages": strip_reasoning(messages),
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
    apply_reasoning(payload, provider, model, depth)

    completion = Completion()
    tool_slots: dict[int, dict] = {}
    reasoning_field = provider.get("reasoning_field") or "reasoning_content"

    resp = _post_stream(payload, api_key, url)
    with resp:
        for raw in resp:
            if should_stop():
                raise CancelledError()
            line = raw.decode("utf-8", "replace").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if chunk.get("usage"):
                completion.usage = chunk["usage"]
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                text = delta.get("content")
                if text:
                    completion.content += text
                    on_delta("token", text)
                thought = delta.get(reasoning_field) or delta.get("reasoning_content") or delta.get("reasoning")
                if thought:
                    completion.reasoning += thought
                    on_delta("reasoning", thought)
                for call in delta.get("tool_calls") or []:
                    idx = int(call.get("index") or 0)
                    slot = tool_slots.setdefault(
                        idx,
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                    )
                    if call.get("id"):
                        slot["id"] = call["id"]
                    fn = call.get("function") or {}
                    if fn.get("name"):
                        slot["function"]["name"] = fn["name"]
                    args = fn.get("arguments")
                    if args:
                        if isinstance(args, str):
                            slot["function"]["arguments"] += args
                        else:
                            slot["function"]["arguments"] += json.dumps(args, ensure_ascii=False)
                if choice.get("finish_reason"):
                    completion.finish_reason = str(choice["finish_reason"])
    completion.tool_calls = [tool_slots[i] for i in sorted(tool_slots) if tool_slots[i]["function"]["name"]]
    return completion


def _sleep_checked(seconds: float, should_stop) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if should_stop():
            raise CancelledError()
        time.sleep(min(0.02, max(0.0, end - time.monotonic())))


def fake_completion(messages: list[dict], on_delta, should_stop, delay: float = 0.02) -> Completion:
    """仅测试与离线演示：不发任何网络请求。由 MMS_FAKE_PROVIDER=1 显式启用。"""
    if any(m.get("role") == "tool" for m in messages):
        final = (
            "离线演示：共 25 个模板，20 张图表（matplotlib）+ 5 张示意图（JSON 驱动）。"
            "这条回复来自本地假 provider，用来验证流式通道与工具卡；接真实模型后这里会换成模型自己的话。"
        )
        for i in range(0, len(final), 6):
            _sleep_checked(delay, should_stop)
            piece = final[i : i + 6]
            on_delta("token", piece)
        return Completion(content=final, finish_reason="stop")

    for piece in ("先确认一下本机能列出哪些模板。", "这一步只读注册表，不联网。"):
        _sleep_checked(delay, should_stop)
        on_delta("reasoning", piece)
    intro = "我先查一下模板清单。"
    for i in range(0, len(intro), 4):
        _sleep_checked(delay, should_stop)
        on_delta("token", intro[i : i + 4])
    return Completion(
        content=intro,
        finish_reason="tool_calls",
        tool_calls=[
            {
                "id": "call_fake_templates",
                "type": "function",
                "function": {"name": "list_templates", "arguments": "{}"},
            }
        ],
    )
