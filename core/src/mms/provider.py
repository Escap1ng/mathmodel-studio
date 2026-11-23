"""OpenAI 兼容 provider 的最小流式客户端。

只做三件事：把 SSE chunk 归一成正文、对 429/5xx 做有界重试、校验端点地址。
密钥只从调用方按次传入，不落盘、不写日志、不放进异常文本。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from urllib import error, request
from urllib.parse import urlparse

RETRYABLE = (429, 500, 502, 503, 504)
MAX_ATTEMPTS = 3
TIMEOUT_SECONDS = 120
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ProviderError(RuntimeError):
    """provider 调用失败。错误文本里不得出现 API Key。"""


class CancelledError(RuntimeError):
    """用户取消了这次运行。"""


@dataclass
class Completion:
    content: str = ""
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
    on_delta,
    should_stop,
) -> Completion:
    """跑一次流式补全。on_delta("token", text) 会收到正文增量。"""
    url = chat_url(provider.get("base_url") or "")
    payload = {"model": model, "messages": messages, "stream": True}
    completion = Completion()

    resp = _post_stream(payload, api_key, url)
    with resp:
        for raw in resp:
            if should_stop():
                raise CancelledError()
            line = raw.decode("utf-8", "replace").strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
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
                if choice.get("finish_reason"):
                    completion.finish_reason = str(choice["finish_reason"])
    return completion
